// Agent Architecture — Barrel Export

// Side-effect imports: register playbooks with the router
import "./playbooks/explain-concept";

export { plan } from "./planner";
export { route, registerPlaybook, getPlaybookStatus } from "./router";
export type {
  TeachingGoal,
  PlanningOutput,
  RoutingContext,
  ConversationMessage,
  PlaybookResult,
  PlaybookFunction,
  Citation,
  Visualization,
  CodeSnippet,
  Exercise,
  MasteryUpdate,
  ExerciseEvaluation,
  ToolResult,
} from "./types";
