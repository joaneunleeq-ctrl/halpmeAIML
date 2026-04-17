"""
halpmeAIML — Local Embedding Server
Runs sentence-transformers all-mpnet-base-v2 behind a FastAPI HTTP interface.
Used by LocalEmbeddingProvider in src/lib/providers/embedding-provider.ts.

Start via:  python scripts/embedding-server.py
Or use:     bash scripts/start-embedding-server.sh
"""

import time
import logging
from contextlib import asynccontextmanager
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("embedding-server")

# ---------------------------------------------------------------------------
# Global model reference — loaded once at startup
# ---------------------------------------------------------------------------
model = None
MODEL_NAME = "all-mpnet-base-v2"
DIMENSIONS = 768


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the sentence-transformers model on startup."""
    global model
    logger.info(f"Loading model: {MODEL_NAME} ...")
    start = time.time()

    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(MODEL_NAME)
    elapsed = time.time() - start
    logger.info(f"Model loaded in {elapsed:.1f}s — dimensions: {DIMENSIONS}")
    yield
    logger.info("Shutting down embedding server")


app = FastAPI(
    title="halpmeAIML Embedding Server",
    version="1.0.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class EmbedRequest(BaseModel):
    text: str


class EmbedResponse(BaseModel):
    embedding: list[float]
    dimensions: int


class EmbedBatchRequest(BaseModel):
    texts: list[str]


class EmbedBatchResponse(BaseModel):
    embeddings: list[list[float]]
    count: int
    dimensions: int


class HealthResponse(BaseModel):
    status: str
    model: str
    dimensions: int
    ready: bool


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check — confirms the model is loaded and returns dimensions."""
    return HealthResponse(
        status="ok" if model is not None else "loading",
        model=MODEL_NAME,
        dimensions=DIMENSIONS,
        ready=model is not None,
    )


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    """Embed a single text string."""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Empty text")

    embedding = model.encode(request.text, normalize_embeddings=True)
    return EmbedResponse(
        embedding=embedding.tolist(),
        dimensions=DIMENSIONS,
    )


@app.post("/embed-batch", response_model=EmbedBatchResponse)
async def embed_batch(request: EmbedBatchRequest):
    """Embed a batch of text strings. Max batch size: 256."""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    if len(request.texts) == 0:
        return EmbedBatchResponse(embeddings=[], count=0, dimensions=DIMENSIONS)

    if len(request.texts) > 256:
        raise HTTPException(status_code=400, detail="Batch too large (max 256)")

    texts = [t if t.strip() else " " for t in request.texts]

    start = time.time()
    embeddings = model.encode(texts, normalize_embeddings=True, batch_size=32)
    elapsed = time.time() - start

    logger.info(f"Embedded {len(texts)} texts in {elapsed:.2f}s")

    return EmbedBatchResponse(
        embeddings=[e.tolist() for e in embeddings],
        count=len(texts),
        dimensions=DIMENSIONS,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(
        "embedding-server:app",
        host="0.0.0.0",
        port=5001,
        log_level="info",
    )
