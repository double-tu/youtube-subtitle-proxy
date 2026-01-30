# YouTube Subtitle Proxy

AI-powered bilingual subtitle proxy for YouTube videos.

## Features

- 🚀 **Fast Response**: First request returns original subtitles in < 2s
- 🤖 **AI Translation**: Powered by OpenAI GPT-4o
- 💾 **Smart Caching**: LRU + SQLite with 30-day TTL
- 📱 **Mobile First**: Optimized for iOS (Loon/圈X)
- 🌍 **Bilingual Display**: Line-by-line original + translation

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env and configure:
# - OPENAI_API_KEY: Your OpenAI API key
# - OPENAI_BASE_URL: (Optional) Custom API endpoint (default: https://api.openai.com/v1)
```

**Custom API Endpoint**:
You can use OpenAI-compatible services (like Azure OpenAI, third-party proxies, or local LLM servers) by setting `OPENAI_BASE_URL`:

```bash
# Example: Azure OpenAI
OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment

# Example: Third-party proxy
OPENAI_BASE_URL=https://api.your-proxy.com/v1

# Example: Local LLM server (e.g., LocalAI, vLLM)
OPENAI_BASE_URL=http://localhost:8080/v1
```

### 3. Run Development Server

```bash
npm run dev
```

Server will start at http://localhost:3000

### 4. Configure Loon/圈X

See `docs/frontend-config.md` for detailed setup instructions.

## Project Structure

```
src/
├── config/        # Environment configuration
├── db/            # Database schema and connection
├── http/          # HTTP server and routes
├── queue/         # Task queue
├── services/      # YouTube, Translation, Cache services
├── subtitle/      # Subtitle parsing and rendering
└── types/         # TypeScript type definitions
```

## API Endpoints

### GET /api/subtitle

Proxy YouTube subtitle requests with AI translation.

**Query Parameters**:
- `v` (required): Video ID
- `lang` (required): Original language
- `tlang` (required): Target language (default: zh-CN)
- `fmt` (optional): Format (vtt/srv3, default: vtt)

**Example**:
```
GET /api/subtitle?v=dQw4w9WgXcQ&lang=en&tlang=zh-CN&fmt=vtt
```

**Response Headers**:
- `X-Translation-Status`: pending | completed | failed
- `X-Cache-Status`: HIT | MISS
- `X-Estimated-Time`: Estimated translation time (seconds)

## Development

### Run Tests

```bash
npm test
```

### Build for Production

```bash
npm run build
npm start
```

### Lint and Format

```bash
npm run lint
npm run format
```

## Deployment

### Docker

```bash
docker build -t youtube-subtitle-proxy .
docker run -p 3000:3000 \
  -e OPENAI_API_KEY=your-key \
  -v $(pwd)/data:/data \
  youtube-subtitle-proxy
```

### Docker Compose

```bash
docker-compose up -d
```

## Documentation

- [Implementation Plan](.claude/plan/implementation-plan.md)
- [Backend Architecture](docs/backend-architecture.md)
- [Frontend Configuration](docs/frontend-config.md)

## Performance

- First request (cache miss): < 2s
- Cached request: < 200ms
- Translation completion: < 60s
- Cache hit rate: > 80%

## License

MIT
