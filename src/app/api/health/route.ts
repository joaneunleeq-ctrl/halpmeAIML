import { NextResponse } from "next/server";
import { healthCheck as dbHealthCheck } from "@/lib/db";
import { getLLMProvider, getEmbeddingProvider, getVectorStore } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  // Database
  try {
    checks.database = { ok: await dbHealthCheck() };
  } catch (e) {
    checks.database = { ok: false, error: String(e) };
  }

  // LLM Provider
  try {
    const llm = getLLMProvider();
    checks.llm = { ok: await llm.healthCheck() };
  } catch (e) {
    checks.llm = { ok: false, error: String(e) };
  }

  // Embedding Provider
  try {
    const embedding = getEmbeddingProvider();
    checks.embedding = { ok: await embedding.healthCheck() };
  } catch (e) {
    checks.embedding = { ok: false, error: String(e) };
  }

  // Vector Store
  try {
    const vectorStore = getVectorStore();
    checks.vectorStore = { ok: await vectorStore.healthCheck() };
  } catch (e) {
    checks.vectorStore = { ok: false, error: String(e) };
  }

  const allHealthy = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    {
      status: allHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      providers: {
        llm: process.env.LLM_PROVIDER || "ollama",
        embedding: process.env.EMBEDDING_PROVIDER || "local",
        vectorStore: process.env.VECTOR_STORE || "chroma",
      },
      checks,
    },
    { status: allHealthy ? 200 : 503 }
  );
}
