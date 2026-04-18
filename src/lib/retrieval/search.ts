// Retrieval Layer — Hybrid Search
// PRD §4.4: "Hybrid search combining semantic similarity with concept-graph filtering.
// Retrieval is staged: section-level to identify papers, paragraph-level for precise chunks."
//
// All functions use the provider abstraction — no direct DB or vector store calls
// outside this module.

import { query } from "@/lib/db";
import { getEmbeddingProvider } from "@/lib/providers/embedding-provider";

// ============================================================
// Types
// ============================================================

export interface PaperChunkResult {
  chunk_id: string;
  paper_id: string;
  paper_title: string;
  section_id: string;
  section_title: string;
  section_number: string;
  chunk_content: string;
  section_content: string;
  similarity_score: number;
  arxiv_id: string | null;
}

export interface PaperSectionResult {
  section_id: string;
  paper_id: string;
  paper_title: string;
  section_title: string;
  section_number: string;
  content: string;
  similarity_score: number;
  arxiv_id: string | null;
}

export interface ConceptData {
  concept_id: string;
  name: string;
  summary: string;
  difficulty: number;
  category: string;
  common_misconceptions: string[];
  prerequisites: Array<{
    concept_id: string;
    name: string;
    summary: string;
    strength: string;
  }>;
  linked_papers: Array<{
    paper_id: string;
    title: string;
    arxiv_id: string | null;
    relevance: string;
    recommended_sections: string[];
  }>;
}

export interface PrerequisiteNode {
  concept_id: string;
  name: string;
  summary: string;
  difficulty: number;
  depth: number;
  strength: string;
}

export interface LearnerState {
  profile: {
    user_id: string;
    display_name: string | null;
    background: string | null;
    learning_goals: string | null;
    preferred_style: string;
    skill_level: string;
  };
  concept_mastery: Array<{
    concept_name: string;
    mastery_percentage: number;
    status: string;
    last_struggled_subtopic: string | null;
    interaction_count: number;
  }>;
  mistakes: Array<{
    concept_name: string;
    misconception_pattern: string;
    frequency: number;
    resolved: boolean;
  }>;
}

// ============================================================
// 1. searchPapers — chunk-level semantic search
// ============================================================

