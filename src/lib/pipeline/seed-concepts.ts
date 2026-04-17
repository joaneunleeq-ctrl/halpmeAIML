// Concept Graph Seeding Pipeline
// PRD §9.1: "50 concepts at MVP launch, LLM-generated and then manually curated."
//
// Two modes:
//   --generate : use LLM to generate concepts, then save to data/concept_graph.json
//   --load <file> : load concepts from a curated JSON file
//
// After LLM generation, the founding team should review data/concept_graph.json,
// fix prerequisites and paper links, then reload with --load.

import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";

// ============================================================
// Types
// ============================================================

export interface ConceptDefinition {
  name: string;
  summary: string;
  difficulty: number;
  category: string;
  prerequisites: Array<{
    name: string;
    strength: "required" | "helpful" | "related";
  }>;
  canonical_papers: Array<{
    arxiv_id: string;
    relevance: "canonical" | "alternative" | "extension";
    sections: string[];
  }>;
  common_misconceptions: string[];
}

export interface SeedResult {
  concepts_inserted: number;
  prerequisites_linked: number;
  papers_linked: number;
  embeddings_generated: number;
  errors: string[];
}

// ============================================================
// Category-based LLM generation prompts
// Generating all 50 at once is unreliable with small models,
// so we generate per category in smaller batches.
// ============================================================

const CATEGORY_PROMPTS: Array<{ category: string; count: number; guidance: string }> = [
  {
    category: "statistical_foundations",
    count: 5,
    guidance:
      "Generate 5 concepts covering statistical foundations that ML builds on: " +
      "bias-variance tradeoff, maximum likelihood estimation, regularization (L1/L2), " +
      "cross-validation, and Bayesian inference basics. " +
      "These should have NO prerequisites from other categories since they are foundational.",
  },
  {
    category: "classical_ml",
    count: 8,
    guidance:
      "Generate 8 concepts covering classical ML algorithms and ideas: " +
      "linear regression, logistic regression, decision trees, support vector machines, " +
      "k-nearest neighbors, principal component analysis (PCA), gradient descent, " +
      "and ensemble methods (bagging/boosting). " +
      "Prerequisites should reference statistical_foundations concepts where appropriate.",
  },
  {
    category: "deep_learning_fundamentals",
    count: 10,
    guidance:
      "Generate 10 concepts covering deep learning fundamentals: " +
      "neural network basics (perceptron/MLP), activation functions, backpropagation, " +
      "loss functions, batch normalization, dropout, weight initialization, " +
      "optimizers (SGD/Adam), learning rate scheduling, and overfitting/underfitting in deep nets. " +
      "Prerequisites should reference statistical_foundations and classical_ml concepts.",
  },
  {
    category: "architectures",
    count: 10,
    guidance:
      "Generate 10 concepts covering neural network architectures: " +
      "convolutional neural networks (CNNs), recurrent neural networks (RNNs), LSTMs, " +
      "attention mechanism, transformer architecture, encoder-decoder models, " +
      "generative adversarial networks (GANs), variational autoencoders (VAEs), " +
      "residual connections (ResNets), and diffusion models. " +
      "Prerequisites should reference deep_learning_fundamentals concepts.",
  },
  {
    category: "training_paradigms",
    count: 5,
    guidance:
      "Generate 5 concepts covering training paradigms: " +
      "supervised learning, unsupervised learning, self-supervised learning / pre-training, " +
      "transfer learning / fine-tuning, and few-shot / in-context learning. " +
      "Prerequisites should reference deep_learning_fundamentals and architectures.",
  },
  {
    category: "reinforcement_learning",
    count: 5,
    guidance:
      "Generate 5 concepts covering reinforcement learning: " +
      "Markov decision processes (MDPs), Q-learning / deep Q-networks (DQN), " +
      "policy gradient methods, proximal policy optimization (PPO), " +
      "and reward modeling / RLHF. " +
      "Prerequisites should reference deep_learning_fundamentals concepts.",
  },
  {
    category: "llm_specific",
    count: 5,
    guidance:
      "Generate 5 concepts specific to large language models: " +
      "tokenization and embeddings (word2vec/BPE), masked language modeling (BERT-style), " +
      "autoregressive language modeling (GPT-style), scaling laws, " +
      "and prompt engineering / chain-of-thought. " +
      "Prerequisites should reference architectures (especially transformers) and training_paradigms.",
  },
  {
    category: "ai_safety",
    count: 2,
    guidance:
      "Generate 2 concepts covering AI safety and alignment: " +
      "AI alignment problem (the core challenge of making AI systems do what we want), " +
      "and interpretability / mechanistic interpretability (understanding what neural networks learn internally). " +
      "Prerequisites should reference llm_specific and deep_learning_fundamentals.",
  },
];

