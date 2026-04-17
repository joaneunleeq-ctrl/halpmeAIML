// Provider Abstraction — Barrel Export
// PRD §4.2: All downstream components use these interfaces exclusively.
// No direct Ollama/OpenAI/Chroma calls anywhere else in the codebase.

export { getLLMProvider } from "./llm-provider";
export type { LLMProvider, LLMCompletionParams } from "./llm-provider";

export { getEmbeddingProvider } from "./embedding-provider";
export type { EmbeddingProvider } from "./embedding-provider";

export { getVectorStore } from "./vector-store";
export type { VectorStore, VectorResult } from "./vector-store";
