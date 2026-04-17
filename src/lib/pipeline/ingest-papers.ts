// Paper Ingestion Pipeline
// PRD §4.3: Papers are ingested as PDFs, parsed using GROBID for structured
// section extraction, chunked at section and paragraph granularity.
//
// Two parsing paths:
//   1. GROBID (preferred): structured TEI XML with section boundaries + equations
//   2. pdf-parse fallback: raw text split on section heading patterns

import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";

// ============================================================
// 15 Canonical Papers (PRD §9.2)
// ============================================================

export interface PaperDefinition {
  arxiv_id: string | null; // null for papers not on arXiv
  title: string;
  authors: string[];
  year: number;
  pdf_url: string; // direct PDF download URL
  categories: string[];
  primary_concepts: string[];
}

export const CANONICAL_PAPERS: PaperDefinition[] = [
  {
    arxiv_id: "1706.03762",
    title: "Attention Is All You Need",
    authors: ["Vaswani", "Shazeer", "Parmar", "Uszkoreit", "Jones", "Gomez", "Kaiser", "Polosukhin"],
    year: 2017,
    pdf_url: "https://arxiv.org/pdf/1706.03762.pdf",
    categories: ["cs.CL", "cs.LG"],
    primary_concepts: ["Transformers", "Attention mechanism", "Multi-head attention", "Positional encoding"],
  },
  {
    arxiv_id: "1209.5145",
    title: "ImageNet Classification with Deep Convolutional Neural Networks",
    authors: ["Krizhevsky", "Sutskever", "Hinton"],
    year: 2012,
    pdf_url: "https://arxiv.org/pdf/1209.5145.pdf",
    categories: ["cs.CV", "cs.LG"],
    primary_concepts: ["CNNs", "ReLU", "Dropout", "GPU training"],
  },
  {
    arxiv_id: "1512.03385",
    title: "Deep Residual Learning for Image Recognition",
    authors: ["He", "Zhang", "Ren", "Sun"],
    year: 2015,
    pdf_url: "https://arxiv.org/pdf/1512.03385.pdf",
    categories: ["cs.CV"],
    primary_concepts: ["Residual connections", "Skip connections", "Deep network training"],
  },
  {
    arxiv_id: "1406.2661",
    title: "Generative Adversarial Nets",
    authors: ["Goodfellow", "Pouget-Abadie", "Mirza", "Xu", "Warde-Farley", "Ozair", "Courville", "Bengio"],
    year: 2014,
    pdf_url: "https://arxiv.org/pdf/1406.2661.pdf",
    categories: ["stat.ML", "cs.LG"],
    primary_concepts: ["GANs", "Adversarial training", "Generative models"],
  },
  {
    arxiv_id: "1412.6980",
    title: "Adam: A Method for Stochastic Optimization",
    authors: ["Kingma", "Ba"],
    year: 2014,
    pdf_url: "https://arxiv.org/pdf/1412.6980.pdf",
    categories: ["cs.LG"],
    primary_concepts: ["Adam optimizer", "Adaptive learning rates", "Momentum"],
  },
  {
    arxiv_id: "1502.03167",
    title: "Batch Normalization: Accelerating Deep Network Training by Reducing Internal Covariate Shift",
    authors: ["Ioffe", "Szegedy"],
    year: 2015,
    pdf_url: "https://arxiv.org/pdf/1502.03167.pdf",
    categories: ["cs.LG"],
    primary_concepts: ["Batch normalization", "Internal covariate shift", "Training stability"],
  },
  {
    // Dropout paper — published in JMLR 2014, not originally on arXiv
    // Using the commonly-referenced version
    arxiv_id: null,
    title: "Dropout: A Simple Way to Prevent Neural Networks from Overfitting",
    authors: ["Srivastava", "Hinton", "Krizhevsky", "Sutskever", "Salakhutdinov"],
    year: 2014,
    pdf_url: "https://jmlr.org/papers/volume15/srivastava14a/srivastava14a.pdf",
    categories: ["cs.LG"],
    primary_concepts: ["Regularization", "Ensemble approximation", "Overfitting"],
  },
  {
    arxiv_id: "1301.3781",
    title: "Efficient Estimation of Word Representations in Vector Space",
    authors: ["Mikolov", "Chen", "Corrado", "Dean"],
    year: 2013,
    pdf_url: "https://arxiv.org/pdf/1301.3781.pdf",
    categories: ["cs.CL"],
    primary_concepts: ["Word2Vec", "Skip-gram", "CBOW", "Word embeddings"],
  },
  {
    arxiv_id: "1810.04805",
    title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
    authors: ["Devlin", "Chang", "Lee", "Toutanova"],
    year: 2018,
    pdf_url: "https://arxiv.org/pdf/1810.04805.pdf",
    categories: ["cs.CL"],
    primary_concepts: ["Pre-training", "Fine-tuning", "Masked language modeling", "Bidirectional context"],
  },
  {
    arxiv_id: "2005.14165",
    title: "Language Models are Few-Shot Learners",
    authors: ["Brown", "Mann", "Ryder", "Subbiah", "Kaplan", "Dhariwal", "Neelakantan", "Shyam", "Sastry", "Askell"],
    year: 2020,
    pdf_url: "https://arxiv.org/pdf/2005.14165.pdf",
    categories: ["cs.CL"],
    primary_concepts: ["GPT-3", "In-context learning", "Scaling laws", "Few-shot learning"],
  },
  {
    arxiv_id: "2006.11239",
    title: "Denoising Diffusion Probabilistic Models",
    authors: ["Ho", "Jain", "Abbeel"],
    year: 2020,
    pdf_url: "https://arxiv.org/pdf/2006.11239.pdf",
    categories: ["cs.LG", "stat.ML"],
    primary_concepts: ["Diffusion models", "Denoising", "Forward/reverse process"],
  },
  {
    arxiv_id: "1707.06347",
    title: "Proximal Policy Optimization Algorithms",
    authors: ["Schulman", "Wolski", "Dhariwal", "Radford", "Klimov"],
    year: 2017,
    pdf_url: "https://arxiv.org/pdf/1707.06347.pdf",
    categories: ["cs.LG"],
    primary_concepts: ["PPO", "Policy gradients", "Clipped objectives", "Reinforcement learning"],
  },
  {
    arxiv_id: "1312.5602",
    title: "Playing Atari with Deep Reinforcement Learning",
    authors: ["Mnih", "Kavukcuoglu", "Silver", "Graves", "Antonoglou", "Wierstra", "Riedmiller"],
    year: 2013,
    pdf_url: "https://arxiv.org/pdf/1312.5602.pdf",
    categories: ["cs.LG"],
    primary_concepts: ["DQN", "Deep Q-learning", "Experience replay"],
  },
  {
    // Backpropagation — published in Nature 1986, not on arXiv
    // PDF must be manually placed at papers/rumelhart1986.pdf
    arxiv_id: null,
    title: "Learning Representations by Back-Propagating Errors",
    authors: ["Rumelhart", "Hinton", "Williams"],
    year: 1986,
    pdf_url: "MANUAL:rumelhart1986.pdf",
    categories: ["cs.LG"],
    primary_concepts: ["Backpropagation", "Gradient computation", "Chain rule"],
  },
  {
    // LSTM — published in Neural Computation 1997, not on arXiv
    // PDF must be manually placed at papers/hochreiter1997.pdf
    arxiv_id: null,
    title: "Long Short-Term Memory",
    authors: ["Hochreiter", "Schmidhuber"],
    year: 1997,
    pdf_url: "MANUAL:hochreiter1997.pdf",
    categories: ["cs.LG"],
    primary_concepts: ["LSTMs", "Gating mechanisms", "Vanishing gradients", "Sequence modeling"],
  },
];

