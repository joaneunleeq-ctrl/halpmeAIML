// Context Builder
// PRD §6.3: "Total injected context: approximately 30-50 lines of structured
// state data plus retrieved paper content. This keeps total context under
// 4,000 tokens of state."
//
// Assembles the complete context injected into the tutor's system prompt
// from learner state, concept data, and retrieved paper excerpts.

import {
  searchPapers,
  getConcept,
  getPrerequisites,
  getLearnerState,
  type PaperChunkResult,
  type ConceptData,
  type PrerequisiteNode,
  type LearnerState,
} from "./search";

// ============================================================
// Types
// ============================================================

export interface TutorContext {
  raw: {
    learnerState: LearnerState;
    concept: ConceptData | null;
    prerequisites: PrerequisiteNode[];
    paperChunks: PaperChunkResult[];
  };
  formatted: string;
  conceptId: string | null;
  masteryPercentage: number;
  explanationLevel: "fourteen" | "grad_student";
  toolsAvailable: boolean;
  callBudget: 3 | 7;
}

// ============================================================
// Main context builder
// ============================================================

export async function buildTutorContext(
  userId: string,
  conceptName: string,
  queryText: string
): Promise<TutorContext> {
  // Fetch all data in parallel where possible
  const [concept, learnerState] = await Promise.all([
    getConcept(conceptName),
    getLearnerState(userId, undefined).catch(() => null),
  ]);

  const conceptId = concept?.concept_id || null;

  // Get prerequisites if we have a concept
  const prerequisites = conceptId
    ? await getPrerequisites(conceptId, 3)
    : [];

  // Get focused learner state for this concept if available
  const focusedState = conceptId
    ? await getLearnerState(userId, conceptId).catch(() => learnerState)
    : learnerState;

  // Search papers with concept filter
  const paperChunks = await searchPapers(queryText, 5, conceptName);

  // Determine mastery and routing
  const mastery = getMasteryForConcept(focusedState, conceptName);
  const explanationLevel: "fourteen" | "grad_student" =
    mastery < 50 ? "fourteen" : "grad_student";
  const toolsAvailable = mastery >= 30;
  const callBudget: 3 | 7 = mastery >= 100 ? 3 : 7;

  // Format the context string
  const formatted = formatContext(
    focusedState,
    concept,
    prerequisites,
    paperChunks,
    mastery
  );

  return {
    raw: {
      learnerState: focusedState || {
        profile: {
          user_id: userId,
          display_name: null,
          background: null,
          learning_goals: null,
          preferred_style: "visual-first",
          skill_level: "beginner",
        },
        concept_mastery: [],
        mistakes: [],
      },
      concept,
      prerequisites,
      paperChunks,
    },
    formatted,
    conceptId,
    masteryPercentage: mastery,
    explanationLevel,
    toolsAvailable,
    callBudget,
  };
}

// ============================================================
// Extract mastery percentage for a concept from learner state
// ============================================================

function getMasteryForConcept(
  state: LearnerState | null,
  conceptName: string
): number {
  if (!state) return 0;

  const entry = state.concept_mastery.find(
    (cm) => cm.concept_name.toLowerCase() === conceptName.toLowerCase()
  );

  return entry?.mastery_percentage || 0;
}

// ============================================================
// Format context for LLM injection
// ============================================================

function formatContext(
  state: LearnerState | null,
  concept: ConceptData | null,
  prerequisites: PrerequisiteNode[],
  paperChunks: PaperChunkResult[],
  mastery: number
): string {
  const sections: string[] = [];

  // === STUDENT STATE ===
  sections.push(formatStudentState(state, mastery));

  // === CONCEPT DATA ===
  if (concept) {
    sections.push(formatConceptData(concept));
  }

  // === PREREQUISITES ===
  if (prerequisites.length > 0 || (concept && concept.prerequisites.length > 0)) {
    sections.push(formatPrerequisites(concept, prerequisites, state));
  }

  // === RETRIEVED PAPER EXCERPTS ===
  if (paperChunks.length > 0) {
    sections.push(formatPaperExcerpts(paperChunks));
  }

  return sections.join("\n\n");
}

function formatStudentState(
  state: LearnerState | null,
  mastery: number
): string {
  const lines: string[] = ["=== STUDENT STATE ==="];

  if (!state) {
    lines.push("New student — no prior interaction data.");
    return lines.join("\n");
  }

  const p = state.profile;
  lines.push(
    `Student: ${p.display_name || "Unknown"} | Level: ${p.skill_level} | Style: ${p.preferred_style}`
  );

  if (p.background) {
    lines.push(`Background: ${p.background}`);
  }
  if (p.learning_goals) {
    lines.push(`Goals: ${p.learning_goals}`);
  }

  lines.push(`Current concept mastery: ${mastery}%`);

  // Add relevant concept mastery entries (max 10 to keep context small)
  if (state.concept_mastery.length > 0) {
    const relevant = state.concept_mastery.slice(0, 10);
    lines.push("Related concept mastery:");
    for (const cm of relevant) {
      const subtopic = cm.last_struggled_subtopic
        ? ` (struggled with: ${cm.last_struggled_subtopic})`
        : "";
      lines.push(
        `  - ${cm.concept_name}: ${cm.mastery_percentage}% [${cm.status}]${subtopic}`
      );
    }
  }

  // Add mistake history (max 5)
  if (state.mistakes.length > 0) {
    lines.push("Known misconceptions (address proactively):");
    for (const m of state.mistakes.slice(0, 5)) {
      lines.push(
        `  - [${m.concept_name}] ${m.misconception_pattern} (seen ${m.frequency}x)`
      );
    }
  }

  return lines.join("\n");
}