// Map of known papers in the corpus to help the LLM link concepts
const CORPUS_PAPERS = [
  { arxiv_id: "1706.03762", short: "Attention Is All You Need" },
  { arxiv_id: "1209.5145", short: "AlexNet" },
  { arxiv_id: "1512.03385", short: "ResNet" },
  { arxiv_id: "1406.2661", short: "GANs" },
  { arxiv_id: "1412.6980", short: "Adam" },
  { arxiv_id: "1502.03167", short: "Batch Normalization" },
  { arxiv_id: null, short: "Dropout (Srivastava 2014)" },
  { arxiv_id: "1301.3781", short: "Word2Vec" },
  { arxiv_id: "1810.04805", short: "BERT" },
  { arxiv_id: "2005.14165", short: "GPT-3" },
  { arxiv_id: "2006.11239", short: "DDPM (Diffusion)" },
  { arxiv_id: "1707.06347", short: "PPO" },
  { arxiv_id: "1312.5602", short: "DQN Atari" },
  { arxiv_id: null, short: "Backpropagation (Rumelhart 1986)" },
  { arxiv_id: null, short: "LSTM (Hochreiter 1997)" },
];

// ============================================================
// LLM Generation
// ============================================================

export async function generateConceptsWithLLM(
  llmComplete: (params: {
    systemPrompt: string;
    userMessage: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: "text" | "json";
  }) => Promise<string>
): Promise<ConceptDefinition[]> {
  const allConcepts: ConceptDefinition[] = [];

  const paperList = CORPUS_PAPERS.map(
    (p) => `  - ${p.short}${p.arxiv_id ? ` (arxiv: ${p.arxiv_id})` : ""}`
  ).join("\n");

  for (const cat of CATEGORY_PROMPTS) {
    console.log(`  Generating ${cat.count} concepts for: ${cat.category}...`);

    const systemPrompt =
      "You are an expert ML curriculum designer building a concept graph for engineering students " +
      "who know statistics and linear algebra but are learning ML/AI.\n\n" +
      "Output ONLY a valid JSON array of concept objects. No markdown, no explanation, no code fences.\n\n" +
      "Each concept object must have exactly these fields:\n" +
      '  "name": string (canonical name),\n' +
      '  "summary": string (one paragraph explaining the concept),\n' +
      '  "difficulty": number (1=easy to 5=very hard),\n' +
      '  "category": string (the category provided),\n' +
      '  "prerequisites": array of { "name": string, "strength": "required"|"helpful"|"related" },\n' +
      '  "canonical_papers": array of { "arxiv_id": string or null, "relevance": "canonical"|"alternative"|"extension", "sections": string[] },\n' +
      '  "common_misconceptions": array of strings\n\n' +
      "Available papers in the corpus (use these arxiv_ids for canonical_papers):\n" +
      paperList +
      "\n\nOnly link papers that are genuinely relevant to the concept. " +
      "If no paper in the corpus covers this concept, use an empty array for canonical_papers.";

    const userMessage =
      `Category: "${cat.category}"\n\n${cat.guidance}\n\n` +
      `Previously generated concept names (use these for prerequisites if relevant):\n` +
      allConcepts.map((c) => `  - ${c.name} (${c.category})`).join("\n") +
      `\n\nGenerate exactly ${cat.count} concepts. Output only the JSON array.`;

    try {
      const response = await llmComplete({
        systemPrompt,
        userMessage,
        temperature: 0.3,
        maxTokens: 4096,
        responseFormat: "json",
      });

      const concepts = parseJsonResponse(response, cat.category);

      if (concepts.length === 0) {
        console.warn(`    WARNING: No concepts parsed for ${cat.category}`);
      } else {
        console.log(`    Got ${concepts.length} concepts`);
        allConcepts.push(...concepts);
      }
    } catch (err) {
      console.error(`    ERROR generating ${cat.category}: ${err}`);
    }

    // Small delay between LLM calls
    await new Promise((r) => setTimeout(r, 500));
  }

  return allConcepts;
}