// ============================================================
// Types
// ============================================================

export interface ParsedSection {
  title: string;
  number: string;
  content: string;
  order_index: number;
}

export interface ParsedPaper {
  sections: ParsedSection[];
  full_text: string;
}

export interface IngestResult {
  paper_title: string;
  paper_id: string | null;
  status: "ingested" | "skipped" | "error";
  sections_count: number;
  chunks_count: number;
  parse_method: "grobid" | "pdf-parse" | "none";
  error?: string;
}

// ============================================================
// PDF Download
// ============================================================

export async function downloadPdf(
  paper: PaperDefinition,
  papersDir: string
): Promise<string | null> {
  const filename = paper.arxiv_id
    ? `${paper.arxiv_id.replace("/", "_")}.pdf`
    : `${paper.authors[0].toLowerCase()}${paper.year}.pdf`;
  const filepath = path.join(papersDir, filename);

  // Already downloaded
  if (fs.existsSync(filepath)) {
    console.log(`    PDF exists: ${filename}`);
    return filepath;
  }

  // Manual papers — user must place the PDF themselves
  if (paper.pdf_url.startsWith("MANUAL:")) {
    const manualFile = path.join(papersDir, paper.pdf_url.replace("MANUAL:", ""));
    if (fs.existsSync(manualFile)) {
      console.log(`    Manual PDF found: ${manualFile}`);
      return manualFile;
    }
    console.warn(
      `    ⚠ Manual PDF required: place "${paper.pdf_url.replace("MANUAL:", "")}" in ${papersDir}/`
    );
    return null;
  }

  // Download from URL
  console.log(`    Downloading: ${paper.pdf_url}`);
  try {
    const res = await fetch(paper.pdf_url, {
      headers: {
        "User-Agent": "halpmeAIML/1.0 (educational-research-tool)",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      console.error(`    Download failed: HTTP ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filepath, buffer);
    console.log(`    Saved: ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);

    // Be polite to arXiv — 3 second delay between downloads
    await new Promise((r) => setTimeout(r, 3000));

    return filepath;
  } catch (err) {
    console.error(`    Download error: ${err}`);
    return null;
  }
}

// ============================================================
// arXiv Metadata Fetch (enriches what we already have)
// ============================================================

export async function fetchArxivMetadata(
  arxivId: string
): Promise<{ abstract: string; categories: string[] } | null> {
  try {
    const res = await fetch(
      `http://export.arxiv.org/api/query?id_list=${arxivId}`
    );
    if (!res.ok) return null;

    const xml = await res.text();

    // Simple XML extraction — avoid heavy XML parser for just abstract + categories
    const abstractMatch = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    const categoryMatches = [...xml.matchAll(/category[^>]*term="([^"]+)"/g)];

    return {
      abstract: abstractMatch
        ? abstractMatch[1].trim().replace(/\s+/g, " ")
        : "",
      categories: categoryMatches.map((m) => m[1]),
    };
  } catch {
    return null;
  }
}

// ============================================================
// GROBID Parsing (preferred path)
// ============================================================

export async function isGrobidAvailable(
  grobidUrl: string
): Promise<boolean> {
  try {
    const res = await fetch(`${grobidUrl}/api/isalive`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function parseWithGrobid(
  pdfPath: string,
  grobidUrl: string
): Promise<ParsedPaper | null> {
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const formData = new FormData();
    formData.append(
      "input",
      new Blob([pdfBuffer], { type: "application/pdf" }),
      path.basename(pdfPath)
    );

    const res = await fetch(
      `${grobidUrl}/api/processFulltextDocument`,
      {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(120000), // GROBID can be slow
      }
    );

    if (!res.ok) {
      console.warn(`    GROBID returned ${res.status}`);
      return null;
    }

    const teiXml = await res.text();
    return parseTeiXml(teiXml);
  } catch (err) {
    console.warn(`    GROBID parse error: ${err}`);
    return null;
  }
}

function parseTeiXml(xml: string): ParsedPaper {
  const sections: ParsedSection[] = [];
  let fullText = "";

  // Extract <body> content
  const bodyMatch = xml.match(/<body>([\s\S]*?)<\/body>/);
  if (!bodyMatch) {
    // Fallback: extract all <p> tags
    const pMatches = [...xml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)];
    const text = pMatches.map((m) => stripXmlTags(m[1]).trim()).join("\n\n");
    return {
      sections: [{ title: "Full Text", number: "1", content: text, order_index: 0 }],
      full_text: text,
    };
  }

  const body = bodyMatch[1];

  // Extract <div> elements with <head> (sections)
  const divRegex = /<div[^>]*>([\s\S]*?)<\/div>/g;
  let divMatch;
  let sectionIndex = 0;

  while ((divMatch = divRegex.exec(body)) !== null) {
    const divContent = divMatch[1];

    // Extract section heading
    const headMatch = divContent.match(
      /<head[^>]*(?:n="([^"]*)")?[^>]*>([\s\S]*?)<\/head>/
    );
    const sectionNumber = headMatch?.[1] || String(sectionIndex + 1);
    const sectionTitle = headMatch
      ? stripXmlTags(headMatch[2]).trim()
      : `Section ${sectionIndex + 1}`;

    // Extract all paragraph text
    const pMatches = [...divContent.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)];
    const sectionText = pMatches
      .map((m) => stripXmlTags(m[1]).trim())
      .filter((t) => t.length > 0)
      .join("\n\n");

    if (sectionText.length > 20) {
      sections.push({
        title: sectionTitle,
        number: sectionNumber,
        content: sectionText,
        order_index: sectionIndex,
      });
      fullText += `\n\n## ${sectionNumber} ${sectionTitle}\n\n${sectionText}`;
      sectionIndex++;
    }
  }

  // If no sections were extracted from divs, try a flat paragraph approach
  if (sections.length === 0) {
    const pMatches = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)];
    const text = pMatches.map((m) => stripXmlTags(m[1]).trim()).join("\n\n");
    sections.push({
      title: "Full Text",
      number: "1",
      content: text,
      order_index: 0,
    });
    fullText = text;
  }

  return { sections, full_text: fullText.trim() };
}