function formatConceptData(concept: ConceptData): string {
  const lines: string[] = [
    `=== CONCEPT: ${concept.name} ===`,
    `Difficulty: ${concept.difficulty}/5 | Category: ${concept.category}`,
    `Summary: ${concept.summary}`,
  ];

  if (concept.common_misconceptions.length > 0) {
    lines.push("Common misconceptions to watch for:");
    for (const m of concept.common_misconceptions) {
      lines.push(`  - ${m}`);
    }
  }

  if (concept.linked_papers.length > 0) {
    lines.push("Canonical papers:");
    for (const p of concept.linked_papers) {
      const sections = p.recommended_sections?.length
        ? ` (sections: ${p.recommended_sections.join(", ")})`
        : "";
      lines.push(`  - ${p.title} [${p.relevance}]${sections}`);
    }
  }

  return lines.join("\n");
}

function formatPrerequisites(
  concept: ConceptData | null,
  deepPrereqs: PrerequisiteNode[],
  state: LearnerState | null
): string {
  const lines: string[] = ["=== PREREQUISITES ==="];

  // Direct prerequisites with mastery status
  if (concept && concept.prerequisites.length > 0) {
    lines.push("Direct prerequisites:");
    for (const p of concept.prerequisites) {
      const mastery = state?.concept_mastery.find(
        (cm) => cm.concept_name.toLowerCase() === p.name.toLowerCase()
      );
      const masteryStr = mastery
        ? `${mastery.mastery_percentage}%`
        : "not started";
      lines.push(
        `  - ${p.name} [${p.strength}]: ${masteryStr} — ${truncate(p.summary, 100)}`
      );
    }
  }

  // Deeper prerequisites (only show unmastered ones to save context)
  const unmasteredDeep = deepPrereqs.filter((p) => {
    if (!state) return true;
    const m = state.concept_mastery.find(
      (cm) => cm.concept_name.toLowerCase() === p.name.toLowerCase()
    );
    return !m || m.mastery_percentage < 50;
  });

  if (unmasteredDeep.length > 0) {
    lines.push("Gaps in prerequisite chain (student may need these explained):");
    for (const p of unmasteredDeep.slice(0, 5)) {
      lines.push(
        `  - ${p.name} (depth ${p.depth}): ${truncate(p.summary, 80)}`
      );
    }
  }

  return lines.join("\n");
}

function formatPaperExcerpts(chunks: PaperChunkResult[]): string {
  const lines: string[] = ["=== RETRIEVED PAPER EXCERPTS ==="];
  lines.push(
    "Use these to ground your explanations. Cite as [Author et al., Year, \u00A7Section]."
  );

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const arxivRef = c.arxiv_id ? ` (arxiv: ${c.arxiv_id})` : "";
    lines.push("");
    lines.push(
      `[${i + 1}] ${c.paper_title}${arxivRef} — \u00A7${c.section_number} ${c.section_title}`
    );
    lines.push(
      `Score: ${c.similarity_score.toFixed(3)}`
    );
    // Truncate chunk content to ~800 chars to stay within context budget
    lines.push(truncate(c.chunk_content, 800));
  }

  return lines.join("\n");
}

// ============================================================
// Utility
// ============================================================

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

// ============================================================
// Quick context for simple queries (3-call path)
// ============================================================

export async function buildQuickContext(
  userId: string,
  conceptName: string,
  queryText: string
): Promise<TutorContext> {
  // Lighter version for mastered concepts — fewer paper chunks, no deep prereqs
  const [concept, learnerState] = await Promise.all([
    getConcept(conceptName),
    getLearnerState(userId, undefined).catch(() => null),
  ]);

  const conceptId = concept?.concept_id || null;
  const paperChunks = await searchPapers(queryText, 3, conceptName);

  const mastery = getMasteryForConcept(learnerState, conceptName);

  const sections: string[] = [];
  sections.push("=== STUDENT STATE ===");
  sections.push(`Mastered concept. Mastery: ${mastery}%. Give a concise, graduate-level answer.`);

  if (concept) {
    sections.push(`\n=== CONCEPT: ${concept.name} ===`);
    sections.push(concept.summary);
  }

  if (paperChunks.length > 0) {
    sections.push("\n=== RETRIEVED PAPER EXCERPTS ===");
    for (let i = 0; i < paperChunks.length; i++) {
      const c = paperChunks[i];
      sections.push(
        `\n[${i + 1}] ${c.paper_title} — \u00A7${c.section_number} ${c.section_title}`
      );
      sections.push(truncate(c.chunk_content, 600));
    }
  }

  return {
    raw: {
      learnerState: learnerState || {
        profile: {
          user_id: userId,
          display_name: null,
          background: null,
          learning_goals: null,
          preferred_style: "visual-first",
          skill_level: "beginner",
        },
        concept_mastery: [],
        mistakes: [],
      },
      concept,
      prerequisites: [],
      paperChunks,
    },
    formatted: sections.join("\n"),
    conceptId,
    masteryPercentage: mastery,
    explanationLevel: "grad_student",
    toolsAvailable: true,
    callBudget: 3,
  };
}
