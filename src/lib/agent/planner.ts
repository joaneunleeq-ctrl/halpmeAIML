// Agent Planner
// PRD §5.1: "On each user turn, a single LLM planning call classifies the
// teaching goal and identifies the target concept."
// PRD §5.2: "Call budget is determined by concept mastery, checked against
// the concept graph BEFORE the planning call. This routing is fully
// deterministic — no LLM involvement in the routing decision."
//
// Two-step process:
//   1. Deterministic pre-check: identify concept, look up mastery, set routing
//   2. Planning LLM call: classify teaching goal

import { query } from "@/lib/db";
import { getLLMProvider } from "@/lib/providers/llm-provider";
import { identifyConceptFromQuery } from "@/lib/retrieval/search";
import type {
  PlanningOutput,
  RoutingContext,
  TeachingGoal,
  ConversationMessage,
} from "./types";

// ============================================================
// Main planner function
// ============================================================

export async function plan(
  userMessage: string,
  userId: string,
  sessionId: string,
  conversationHistory: ConversationMessage[]
): Promise<{ planningOutput: PlanningOutput; routingContext: RoutingContext }> {
  // -------------------------------------------------------
  // Step 1: Deterministic pre-check (NO LLM call)
  // -------------------------------------------------------

  const routingContext = await buildRoutingContext(
    userMessage,
    userId,
    sessionId,
    conversationHistory
  );

  // -------------------------------------------------------
  // Step 2: Planning LLM call (classify teaching goal)
  // -------------------------------------------------------

  const planningOutput = await classifyTeachingGoal(
    userMessage,
    routingContext,
    conversationHistory
  );

  // Override concept from planning if the deterministic check found one
  // and the LLM didn't identify a different one
  if (routingContext.concept_name && !planningOutput.concept) {
    planningOutput.concept = routingContext.concept_name;
  }

  return { planningOutput, routingContext };
}

// ============================================================
// Step 1: Deterministic routing (no LLM)
// ============================================================

async function buildRoutingContext(
  userMessage: string,
  userId: string,
  sessionId: string,
  conversationHistory: ConversationMessage[]
): Promise<RoutingContext> {
  // Identify the concept from the user's message via embedding similarity
  let conceptId: string | null = null;
  let conceptName: string | null = null;
  let masteryPercentage = 0;

  const identified = await identifyConceptFromQuery(userMessage);

  if (identified && identified.similarity > 0.25) {
    conceptId = identified.concept_id;
    conceptName = identified.name;

    // Look up the user's mastery for this concept
    const masteryResult = await query(
      `SELECT mastery_percentage
       FROM user_concept_progress
       WHERE user_id = $1 AND concept_id = $2`,
      [userId, conceptId]
    );

    if (masteryResult.rows.length > 0) {
      masteryPercentage = (masteryResult.rows[0] as { mastery_percentage: number })
        .mastery_percentage;
    }
  }

  // Determine routing decisions per PRD §5.2 and §5.3
  const callBudget: 3 | 7 = masteryPercentage >= 100 ? 3 : 7;

  const explanationLevel: "fourteen" | "grad_student" =
    masteryPercentage < 50 ? "fourteen" : "grad_student";

  const toolsAvailable = masteryPercentage >= 30;

  return {
    user_id: userId,
    session_id: sessionId,
    concept_id: conceptId,
    concept_name: conceptName,
    mastery_percentage: masteryPercentage,
    call_budget: callBudget,
    explanation_level: explanationLevel,
    tools_available: toolsAvailable,
    conversation_history: conversationHistory,
  };
}

// ============================================================
// Step 2: Planning LLM call (classify teaching goal)
// ============================================================

const PLANNING_SYSTEM_PROMPT = `You are a teaching planner for an AI tutoring system. Your ONLY job is to classify what the student needs.

Given the student's message and conversation context, output ONLY valid JSON with no other text:

{
  "teaching_goal": "<one of the goals below>",
  "concept": "<the ML/AI concept name, or null if not applicable>",
  "context_notes": "<brief notes about what the student needs>"
}

Valid teaching_goal values:
- "explain_concept_with_prerequisites" — student wants to learn a new concept or deepen understanding
- "answer_direct_question" — student asks a quick factual question about something they already know
- "explain_paper_section" — student wants to read through a specific paper
- "review_concept" — student is reviewing a previously studied concept
- "evaluate_exercise_response" — student is submitting an answer to an exercise
- "generate_study_plan" — student asks what to learn next
- "socratic_check" — student is responding to an understanding check question
- "end_session" — student wants to end the session

Rules:
- If the student mentions a paper title, arXiv ID, or URL, use "explain_paper_section"
- If the student says "what should I learn" or "what's next", use "generate_study_plan"
- If the message looks like an answer to a previously asked question or exercise, use "evaluate_exercise_response" or "socratic_check" based on context
- If the student says goodbye, "end session", "I'm done", use "end_session"
- When in doubt, use "explain_concept_with_prerequisites"
- Output ONLY the JSON object, nothing else`;