function stripXmlTags(text: string): string {
  return text
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "") // remove references
    .replace(/<formula[^>]*>([\s\S]*?)<\/formula>/g, " [EQUATION] ") // preserve equation markers
    .replace(/<[^>]+>/g, "") // strip remaining tags
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// pdf-parse Fallback (simpler, works without GROBID)
// ============================================================

export async function parseWithPdfParse(
  pdfPath: string
): Promise<ParsedPaper | null> {
  try {
    const pdfParse = require("pdf-parse");
    const pdfBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(pdfBuffer);
    const rawText: string = data.text;

    if (!rawText || rawText.length < 100) {
      console.warn("    pdf-parse extracted very little text");
      return null;
    }

    const sections = splitIntoSections(rawText);
    return { sections, full_text: rawText };
  } catch (err) {
    console.error(`    pdf-parse error: ${err}`);
    return null;
  }
}

function splitIntoSections(text: string): ParsedSection[] {
  // Match common academic section patterns:
  //   "1 Introduction"
  //   "3.2 Multi-Head Attention"
  //   "A Appendix"
  //   "Abstract"
  const sectionPattern =
    /(?:^|\n)(?:(\d+(?:\.\d+)*)\s+([A-Z][^\n]{2,80})|^(Abstract|Introduction|Conclusion|References|Acknowledgements?|Related Work|Discussion|Experiments?|Results|Methods?|Background|Appendix))/gm;

  const matches: Array<{ index: number; number: string; title: string }> = [];
  let match;

  while ((match = sectionPattern.exec(text)) !== null) {
    matches.push({
      index: match.index,
      number: match[1] || "",
      title: (match[2] || match[3] || "").trim(),
    });
  }

  if (matches.length === 0) {
    // No sections detected — return the whole text as one section
    return [
      {
        title: "Full Text",
        number: "1",
        content: text.trim(),
        order_index: 0,
      },
    ];
  }

  const sections: ParsedSection[] = [];

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const content = text.slice(start, end).trim();

    // Skip very short sections (likely false positives)
    if (content.length < 50) continue;

    // Remove the heading line from the content
    const contentLines = content.split("\n");
    const bodyContent = contentLines.slice(1).join("\n").trim();

    sections.push({
      title: matches[i].title,
      number: matches[i].number || String(i + 1),
      content: bodyContent || content,
      order_index: i,
    });
  }

  return sections.length > 0
    ? sections
    : [{ title: "Full Text", number: "1", content: text.trim(), order_index: 0 }];
}

