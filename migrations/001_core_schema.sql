-- Migration 001: Core Schema
-- Papers, sections, chunks, concepts, prerequisites, concept-paper links
-- Requires: pgvector extension and pg_trgm extension

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- Papers
-- ============================================================

CREATE TABLE papers (
  paper_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  arxiv_id TEXT UNIQUE,
  title TEXT NOT NULL,
  authors TEXT[],
  year INTEGER,
  abstract TEXT,
  full_text TEXT,
  categories TEXT[],
  pdf_url TEXT,
  license TEXT,
  ingested_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Paper Sections (parsed from PDF via GROBID)
-- ============================================================

CREATE TABLE paper_sections (
  section_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id UUID NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  section_title TEXT,
  section_number TEXT,
  content TEXT,
  order_index INTEGER,
  embedding vector(768)
);

CREATE INDEX idx_paper_sections_paper_id ON paper_sections(paper_id);
CREATE INDEX idx_paper_sections_embedding ON paper_sections
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

-- ============================================================
-- Paper Chunks (paragraph-level for precise retrieval)
-- ============================================================

CREATE TABLE paper_chunks (
  chunk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id UUID NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  section_id UUID REFERENCES paper_sections(section_id) ON DELETE CASCADE,
  content TEXT,
  embedding vector(768),
  chunk_index INTEGER
);

CREATE INDEX idx_paper_chunks_paper_id ON paper_chunks(paper_id);
CREATE INDEX idx_paper_chunks_section_id ON paper_chunks(section_id);
CREATE INDEX idx_paper_chunks_embedding ON paper_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- ============================================================
-- Concepts (the knowledge graph nodes)
-- ============================================================

CREATE TABLE concepts (
  concept_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  summary TEXT,
  difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 5),
  category TEXT,
  common_misconceptions TEXT[],
  embedding vector(768)
);

CREATE INDEX idx_concepts_name_trgm ON concepts USING GIN (name gin_trgm_ops);
CREATE INDEX idx_concepts_category ON concepts(category);
CREATE INDEX idx_concepts_embedding ON concepts
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

-- ============================================================
-- Concept Prerequisites (edges in the knowledge graph)
-- ============================================================

CREATE TABLE concept_prerequisites (
  concept_id UUID NOT NULL REFERENCES concepts(concept_id) ON DELETE CASCADE,
  prerequisite_id UUID NOT NULL REFERENCES concepts(concept_id) ON DELETE CASCADE,
  strength TEXT NOT NULL CHECK (strength IN ('required', 'helpful', 'related')),
  PRIMARY KEY (concept_id, prerequisite_id),
  CHECK (concept_id != prerequisite_id)
);

CREATE INDEX idx_concept_prereqs_prerequisite ON concept_prerequisites(prerequisite_id);

-- ============================================================
-- Concept-Paper Links
-- ============================================================

CREATE TABLE concept_papers (
  concept_id UUID NOT NULL REFERENCES concepts(concept_id) ON DELETE CASCADE,
  paper_id UUID NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  relevance TEXT NOT NULL CHECK (relevance IN ('canonical', 'alternative', 'extension')),
  recommended_sections TEXT[],
  PRIMARY KEY (concept_id, paper_id)
);

CREATE INDEX idx_concept_papers_paper ON concept_papers(paper_id);

-- ============================================================
-- Sync metadata (tracks ingestion state per dataset)
-- ============================================================

CREATE TABLE sync_metadata (
  dataset_id TEXT PRIMARY KEY,
  last_sync_at TIMESTAMPTZ,
  last_record_count INTEGER DEFAULT 0
);
