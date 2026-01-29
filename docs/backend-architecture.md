# Architecture Design: YouTube Subtitle Proxy (Monolith)

This document specifies a production-ready monolith for a YouTube subtitle proxy
that returns original subtitles on first request and bilingual subtitles on
subsequent requests, using async translation with OpenAI GPT-4o.

## 1) Goals and Constraints
- Intercept and proxy YouTube timedtext JSON requests.
- Script runtime (Loon/QuanX) has hard timeouts, so translation must be async.
- First request returns original subtitles immediately.
- Second request returns bilingual subtitles from cache.
- Tech: Node.js or Deno + Hono + SQLite + in-process task queue.
- Deployment: self-hosted VPS.

## 2) High-Level Architecture

Request Flow (first request):
1. Proxy receives timedtext request.
2. Cache miss -> fetch from YouTube.
3. Return original JSON immediately.
4. Enqueue translation job (async).
5. Worker translates and persists bilingual JSON.

Request Flow (second request):
1. Proxy receives timedtext request.
2. Cache hit -> return bilingual JSON.

Components:
- HTTP Proxy (Hono): request handling, signature and query validation.
- Cache Layer: in-memory LRU + SQLite.
- Translation Service: OpenAI GPT-4o client.
- Subtitle Pipeline: parsing, segmentation, merge, render.
- In-process Queue: concurrency-limited worker loop.

## 3) Project Structure

Proposed layout (Node.js or Deno compatible):

```
/src
  /config
    env.ts
  /db
    schema.sql
    sqlite.ts
  /http
    server.ts
    routes.ts
  /queue
    queue.ts
  /services
    youtube.ts
    translator.ts
    cache.ts
  /subtitle
    parse.ts
    segment.ts
    render.ts
  /types
    subtitle.ts
```

## 4) Core Module Design

### Proxy Layer (Hono)
Responsibilities:
- Validate request parameters.
- Build cache key.
- Read from cache; on miss, fetch from YouTube.
- Return response quickly and enqueue translation in background.

### Cache Layer
Responsibilities:
- In-memory LRU for hot bilingual results.
- SQLite as persistent cache for bilingual JSON and job state.
- TTL-based cleanup to cap storage.

### Translation Layer
Responsibilities:
- Accept segmented subtitles, call OpenAI GPT-4o.
- Apply rate limit and timeout.
- Return translated text per segment.

### Task Queue (In-Process)
Responsibilities:
- Minimal queue with concurrency and retry logic.
- Idempotent job execution with job status in SQLite.
- Safe shutdown.

### Subtitle Pipeline
Responsibilities:
- Parse YouTube timedtext JSON.
- Segment by time gaps and punctuation.
- Translate per segment.
- Merge original + translation into bilingual JSON.

## 5) Database Schema (SQLite)

Minimal schema for job tracking and cache:

```sql
CREATE TABLE IF NOT EXISTS caption_jobs (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  track TEXT NOT NULL,
  fmt TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL, -- pending|translating|done|failed
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  bilingual_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_caption_jobs_key
ON caption_jobs (video_id, lang, track, fmt, source_hash);

CREATE INDEX IF NOT EXISTS idx_caption_jobs_status
ON caption_jobs (status, next_retry_at);

CREATE TABLE IF NOT EXISTS caption_segments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT,
  status TEXT NOT NULL, -- pending|done|failed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES caption_jobs (id)
);
```

Notes:
- `source_hash` is derived from the original JSON to detect changes.
- `bilingual_json` stores the final merged JSON response.
- `expires_at` supports TTL cleanup.

## 6) API Endpoints

Use proxy-style endpoints so Loon/QuanX can rewrite requests.

```
GET /timedtext
  Query: v (videoId), lang, name (track), fmt
  Behavior:
    - Cache hit: return bilingual JSON.
    - Cache miss: fetch from YouTube, return original JSON,
      enqueue translation job.

GET /health
  Returns service status.

GET /admin/jobs/:id (optional, protected)
  Returns job status and timestamps.
```

Response behavior:
- Always return valid JSON in YouTube timedtext format.
- On error: return original YouTube JSON if available; otherwise 502.

## 7) Subtitle Processing Algorithm

### Parsing
Input is YouTube timedtext JSON, typically:
```
{
  "events": [
    { "tStartMs": 123, "dDurationMs": 456, "segs": [{ "utf8": "hello" }] }
  ]
}
```