// ============================================================
// Chunk sections into paragraphs
// ============================================================

export function chunkSection(sectionContent: string): string[] {
  // Split on double newlines (paragraph boundaries)
  const paragraphs = sectionContent
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 30); // skip very short fragments

  if (paragraphs.length === 0) {
    // Fallback: split on single newlines for dense text
    const lines = sectionContent.split("\n").map((l) => l.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = "";

    for (const line of lines) {
      current += (current ? " " : "") + line;
      // Target ~300-500 chars per chunk
      if (current.length >= 300) {
        chunks.push(current);
        current = "";
      }
    }
    if (current.length > 30) chunks.push(current);

    return chunks.length > 0 ? chunks : [sectionContent.trim()];
  }

  // Merge very short paragraphs with the next one
  const merged: string[] = [];
  let buffer = "";

  for (const p of paragraphs) {
    buffer += (buffer ? "\n\n" : "") + p;
    if (buffer.length >= 150) {
      merged.push(buffer);
      buffer = "";
    }
  }
  if (buffer.length > 30) merged.push(buffer);

  return merged;
}

// ============================================================
// Database Insertion
// ============================================================

export async function insertPaper(
  pool: Pool,
  paper: PaperDefinition,
  parsed: ParsedPaper,
  abstract: string
): Promise<IngestResult> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Insert paper
    const paperResult = await client.query(
      `INSERT INTO papers (arxiv_id, title, authors, year, abstract, full_text, categories, pdf_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING paper_id`,
      [
        paper.arxiv_id,
        paper.title,
        paper.authors,
        paper.year,
        abstract,
        parsed.full_text,
        paper.categories,
        paper.pdf_url,
      ]
    );

    const paperId: string = paperResult.rows[0].paper_id;
    let totalChunks = 0;

    // Insert sections and their chunks
    for (const section of parsed.sections) {
      const sectionResult = await client.query(
        `INSERT INTO paper_sections (paper_id, section_title, section_number, content, order_index)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING section_id`,
        [paperId, section.title, section.number, section.content, section.order_index]
      );

      const sectionId: string = sectionResult.rows[0].section_id;

      // Chunk the section into paragraphs
      const chunks = chunkSection(section.content);

      for (let ci = 0; ci < chunks.length; ci++) {
        await client.query(
          `INSERT INTO paper_chunks (paper_id, section_id, content, chunk_index)
           VALUES ($1, $2, $3, $4)`,
          [paperId, sectionId, chunks[ci], ci]
        );
        totalChunks++;
      }
    }

    await client.query("COMMIT");

    return {
      paper_title: paper.title,
      paper_id: paperId,
      status: "ingested",
      sections_count: parsed.sections.length,
      chunks_count: totalChunks,
      parse_method: "grobid", // caller overrides
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================
// Main Ingestion Orchestrator
// ============================================================

export async function ingestAllPapers(options: {
  pool: Pool;
  papersDir: string;
  grobidUrl: string;
  skipDownload?: boolean;
}): Promise<IngestResult[]> {
  const { pool, papersDir, grobidUrl, skipDownload } = options;
  const results: IngestResult[] = [];

  // Ensure papers directory exists
  if (!fs.existsSync(papersDir)) {
    fs.mkdirSync(papersDir, { recursive: true });
  }

  // Check GROBID availability
  const grobidReady = await isGrobidAvailable(grobidUrl);
  if (grobidReady) {
    console.log(`✓ GROBID available at ${grobidUrl}`);
  } else {
    console.log(`⚠ GROBID not available — will use pdf-parse fallback`);
  }

  console.log(`\nIngesting ${CANONICAL_PAPERS.length} canonical papers...\n`);

  for (let i = 0; i < CANONICAL_PAPERS.length; i++) {
    const paper = CANONICAL_PAPERS[i];
    console.log(`[${i + 1}/${CANONICAL_PAPERS.length}] ${paper.title} (${paper.year})`);

    // Check idempotency — skip if already in database
    const existing = await pool.query(
      paper.arxiv_id
        ? "SELECT paper_id FROM papers WHERE arxiv_id = $1"
        : "SELECT paper_id FROM papers WHERE title = $1",
      [paper.arxiv_id || paper.title]
    );

    if (existing.rows.length > 0) {
      console.log("    → Already ingested, skipping.\n");
      results.push({
        paper_title: paper.title,
        paper_id: existing.rows[0].paper_id,
        status: "skipped",
        sections_count: 0,
        chunks_count: 0,
        parse_method: "none",
      });
      continue;
    }

    // Step 1: Download PDF
    let pdfPath: string | null = null;
    if (!skipDownload) {
      pdfPath = await downloadPdf(paper, papersDir);
    } else {
      // Look for existing file
      const filename = paper.arxiv_id
        ? `${paper.arxiv_id.replace("/", "_")}.pdf`
        : `${paper.authors[0].toLowerCase()}${paper.year}.pdf`;
      const fp = path.join(papersDir, filename);
      if (fs.existsSync(fp)) pdfPath = fp;
    }

    if (!pdfPath) {
      console.log("    → PDF not available, skipping.\n");
      results.push({
        paper_title: paper.title,
        paper_id: null,
        status: "error",
        sections_count: 0,
        chunks_count: 0,
        parse_method: "none",
        error: "PDF not available",
      });
      continue;
    }

    // Step 2: Fetch arXiv metadata for abstract
    let abstract = "";
    if (paper.arxiv_id) {
      console.log("    Fetching arXiv metadata...");
      const meta = await fetchArxivMetadata(paper.arxiv_id);
      if (meta) {
        abstract = meta.abstract;
      }
      // Be polite to arXiv API
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Step 3: Parse the PDF
    let parsed: ParsedPaper | null = null;
    let parseMethod: "grobid" | "pdf-parse" = "pdf-parse";

    if (grobidReady) {
      console.log("    Parsing with GROBID...");
      parsed = await parseWithGrobid(pdfPath, grobidUrl);
      if (parsed) {
        parseMethod = "grobid";
      }
    }

    if (!parsed) {
      console.log("    Parsing with pdf-parse (fallback)...");
      parsed = await parseWithPdfParse(pdfPath);
    }

    if (!parsed || parsed.sections.length === 0) {
      console.log("    → Parsing failed, skipping.\n");
      results.push({
        paper_title: paper.title,
        paper_id: null,
        status: "error",
        sections_count: 0,
        chunks_count: 0,
        parse_method: "none",
        error: "PDF parsing failed",
      });
      continue;
    }

    // Step 4: Insert into database
    try {
      const result = await insertPaper(pool, paper, parsed, abstract);
      result.parse_method = parseMethod;
      results.push(result);
      console.log(
        `    ✓ ${result.sections_count} sections, ${result.chunks_count} chunks (${parseMethod})\n`
      );
    } catch (err) {
      console.error(`    ✗ Database insert error: ${err}\n`);
      results.push({
        paper_title: paper.title,
        paper_id: null,
        status: "error",
        sections_count: 0,
        chunks_count: 0,
        parse_method: parseMethod,
        error: String(err),
      });
    }
  }

  return results;
}