export async function searchPapers(
  queryText: string,
  k: number = 5,
  conceptFilter?: string
): Promise<PaperChunkResult[]> {
  const embeddingProvider = getEmbeddingProvider();
  const queryEmbedding = await embeddingProvider.embed(queryText);
  const vectorStr = `[${queryEmbedding.join(",")}]`;

  // Get paper_ids linked to the concept (if filter provided)
  let conceptPaperIds: string[] = [];
  if (conceptFilter) {
    const conceptResult = await query(
      `SELECT cp.paper_id
       FROM concept_papers cp
       JOIN concepts c ON c.concept_id = cp.concept_id
       WHERE similarity(lower(c.name), lower($1)) > 0.3
       ORDER BY similarity(lower(c.name), lower($1)) DESC`,
      [conceptFilter]
    );
    conceptPaperIds = conceptResult.rows.map(
      (r) => (r as { paper_id: string }).paper_id
    );
  }

  // Search for top k*2 chunks (we'll deduplicate down to k)
  const searchLimit = k * 3;

  const result = await query(
    `SELECT
       c.chunk_id,
       c.paper_id,
       c.section_id,
       c.content AS chunk_content,
       p.title AS paper_title,
       p.arxiv_id,
       s.section_title,
       s.section_number,
       s.content AS section_content,
       1 - (c.embedding <=> $1::vector) AS similarity_score
     FROM paper_chunks c
     JOIN papers p ON p.paper_id = c.paper_id
     JOIN paper_sections s ON s.section_id = c.section_id
     WHERE c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [vectorStr, searchLimit]
  );

  let chunks = result.rows as Array<{
    chunk_id: string;
    paper_id: string;
    section_id: string;
    chunk_content: string;
    paper_title: string;
    arxiv_id: string | null;
    section_title: string;
    section_number: string;
    section_content: string;
    similarity_score: number;
  }>;

  // Boost scores for concept-linked papers
  if (conceptPaperIds.length > 0) {
    chunks = chunks.map((chunk) => ({
      ...chunk,
      similarity_score: conceptPaperIds.includes(chunk.paper_id)
        ? chunk.similarity_score * 1.2 // 20% boost
        : chunk.similarity_score,
    }));
    // Re-sort after boosting
    chunks.sort((a, b) => b.similarity_score - a.similarity_score);
  }

  // Deduplicate: max 2 chunks per paper
  const paperCounts = new Map<string, number>();
  const deduped: typeof chunks = [];

  for (const chunk of chunks) {
    const count = paperCounts.get(chunk.paper_id) || 0;
    if (count >= 2) continue;
    paperCounts.set(chunk.paper_id, count + 1);
    deduped.push(chunk);
    if (deduped.length >= k) break;
  }

  return deduped.map((c) => ({
    chunk_id: c.chunk_id,
    paper_id: c.paper_id,
    paper_title: c.paper_title,
    section_id: c.section_id,
    section_title: c.section_title,
    section_number: c.section_number,
    chunk_content: c.chunk_content,
    section_content: c.section_content,
    similarity_score: c.similarity_score,
    arxiv_id: c.arxiv_id,
  }));
}

// ============================================================
// 2. searchSections — section-level semantic search
// ============================================================

export async function searchSections(
  queryText: string,
  k: number = 3
): Promise<PaperSectionResult[]> {
  const embeddingProvider = getEmbeddingProvider();
  const queryEmbedding = await embeddingProvider.embed(queryText);
  const vectorStr = `[${queryEmbedding.join(",")}]`;

  const result = await query(
    `SELECT
       s.section_id,
       s.paper_id,
       s.section_title,
       s.section_number,
       s.content,
       p.title AS paper_title,
       p.arxiv_id,
       1 - (s.embedding <=> $1::vector) AS similarity_score
     FROM paper_sections s
     JOIN papers p ON p.paper_id = s.paper_id
     WHERE s.embedding IS NOT NULL
     ORDER BY s.embedding <=> $1::vector
     LIMIT $2`,
    [vectorStr, k]
  );

  return result.rows as PaperSectionResult[];
}

// ============================================================
// 3. getConcept — full concept data with prerequisites and papers
// ============================================================

export async function getConcept(
  conceptName: string
): Promise<ConceptData | null> {
  // Try exact match first, then fuzzy match
  let conceptResult = await query(
    `SELECT concept_id, name, summary, difficulty, category, common_misconceptions
     FROM concepts
     WHERE lower(name) = lower($1)`,
    [conceptName]
  );

  if (conceptResult.rows.length === 0) {
    // Fuzzy match via trigram
    conceptResult = await query(
      `SELECT concept_id, name, summary, difficulty, category, common_misconceptions
       FROM concepts
       WHERE similarity(lower(name), lower($1)) > 0.25
       ORDER BY similarity(lower(name), lower($1)) DESC
       LIMIT 1`,
      [conceptName]
    );
  }

  if (conceptResult.rows.length === 0) return null;

  const concept = conceptResult.rows[0] as {
    concept_id: string;
    name: string;
    summary: string;
    difficulty: number;
    category: string;
    common_misconceptions: string[];
  };

  // Get direct prerequisites with their summaries
  const prereqResult = await query(
    `SELECT c.concept_id, c.name, c.summary, cp.strength
     FROM concept_prerequisites cp
     JOIN concepts c ON c.concept_id = cp.prerequisite_id
     WHERE cp.concept_id = $1
     ORDER BY cp.strength, c.difficulty`,
    [concept.concept_id]
  );

  // Get linked papers
  const papersResult = await query(
    `SELECT p.paper_id, p.title, p.arxiv_id, cp.relevance, cp.recommended_sections
     FROM concept_papers cp
     JOIN papers p ON p.paper_id = cp.paper_id
     WHERE cp.concept_id = $1
     ORDER BY cp.relevance`,
    [concept.concept_id]
  );

  return {
    concept_id: concept.concept_id,
    name: concept.name,
    summary: concept.summary,
    difficulty: concept.difficulty,
    category: concept.category,
    common_misconceptions: concept.common_misconceptions || [],
    prerequisites: prereqResult.rows as ConceptData["prerequisites"],
    linked_papers: papersResult.rows as ConceptData["linked_papers"],
  };
}

// ============================================================
// 4. getPrerequisites — recursive prerequisite tree (up to 3 levels)
// ============================================================

export async function getPrerequisites(
  conceptId: string,
  maxDepth: number = 3
): Promise<PrerequisiteNode[]> {
  // Use a recursive CTE to traverse the prerequisite graph
  const result = await query(
    `WITH RECURSIVE prereq_tree AS (
       -- Base case: direct prerequisites
       SELECT
         c.concept_id,
         c.name,
         c.summary,
         c.difficulty,
         cp.strength,
         1 AS depth
       FROM concept_prerequisites cp
       JOIN concepts c ON c.concept_id = cp.prerequisite_id
       WHERE cp.concept_id = $1

       UNION ALL

       -- Recursive case: prerequisites of prerequisites
       SELECT
         c.concept_id,
         c.name,
         c.summary,
         c.difficulty,
         cp.strength,
         pt.depth + 1 AS depth
       FROM prereq_tree pt
       JOIN concept_prerequisites cp ON cp.concept_id = pt.concept_id
       JOIN concepts c ON c.concept_id = cp.prerequisite_id
       WHERE pt.depth < $2
     )
     SELECT DISTINCT ON (concept_id) concept_id, name, summary, difficulty, depth, strength
     FROM prereq_tree
     ORDER BY concept_id, depth ASC`,
    [conceptId, maxDepth]
  );

  // Sort by depth descending (deepest prerequisites first)
  const nodes = result.rows as PrerequisiteNode[];
  nodes.sort((a, b) => b.depth - a.depth);
  return nodes;
}

// ============================================================
// 5. getLearnerState — compressed memory for LLM context
// ============================================================

export async function getLearnerState(
  userId: string,
  conceptId?: string
): Promise<LearnerState> {
  // Layer 1: Student Profile
  const profileResult = await query(
    `SELECT user_id, display_name, background, learning_goals,
            preferred_style, skill_level
     FROM users
     WHERE user_id = $1`,
    [userId]
  );

  if (profileResult.rows.length === 0) {
    throw new Error(`User not found: ${userId}`);
  }

  const profile = profileResult.rows[0] as LearnerState["profile"];

  // Layer 2: Concept Mastery
  let masteryQuery: string;
  let masteryParams: unknown[];

  if (conceptId) {
    // Get mastery for this concept and its prerequisites
    masteryQuery = `
      SELECT c.name AS concept_name, ucp.mastery_percentage, ucp.status,
             ucp.last_struggled_subtopic, ucp.interaction_count
      FROM user_concept_progress ucp
      JOIN concepts c ON c.concept_id = ucp.concept_id
      WHERE ucp.user_id = $1
        AND (ucp.concept_id = $2
             OR ucp.concept_id IN (
               SELECT prerequisite_id FROM concept_prerequisites WHERE concept_id = $2
             ))
      ORDER BY ucp.mastery_percentage DESC`;
    masteryParams = [userId, conceptId];
  } else {
    // Get all concept progress
    masteryQuery = `
      SELECT c.name AS concept_name, ucp.mastery_percentage, ucp.status,
             ucp.last_struggled_subtopic, ucp.interaction_count
      FROM user_concept_progress ucp
      JOIN concepts c ON c.concept_id = ucp.concept_id
      WHERE ucp.user_id = $1
      ORDER BY ucp.mastery_percentage DESC`;
    masteryParams = [userId];
  }

  const masteryResult = await query(masteryQuery, masteryParams);

  // Layer 3: Mistake History
  let mistakeQuery: string;
  let mistakeParams: unknown[];

  if (conceptId) {
    // Get mistakes for this concept and its prerequisites
    mistakeQuery = `
      SELECT c.name AS concept_name, umh.misconception_pattern,
             umh.frequency, umh.resolved
      FROM user_mistake_history umh
      JOIN concepts c ON c.concept_id = umh.concept_id
      WHERE umh.user_id = $1
        AND umh.resolved = FALSE
        AND (umh.concept_id = $2
             OR umh.concept_id IN (
               SELECT prerequisite_id FROM concept_prerequisites WHERE concept_id = $2
             ))
      ORDER BY umh.frequency DESC
      LIMIT 10`;
    mistakeParams = [userId, conceptId];
  } else {
    // Get all unresolved mistakes
    mistakeQuery = `
      SELECT c.name AS concept_name, umh.misconception_pattern,
             umh.frequency, umh.resolved
      FROM user_mistake_history umh
      JOIN concepts c ON c.concept_id = umh.concept_id
      WHERE umh.user_id = $1 AND umh.resolved = FALSE
      ORDER BY umh.frequency DESC
      LIMIT 20`;
    mistakeParams = [userId];
  }

  const mistakeResult = await query(mistakeQuery, mistakeParams);

  return {
    profile,
    concept_mastery: masteryResult.rows as LearnerState["concept_mastery"],
    mistakes: mistakeResult.rows as LearnerState["mistakes"],
  };
}

// ============================================================
// Helper: identify concept from a free-text query
// ============================================================

export async function identifyConceptFromQuery(
  queryText: string
): Promise<{ concept_id: string; name: string; similarity: number } | null> {
  const embeddingProvider = getEmbeddingProvider();
  const queryEmbedding = await embeddingProvider.embed(queryText);
  const vectorStr = `[${queryEmbedding.join(",")}]`;

  const result = await query(
    `SELECT concept_id, name,
            1 - (embedding <=> $1::vector) AS similarity
     FROM concepts
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT 1`,
    [vectorStr]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as {
    concept_id: string;
    name: string;
    similarity: number;
  };

  // Only return if similarity is above a reasonable threshold
  if (row.similarity < 0.2) return null;

  return row;
}