### Segmentation
- Merge each event's segs to a single line.
- Group events into paragraphs when gap between events exceeds threshold
  (e.g. 1200ms) or when sentence-ending punctuation is detected.

Pseudo:
```ts
const GAP_MS = env.SEGMENT_GAP_MS ?? 1200;
for each event in events:
  if gap > GAP_MS or endsWithPunctuation(prevText):
    start new paragraph
  add event text to current paragraph
```

### Translation
- For each paragraph, build a prompt:
  "Translate to Chinese. Return only the translation."
- Call OpenAI GPT-4o. Store translated text in SQLite.

### Render (Bilingual)
- Create new events per paragraph:
  - start_ms = first event start
  - end_ms = last event end
  - text = original paragraph + "\n" + translation
- Emit JSON in YouTube timedtext format.

Pseudo render:
```ts
events = paragraphs.map(p => ({
  tStartMs: p.start_ms,
  dDurationMs: p.end_ms - p.start_ms,
  segs: [{ utf8: `${p.source}\n${p.translation}` }]
}));
```

## 8) Error Handling and Retry

Error handling principles:
- Never block the proxy response on translation.
- Always return a valid JSON response.
- Avoid leaking secrets in logs.

Retry strategy:
- Max retries: 3 to 5.
- Exponential backoff: base 5s, multiplier 2.
- Store `next_retry_at` in SQLite.
- Mark `failed` after max retries and keep original JSON.

Example retry logic:
```ts
const delayMs = baseMs * Math.pow(2, retryCount);
job.next_retry_at = now + delayMs;
```

## 9) Cache Strategy (TTL + LRU)

Two-layer caching:
1) In-memory LRU (hot results):
   - Key: video_id|lang|track|fmt|source_hash
   - Value: bilingual JSON string
   - Size: 500 to 2000 entries.
2) SQLite persistent cache:
   - TTL: 7 to 30 days.
   - Cleanup: periodic task deletes expired rows.

Cleanup job:
```ts
setInterval(() => {
  db.exec("DELETE FROM caption_jobs WHERE expires_at < ?");
}, env.CLEANUP_INTERVAL_MS ?? 3600000);
```

## 10) Deployment and Configuration

### Environment Variables
- `PORT=3000`
- `OPENAI_API_KEY=...`
- `OPENAI_MODEL=gpt-4o`
- `DB_PATH=/data/subtitles.db`
- `CACHE_TTL_HOURS=168`
- `LRU_MAX=1000`
- `QUEUE_CONCURRENCY=2`
- `MAX_RETRIES=3`
- `RETRY_BASE_MS=5000`
- `YT_FETCH_TIMEOUT_MS=5000`
- `TRANSLATE_TIMEOUT_MS=20000`
- `SEGMENT_GAP_MS=1200`
- `ADMIN_TOKEN=...` (optional)

### Docker Example

```
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/http/server.js"]
```

### Runtime Notes
- Use a process manager (systemd, pm2) for auto-restart.
- Ensure SQLite file is on persistent storage.
- Configure reverse proxy (nginx) for TLS and compression.

## 11) Code Examples

### Hono Route (proxy)
```ts
app.get("/timedtext", async (c) => {
  const params = parseTimedtextQuery(c.req.query());
  const key = buildCacheKey(params);

  const cached = await cache.getBilingual(key);
  if (cached) return c.json(cached);

  const original = await youtube.fetchTimedtext(params);
  c.executionCtx.waitUntil(queue.enqueueTranslate(key, original));
  return c.json(original);
});
```

### Translation Call (OpenAI)
```ts
const response = await openai.responses.create({
  model: env.OPENAI_MODEL,
  input: `Translate to Chinese. Return only translation.\n\n${text}`,
});
const translated = response.output_text;
```

## 12) Security and Compliance
- Validate query inputs and limit lengths.
- Avoid logging full subtitle content in production.
- Store API keys only in environment variables.
- Consider request rate limiting to avoid abuse.

## 13) Operational Considerations
- Monitor queue depth and translation latency.
- Track cache hit ratio and translation cost.
- Add alerts for repeated failures from OpenAI or YouTube.

---

**Generated by**: Codex (Backend Analysis)
**Session ID**: 019c09ca-f15d-7c22-b178-9093548902df
