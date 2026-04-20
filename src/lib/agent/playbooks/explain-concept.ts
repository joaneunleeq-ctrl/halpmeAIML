// Playbook: explain_concept_with_prerequisites (Prompt 10)
// PRD §5.3: 7-call path for new/partial mastery, 3-call path for mastered concepts.
//
// Call budget:
//   7-call: full context build → main explanation call → socratic check call
//   3-call: quick context build → brief explanation call (no socratic check)

import { query } from "@/lib/db";
import { getLLMProvider } from "@/lib/providers/llm-provider";
import { buildTutorContext, buildQuickContext } from "@/lib/retrieval/context-builder";
import { registerPlaybook } from "../router";
import type {
  RoutingContext,
  PlanningOutput,
  PlaybookResult,
  Citation,
  MasteryUpdate,
} from "../types";

// ============================================================
// System prompts by explanation level
// ============================================================

const SYSTEM_PROMPT_FOURTEEN = `You are a patient, enthusiastic ML/AI tutor. Your student is curious but new to this field.

Explanation style:
- Explain like talking to a very smart 14-year-old — clear, concrete, relatable
- Lead with an analogy before introducing formal terms
- When you use jargon, immediately define it in plain language
- Build the explanation on what the student already knows (shown in STUDENT STATE)
- Flag prerequisite gaps directly: "To understand X, you first need Y"
- Keep paragraphs short. Use bullet points for multi-step ideas.
- If the student has known misconceptions (from STUDENT STATE), address them directly

End with a one-sentence "**Key Takeaway:**" summary.

Format: Markdown. Cite sources as [Author et al., Year, §Section] where relevant.`;

const SYSTEM_PROMPT_GRAD = `You are a graduate-level ML/AI tutor. Your student has solid foundations.

Explanation style:
- Be precise and technical — assume ML/stats fluency
- Connect concepts to their theoretical underpinnings
- Reference relevant results from the literature (use the RETRIEVED PAPER EXCERPTS)
- Highlight the intuition behind mathematical choices
- Point out implementation pitfalls and non-obvious edge cases
- If the student has known misconceptions (from STUDENT STATE), correct them directly

Cite sources as [Author et al., Year, §Section]. Format: Markdown.`;

// ============================================================
// Main playbook
// ============================================================

async function explainConceptWithPrerequisites(
  routingContext: RoutingContext,
  planningOutput: PlanningOutput,
  userMessage: string
): Promise<PlaybookResult> {
  const conceptName =
    planningOutput.concept || routingContext.concept_name || "this concept";
  const { user_id, call_budget, explanation_level, concept_id } = routingContext;
  const llm = getLLMProvider();

  // Build context — 3-call path gets a lighter version
  const tutorContext =
    call_budget === 3
      ? await buildQuickContext(user_id, conceptName, userMessage)
      : await buildTutorContext(user_id, conceptName, userMessage);

  const systemPrompt =
    explanation_level === "fourteen" ? SYSTEM_PROMPT_FOURTEEN : SYSTEM_PROMPT_GRAD;

  // Main explanation call
  const explanation = await llm.complete({
    systemPrompt: `${systemPrompt}\n\n${tutorContext.formatted}`,
    userMessage,
    temperature: 0.7,
    maxTokens: call_budget === 3 ? 600 : 1200,
  });

  // Socratic check call — 7-call path only
  let socraticCheck: { question: string } | null = null;
  if (call_budget === 7) {
    try {
      const raw = await llm.complete({
        systemPrompt:
          `Generate ONE Socratic follow-up question to check the student's understanding of the explanation below.\n\n` +
          `Explanation:\n${explanation}\n\n` +
          `The question must require the student to demonstrate understanding, not just recall. ` +
          `Output only the question itself — no preamble, no label.`,
        userMessage: `Concept: ${conceptName}. Student mastery before this explanation: ${routingContext.mastery_percentage}%.`,
        temperature: 0.8,
        maxTokens: 100,
      });
      const question = raw.trim();
      if (question) socraticCheck = { question };
    } catch (err) {
      console.warn("Socratic check generation failed:", err);
    }
  }

  // Mastery update: +5% for engaging with an explanation
  const resolvedConceptId = concept_id ?? tutorContext.conceptId;
  const masteryUpdate = await updateMastery(
    user_id,
    resolvedConceptId,
    conceptName,
    routingContext.mastery_percentage,
    5
  );

  // Build citations from retrieved paper chunks
  const citations: Citation[] = tutorContext.raw.paperChunks.map((chunk) => ({
    paper_id: chunk.paper_id,
    paper_title: chunk.paper_title,
    authors: chunk.authors,
    year: chunk.year ?? 0,
    section_number: chunk.section_number,
    section_title: chunk.section_title,
    arxiv_id: chunk.arxiv_id,
    url: chunk.arxiv_id ? `https://arxiv.org/abs/${chunk.arxiv_id}` : "",
  }));

  return {
    message: explanation,
    citations,
    visualization: null,
    code_snippet: null,
    socratic_check: socraticCheck,
    exercise: null,
    mastery_update: masteryUpdate,
    evaluation: null,
    classified_intent: "explain_concept_with_prerequisites",
    concept_name: conceptName,
  };
}

// ============================================================
// Mastery update helper
// ============================================================

async function updateMastery(
  userId: string,
  conceptId: string | null,
  conceptName: string,
  currentMastery: number,
  bump: number
): Promise<MasteryUpdate | null> {
  if (!conceptId) return null;

  const newMastery = Math.min(100, currentMastery + bump);
  if (newMastery === currentMastery) return null;

  const newStatus = newMastery >= 100 ? "mastered" : "learning";

  try {
    await query(
      `INSERT INTO user_concept_progress
         (user_id, concept_id, mastery_percentage, status, last_interaction_at, interaction_count)
       VALUES ($1, $2, $3, $4, NOW(), 1)
       ON CONFLICT (user_id, concept_id) DO UPDATE SET
         mastery_percentage = EXCLUDED.mastery_percentage,
         status             = EXCLUDED.status,
         last_interaction_at = NOW(),
         interaction_count  = user_concept_progress.interaction_count + 1`,
      [userId, conceptId, newMastery, newStatus]
    );
  } catch (err) {
    console.error("Mastery update failed:", err);
    return null;
  }

  const thresholds: Array<"30" | "50" | "100"> = ["30", "50", "100"];
  const threshold_crossed =
    thresholds.find(
      (t) => currentMastery < Number(t) && newMastery >= Number(t)
    ) ?? null;

  return { concept_name: conceptName, before: currentMastery, after: newMastery, threshold_crossed };
}

// ============================================================
// Register
// ============================================================

registerPlaybook("explain_concept_with_prerequisites", explainConceptWithPrerequisites);