async function classifyTeachingGoal(
  userMessage: string,
  routingContext: RoutingContext,
  conversationHistory: ConversationMessage[]
): Promise<PlanningOutput> {
  const llm = getLLMProvider();

  // Build a brief conversation context for the planner
  const recentHistory = conversationHistory
    .slice(-4) // last 4 messages for context
    .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const contextInfo = routingContext.concept_name
    ? `\nLikely concept: ${routingContext.concept_name} (mastery: ${routingContext.mastery_percentage}%)`
    : "";

  const userPrompt =
    (recentHistory ? `Recent conversation:\n${recentHistory}\n\n` : "") +
    `Current student message: ${userMessage}` +
    contextInfo;

  try {
    const response = await llm.complete({
      systemPrompt: PLANNING_SYSTEM_PROMPT,
      userMessage: userPrompt,
      temperature: 0.1, // low temperature for classification
      maxTokens: 256,
      responseFormat: "json",
    });

    return parsePlanningResponse(response);
  } catch (err) {
    console.error("Planning LLM call failed:", err);
    return fallbackPlanningOutput(userMessage, routingContext);
  }
}

// ============================================================
// Parse and validate the planning LLM response
// ============================================================

function parsePlanningResponse(response: string): PlanningOutput {
  // Strip markdown fences if present
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  }

  // Find JSON object
  const objStart = cleaned.indexOf("{");
  const objEnd = cleaned.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1) {
    cleaned = cleaned.slice(objStart, objEnd + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);

    const goal = validateTeachingGoal(parsed.teaching_goal);

    return {
      teaching_goal: goal,
      concept: parsed.concept || null,
      context_notes: String(parsed.context_notes || ""),
    };
  } catch (err) {
    console.warn("Failed to parse planning response, using fallback:", err);
    console.warn("Raw response:", response.slice(0, 300));

    return {
      teaching_goal: "answer_direct_question",
      concept: null,
      context_notes: "Planning parse failed — defaulting to direct answer",
    };
  }
}

const VALID_GOALS: TeachingGoal[] = [
  "explain_concept_with_prerequisites",
  "answer_direct_question",
  "explain_paper_section",
  "review_concept",
  "evaluate_exercise_response",
  "generate_study_plan",
  "socratic_check",
  "end_session",
];

function validateTeachingGoal(goal: unknown): TeachingGoal {
  if (typeof goal === "string" && VALID_GOALS.includes(goal as TeachingGoal)) {
    return goal as TeachingGoal;
  }

  // Try fuzzy matching common LLM variations
  const goalStr = String(goal).toLowerCase().replace(/[_\s-]+/g, "");

  if (goalStr.includes("explain") && goalStr.includes("concept")) {
    return "explain_concept_with_prerequisites";
  }
  if (goalStr.includes("direct") || goalStr.includes("quick") || goalStr.includes("answer")) {
    return "answer_direct_question";
  }
  if (goalStr.includes("paper") || goalStr.includes("section")) {
    return "explain_paper_section";
  }
  if (goalStr.includes("review")) {
    return "review_concept";
  }
  if (goalStr.includes("exercise") || goalStr.includes("evaluat")) {
    return "evaluate_exercise_response";
  }
  if (goalStr.includes("study") || goalStr.includes("plan") || goalStr.includes("next")) {
    return "generate_study_plan";
  }
  if (goalStr.includes("socratic") || goalStr.includes("check")) {
    return "socratic_check";
  }
  if (goalStr.includes("end") || goalStr.includes("session") || goalStr.includes("bye")) {
    return "end_session";
  }

  return "answer_direct_question"; // safe default
}

// ============================================================
// Fallback when the LLM call itself fails
// ============================================================

function fallbackPlanningOutput(
  userMessage: string,
  routingContext: RoutingContext
): PlanningOutput {
  const lower = userMessage.toLowerCase();

  // Simple keyword-based classification as fallback
  if (lower.includes("what should i learn") || lower.includes("what's next") || lower.includes("study plan")) {
    return {
      teaching_goal: "generate_study_plan",
      concept: null,
      context_notes: "Fallback: keyword match on study plan request",
    };
  }

  if (lower.includes("end session") || lower.includes("goodbye") || lower.includes("i'm done")) {
    return {
      teaching_goal: "end_session",
      concept: null,
      context_notes: "Fallback: keyword match on session end",
    };
  }

  if (lower.includes("arxiv") || lower.includes("paper") || lower.includes("1706.")) {
    return {
      teaching_goal: "explain_paper_section",
      concept: routingContext.concept_name,
      context_notes: "Fallback: keyword match on paper reference",
    };
  }

  // Check if this looks like an exercise answer (short, follows an exercise)
  const lastTutorMsg = routingContext.conversation_history
    .filter((m) => m.role === "tutor")
    .at(-1);

  if (lastTutorMsg?.metadata?.exercise_id) {
    return {
      teaching_goal: "evaluate_exercise_response",
      concept: routingContext.concept_name,
      context_notes: "Fallback: previous message had an exercise",
    };
  }

  // Default: if we identified a concept and mastery is low, teach it
  if (routingContext.concept_name && routingContext.mastery_percentage < 100) {
    return {
      teaching_goal: "explain_concept_with_prerequisites",
      concept: routingContext.concept_name,
      context_notes: "Fallback: concept identified, defaulting to teach",
    };
  }

  return {
    teaching_goal: "answer_direct_question",
    concept: routingContext.concept_name,
    context_notes: "Fallback: no specific pattern matched",
  };
}