function parseJsonResponse(response: string, category: string): ConceptDefinition[] {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  }

  // Try to find a JSON array
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd !== -1) {
    cleaned = cleaned.slice(arrayStart, arrayEnd + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed) ? parsed : [parsed];

    return arr.map((c: Record<string, unknown>) => ({
      name: String(c.name || "Unknown"),
      summary: String(c.summary || ""),
      difficulty: Math.min(5, Math.max(1, Number(c.difficulty) || 3)),
      category: String(c.category || category),
      prerequisites: Array.isArray(c.prerequisites)
        ? (c.prerequisites as Array<Record<string, unknown>>).map((p) => ({
            name: String(p.name || ""),
            strength: validateStrength(String(p.strength || "helpful")),
          }))
        : [],
      canonical_papers: Array.isArray(c.canonical_papers)
        ? (c.canonical_papers as Array<Record<string, unknown>>).map((p) => ({
            arxiv_id: p.arxiv_id ? String(p.arxiv_id) : "",
            relevance: validateRelevance(String(p.relevance || "canonical")),
            sections: Array.isArray(p.sections) ? (p.sections as string[]).map(String) : [],
          }))
        : [],
      common_misconceptions: Array.isArray(c.common_misconceptions)
        ? (c.common_misconceptions as string[]).map(String)
        : [],
    }));
  } catch (err) {
    console.error(`    JSON parse error: ${err}`);
    console.error(`    Raw response (first 500 chars): ${cleaned.slice(0, 500)}`);
    return [];
  }
}

function validateStrength(s: string): "required" | "helpful" | "related" {
  if (s === "required" || s === "helpful" || s === "related") return s;
  return "helpful";
}

function validateRelevance(r: string): "canonical" | "alternative" | "extension" {
  if (r === "canonical" || r === "alternative" || r === "extension") return r;
  return "canonical";
}

// ============================================================
// Load from JSON file
// ============================================================

export function loadConceptsFromFile(filepath: string): ConceptDefinition[] {
  const raw = fs.readFileSync(filepath, "utf-8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Expected a JSON array of concept definitions");
  }

  console.log(`  Loaded ${parsed.length} concepts from ${filepath}`);
  return parsed as ConceptDefinition[];
}

// ============================================================
// Save to JSON file (for manual review)
// ============================================================

export function saveConceptsToFile(concepts: ConceptDefinition[], filepath: string): void {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filepath, JSON.stringify(concepts, null, 2));
  console.log(`  Saved ${concepts.length} concepts to ${filepath}`);
}

// ============================================================
// Database Insertion
// ============================================================

