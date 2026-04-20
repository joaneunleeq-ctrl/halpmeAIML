// Agent Architecture — Shared Types
// PRD §5.1: Design C goal-oriented planning with hardcoded playbooks.

// ============================================================
// Planning Output (JSON returned by the planning LLM call)
// ============================================================

export type TeachingGoal =
  | "explain_concept_with_prerequisites"
  | "answer_direct_question"
  | "explain_paper_section"
  | "review_concept"
  | "evaluate_exercise_response"
  | "generate_study_plan"
  | "socratic_check"
  | "end_session";

export interface PlanningOutput {
  teaching_goal: TeachingGoal;
  concept: string | null;
  context_notes: string;
}

// ============================================================
// Routing Context (deterministic decisions made BEFORE the LLM call)
// ============================================================

export interface RoutingContext {
  user_id: string;
  session_id: string;
  concept_id: string | null;
  concept_name: string | null;
  mastery_percentage: number;
  call_budget: 3 | 7;
  explanation_level: "fourteen" | "grad_student";
  tools_available: boolean; // matplotlib + jupyter active at 30%+
  conversation_history: ConversationMessage[];
}

// ============================================================
// Conversation Messages
// ============================================================

export interface ConversationMessage {
  role: "user" | "tutor";
  content: string;
  timestamp: string;
  metadata?: {
    playbook?: string;
    concept?: string;
    mastery_change?: { before: number; after: number };
    exercise_id?: string;
  };
}

// ============================================================
// Playbook Result (returned by each playbook, sent to frontend)
// PRD §4.6.11: Unified chat response structure
// ============================================================

export interface Citation {
  paper_id: string;
  paper_title: string;
  authors: string[];
  year: number;
  section_number: string;
  section_title: string;
  arxiv_id: string | null;
  url: string;
}

export interface Visualization {
  image_base64: string;
  code: string;
}

export interface CodeSnippet {
  code: string;
  language: string;
}

export interface Exercise {
  id: string;
  prompt: string;
  difficulty: number;
  concept_id: string;
  correct_answer?: string; // hidden from frontend, used for evaluation
}

export interface MasteryUpdate {
  concept_name: string;
  before: number;
  after: number;
  threshold_crossed: "30" | "50" | "100" | null;
}

export interface ExerciseEvaluation {
  correct_elements: string[];
  misconceptions: string[];
  gaps: string[];
  mastery_change: number;
}

export interface PlaybookResult {
  message: string;
  citations: Citation[];
  visualization: Visualization | null;
  code_snippet: CodeSnippet | null;
  socratic_check: { question: string } | null;
  exercise: Exercise | null;
  mastery_update: MasteryUpdate | null;
  evaluation: ExerciseEvaluation | null;
  classified_intent: TeachingGoal;
  concept_name: string | null;
}

// ============================================================
// Tool Results (returned by individual tool executions)
// ============================================================

export interface ToolResult {
  tool: string;
  success: boolean;
  data: unknown;
  error?: string;
}

// ============================================================
// Playbook Function Signature
// ============================================================

export type PlaybookFunction = (
  routingContext: RoutingContext,
  planningOutput: PlanningOutput,
  userMessage: string
) => Promise<PlaybookResult>;
