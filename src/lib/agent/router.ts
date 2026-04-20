// Agent Router
// PRD §5.1: "Deterministic application code reads the goal type and executes
// the corresponding hardcoded playbook."
//
// This is a simple switch/case — no intelligence, just dispatch.
// Each playbook is implemented in Prompts 10–17.

import type {
  PlanningOutput,
  RoutingContext,
  PlaybookResult,
  PlaybookFunction,
} from "./types";

// ============================================================
// Playbook registry
// Each playbook is registered here as it's implemented.
// Stubs return a helpful message until the real playbook is built.
// ============================================================

const playbooks: Record<string, PlaybookFunction | null> = {
  explain_concept_with_prerequisites: null, // Prompt 10
  answer_direct_question: null,             // Prompt 11
  explain_paper_section: null,              // Prompt 12
  review_concept: null,                     // Prompt 13
  evaluate_exercise_response: null,         // Prompt 14
  generate_study_plan: null,                // Prompt 15
  socratic_check: null,                     // Prompt 16
  end_session: null,                        // Prompt 17
};

// ============================================================
// Register a playbook implementation
// Called by each playbook module when it's imported
// ============================================================

export function registerPlaybook(
  goal: string,
  fn: PlaybookFunction
): void {
  if (!(goal in playbooks)) {
    console.warn(`Unknown playbook goal: ${goal}`);
  }
  playbooks[goal] = fn;
}

// ============================================================
// Route to the appropriate playbook
// ============================================================

export async function route(
  planningOutput: PlanningOutput,
  routingContext: RoutingContext,
  userMessage: string
): Promise<PlaybookResult> {
  const { teaching_goal } = planningOutput;

  const playbook = playbooks[teaching_goal];

  if (playbook) {
    return playbook(routingContext, planningOutput, userMessage);
  }

  // Playbook not yet implemented — return a stub response
  return createStubResponse(planningOutput, routingContext);
}

// ============================================================
// Stub response for unimplemented playbooks
// ============================================================

function createStubResponse(
  planningOutput: PlanningOutput,
  routingContext: RoutingContext
): PlaybookResult {
  const concept = planningOutput.concept || routingContext.concept_name || "this topic";
  const goal = planningOutput.teaching_goal.replace(/_/g, " ");

  return {
    message:
      `I understand you'd like me to **${goal}**` +
      (planningOutput.concept ? ` about **${planningOutput.concept}**` : "") +
      `. This capability is being built and will be available soon.\n\n` +
      `In the meantime, here's what I know:\n` +
      `- Your mastery on ${concept}: ${routingContext.mastery_percentage}%\n` +
      `- Explanation level: ${routingContext.explanation_level}\n` +
      `- Call budget: ${routingContext.call_budget}-call path\n` +
      `- Tools available: ${routingContext.tools_available ? "yes (matplotlib + jupyter)" : "not yet (need 30% mastery)"}`,
    citations: [],
    visualization: null,
    code_snippet: null,
    socratic_check: null,
    exercise: null,
    mastery_update: null,
    evaluation: null,
    classified_intent: planningOutput.teaching_goal,
    concept_name: planningOutput.concept,
  };
}

// ============================================================
// Check which playbooks are implemented
// ============================================================

export function getPlaybookStatus(): Record<string, boolean> {
  const status: Record<string, boolean> = {};
  for (const [goal, fn] of Object.entries(playbooks)) {
    status[goal] = fn !== null;
  }
  return status;
}