export async function insertConcepts(
  pool: Pool,
  concepts: ConceptDefinition[],
  embeddingProvider: {
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    dimensions: number;
  } | null
): Promise<SeedResult> {
  const result: SeedResult = {
    concepts_inserted: 0,
    prerequisites_linked: 0,
    papers_linked: 0,
    embeddings_generated: 0,
    errors: [],
  };

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Phase 1: Insert all concepts
    console.log("\n  Phase 1: Inserting concepts...");
    const conceptIdMap = new Map<string, string>(); // name -> concept_id

    for (const concept of concepts) {
      // Check if already exists
      const existing = await client.query(
        "SELECT concept_id FROM concepts WHERE name = $1",
        [concept.name]
      );

      if (existing.rows.length > 0) {
        conceptIdMap.set(concept.name.toLowerCase(), existing.rows[0].concept_id);
        continue;
      }

      const insertResult = await client.query(
        `INSERT INTO concepts (name, summary, difficulty, category, common_misconceptions)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING concept_id`,
        [concept.name, concept.summary, concept.difficulty, concept.category, concept.common_misconceptions]
      );

      conceptIdMap.set(concept.name.toLowerCase(), insertResult.rows[0].concept_id);
      result.concepts_inserted++;
    }

    console.log(`    ${result.concepts_inserted} concepts inserted`);

    // Phase 2: Link prerequisites
    console.log("  Phase 2: Linking prerequisites...");
    for (const concept of concepts) {
      const conceptId = conceptIdMap.get(concept.name.toLowerCase());
      if (!conceptId) continue;

      for (const prereq of concept.prerequisites) {
        const prereqId = conceptIdMap.get(prereq.name.toLowerCase());
        if (!prereqId) {
          // Try fuzzy match
          const fuzzyResult = await client.query(
            `SELECT concept_id FROM concepts
             WHERE similarity(lower(name), lower($1)) > 0.3
             ORDER BY similarity(lower(name), lower($1)) DESC
             LIMIT 1`,
            [prereq.name]
          );

          if (fuzzyResult.rows.length > 0) {
            try {
              await client.query(
                `INSERT INTO concept_prerequisites (concept_id, prerequisite_id, strength)
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [conceptId, fuzzyResult.rows[0].concept_id, prereq.strength]
              );
              result.prerequisites_linked++;
            } catch {
              // Skip circular or duplicate
            }
          } else {
            result.errors.push(
              `Prerequisite not found: "${prereq.name}" for concept "${concept.name}"`
            );
          }
          continue;
        }

        if (prereqId === conceptId) continue; // skip self-reference

        try {
          await client.query(
            `INSERT INTO concept_prerequisites (concept_id, prerequisite_id, strength)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [conceptId, prereqId, prereq.strength]
          );
          result.prerequisites_linked++;
        } catch {
          // Skip duplicates
        }
      }
    }

    console.log(`    ${result.prerequisites_linked} prerequisites linked`);

    // Phase 3: Link papers
    console.log("  Phase 3: Linking canonical papers...");
    for (const concept of concepts) {
      const conceptId = conceptIdMap.get(concept.name.toLowerCase());
      if (!conceptId) continue;

      for (const paper of concept.canonical_papers) {
        if (!paper.arxiv_id) continue;

        const paperResult = await client.query(
          "SELECT paper_id FROM papers WHERE arxiv_id = $1",
          [paper.arxiv_id]
        );

        if (paperResult.rows.length === 0) {
          // Paper not in our corpus — skip silently
          continue;
        }

        try {
          await client.query(
            `INSERT INTO concept_papers (concept_id, paper_id, relevance, recommended_sections)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [conceptId, paperResult.rows[0].paper_id, paper.relevance, paper.sections]
          );
          result.papers_linked++;
        } catch {
          // Skip duplicates
        }
      }
    }

    console.log(`    ${result.papers_linked} paper links created`);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Phase 4: Generate embeddings (outside transaction for resilience)
  if (embeddingProvider) {
    console.log("  Phase 4: Generating embeddings...");
    const BATCH_SIZE = 16;
    const toEmbed = await pool.query<{ concept_id: string; name: string; summary: string }>(
      "SELECT concept_id, name, summary FROM concepts WHERE embedding IS NULL"
    );

    if (toEmbed.rows.length === 0) {
      console.log("    All concepts already have embeddings.");
    } else {
      for (let i = 0; i < toEmbed.rows.length; i += BATCH_SIZE) {
        const batch = toEmbed.rows.slice(i, i + BATCH_SIZE);
        const texts = batch.map((r) => `${r.name}: ${r.summary}`);

        try {
          const embeddings = await embeddingProvider.embedBatch(texts);

          for (let j = 0; j < batch.length; j++) {
            const vectorStr = `[${embeddings[j].join(",")}]`;
            await pool.query(
              "UPDATE concepts SET embedding = $1::vector WHERE concept_id = $2",
              [vectorStr, batch[j].concept_id]
            );
            result.embeddings_generated++;
          }
        } catch (err) {
          result.errors.push(`Embedding error: ${err}`);
        }
      }

      console.log(`    ${result.embeddings_generated} embeddings generated`);
    }
  }

  return result;
}
