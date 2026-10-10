# Architecture

## Request path

```
question
  ├─ rewrite against history      (small Gemini call, best-effort)
  ├─ embed query                  (Gemini, RETRIEVAL_QUERY task type)
  ├─ hybrid retrieve              one SQL statement:
  │     dense  : pgvector HNSW cosine, top 40
  │     sparse : tsvector ts_rank_cd, top 40
  │     fuse   : reciprocal rank fusion (k=60)
  │     filter : user_id AND folder_id = ANY(...)
  ├─ confidence gate              best dense score < 0.30 -> flag
  ├─ emit `sources` SSE event     UI renders citations here
  └─ stream `token` events        Gemma 4
        └─ persist message + citation rows (with snapshots)
```

## Upload path

```
bytes -> /tmp staging
  ├─ sha256                     duplicate upload -> 409, no re-embedding
  ├─ parse by MIME              plaintext | pymupdf | python-docx | tesseract
  ├─ measure coverage           pages_with_text / page_count
  ├─ chunk on headings          heading path prepended to each chunk
  ├─ embed in batches of 50     with exponential backoff on 429
  ├─ store text + chunks
  └─ delete original            UNLESS coverage < 0.60 or parse failed
```

## Decisions worth defending

**One vector table, not one database per user or folder.** A folder is a column.
Per-tenant indexes carry fixed memory overhead each, whether they hold 50 vectors
or 50,000 — a thousand users would mean a thousand HNSW indexes, connections, and
migrations. One table with `WHERE user_id = ? AND folder_id = ANY(?)` scales
further and is one backup.

**Hybrid retrieval, not dense-only.** Dense embeddings are weak on exact tokens:
error codes, `RealTimeIsUniversal`, arXiv ids, version numbers. Those are exactly
what people search their own documents for. Verified: a query for
`RealTimeIsUniversal` ranks the right chunk first via the lexical arm alone, with
no dense contribution.

**RRF instead of weighted score blending.** Cosine similarity and `ts_rank_cd` are
not on comparable scales; normalising them across corpora is guesswork. Rank
fusion needs no calibration.

**HNSW, not IVFFlat.** IVFFlat needs a training pass over existing rows, so the
index is useless until most data is loaded. HNSW works from the first insert.

**`hnsw.iterative_scan` is probed by version, not try/except.** Filtered vector
search under-returns without it (HNSW finds globally-nearest rows, then the
folder filter discards them). It only exists in pgvector 0.8+, and a failed `SET`
would need a rollback — rolling back the caller's transaction mid-request is
worse than losing the optimisation.

**The lexical index is a database trigger,** not application code, so it can never
drift out of sync with the text column.

**No local ML models.** Embeddings go to Gemini over HTTP. This is what lets the
whole service run in 512MB on Render's free tier — PyTorch alone is ~1GB resident
before loading anything.

**Token counting is approximate and offline.** A real BPE tokenizer would need a
runtime model download, and the obvious candidate (tiktoken/cl100k) is OpenAI's —
wrong for Gemini, so its precision would be false comfort. Chunking needs
consistent sizing, not exact counts.

**Extracted text is kept; the original is discarded.** The binary is a delivery
vehicle. Keeping the text means a future embedding-model change is a re-index, not
a mass re-upload request. Originals are retained only when coverage is poor —
those are the files worth OCRing later, and OCR needs the pixels.

**Extraction metrics are captured at parse time** (`page_count`,
`pages_with_text`, `coverage`, `parser_version`). Deleting the original is a
one-way door: anything not measured then can never be recovered.

**Citations snapshot what they displayed.** `chunk_id` is `ON DELETE SET NULL`, so
deleting a folder leaves old answers readable rather than turning every `[3]` into
a dead link.

**Upload commits before scheduling the background task.** Found by testing:
background tasks can begin before the request dependency's teardown commits, and
the worker then finds no row and silently does nothing, leaving files stuck on
"pending" forever.

**Folder scope is fixed at conversation creation.** If it could change mid-thread,
older answers would become unexplainable.

## Verified against a real database

Postgres 16 + pgvector, migrations applied, seeded with two users:

- hybrid retrieval returns fused results with both arms contributing
- lexical arm retrieves an exact identifier dense retrieval ranks 4th
- **querying another user's folder returns 0 rows, no leak**
- folder scoping and multi-folder union both correct
- upload -> parse -> chunk -> embed -> index -> search, end to end
- duplicate sha256 -> 409; unsupported type -> 415; empty -> 400
- deleting a file removes its chunks from search results

## Not done yet

- [ ] **Rate limiting.** None. Required before this is publicly reachable.
- [ ] **Session revocation on logout is per-token**, not all-devices.
- [ ] **Ingest runs in-process.** Fine on free tier; a large PDF makes the API
      sluggish while it processes. Move to a worker when affordable.
- [ ] **OCR** for scanned PDFs — currently rejected with an explanatory error.
- [ ] **Quotas** for storage and queries.
- [ ] **Guest trial** — schema supports it (`is_guest`, nullable `google_sub`).
