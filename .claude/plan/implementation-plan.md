# YouTube 双语字幕代理 - 实施计划

## 📋 项目概述

**目标**：构建 YouTube 字幕代理服务，解决手机端大模型翻译超时问题

**核心价值**：
- 首次请求快速返回原字幕（< 2s，不阻塞播放）
- 后台异步翻译（OpenAI GPT-4o）
- 二次请求返回双语字幕（段落级，双行显示）
- 持久化缓存（30 天 TTL）

**技术栈**：
- 运行时：Node.js 20+ / Deno
- 框架：Hono（轻量、边缘友好）
- 数据库：SQLite（零配置）
- 翻译：OpenAI GPT-4o API
- 部署：自建 VPS + Docker

---

## 🏗️ 系统架构

### 整体流程

```
┌─────────────────────────────────────────────┐
│  iOS 设备（Loon/圈X）                          │
│  ┌──────────────────────────────────────┐   │
│  │ 拦截 YouTube 字幕请求                 │   │
│  │ *.googlevideo.com/api/timedtext      │   │
│  └────────────┬─────────────────────────┘   │
│               ▼ 重写为代理 URL                │
└───────────────┼─────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────┐
│  代理服务器（Hono + SQLite）                  │
│  ┌──────────────────────────────────────┐   │
│  │ 1. 检查缓存（video_id + lang）        │   │
│  │    ├─ 缓存命中 → 返回双语字幕          │   │
│  │    └─ 缓存未命中 → 继续                │   │
│  └────────────┬─────────────────────────┘   │
│               ▼                              │
│  ┌──────────────────────────────────────┐   │
│  │ 2. 获取原始字幕（YouTube API）        │   │
│  └────────────┬─────────────────────────┘   │
│               ▼                              │
│  ┌──────────────────────────────────────┐   │
│  │ 3. 立即返回原字幕（满足超时要求）      │   │
│  └──────────────────────────────────────┘   │
│               ┃ 后台异步                      │
│               ▼                              │
│  ┌──────────────────────────────────────┐   │
│  │ 4. 段落切分（3-7 秒一段）             │   │
│  └────────────┬─────────────────────────┘   │
│               ▼                              │
│  ┌──────────────────────────────────────┐   │
│  │ 5. 调用 GPT-4o 翻译（并发 2）         │   │
│  └────────────┬─────────────────────────┘   │
│               ▼                              │
│  ┌──────────────────────────────────────┐   │
│  │ 6. 合并双语字幕（原文\n译文）          │   │
│  └────────────┬─────────────────────────┘   │
│               ▼                              │
│  ┌──────────────────────────────────────┐   │
│  │ 7. 写入 SQLite 缓存                   │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

---

## 📁 项目结构

```
youtube-subtitle-proxy/
├── src/
│   ├── config/
│   │   └── env.ts                  # 环境变量配置
│   ├── db/
│   │   ├── schema.sql              # SQLite 表结构
│   │   └── sqlite.ts               # 数据库连接
│   ├── http/
│   │   ├── server.ts               # Hono 服务器入口
│   │   └── routes.ts               # API 路由定义
│   ├── queue/
│   │   └── queue.ts                # 进程内任务队列
│   ├── services/
│   │   ├── youtube.ts              # YouTube API 客户端
│   │   ├── translator.ts           # OpenAI 翻译服务
│   │   └── cache.ts                # 缓存管理（LRU + SQLite）
│   ├── subtitle/
│   │   ├── parse.ts                # 字幕解析
│   │   ├── segment.ts              # 段落切分算法
│   │   └── render.ts               # WebVTT 渲染
│   └── types/
│       └── subtitle.ts             # 类型定义
├── scripts/
│   ├── loon/
│   │   └── youtube-subtitle.js     # Loon 脚本
│   └── quantumultx/
│       └── youtube-subtitle.js     # 圈X 脚本
├── docs/
│   ├── backend-architecture.md     # 后端架构文档（Codex 输出）
│   └── frontend-config.md          # 前端配置文档（Claude 输出）
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── tests/
│   ├── unit/
│   └── integration/
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🗄️ 数据库设计

### caption_jobs 表（任务跟踪）

```sql
CREATE TABLE IF NOT EXISTS caption_jobs (
  id TEXT PRIMARY KEY,                    -- UUID
  video_id TEXT NOT NULL,                 -- YouTube 视频 ID
  lang TEXT NOT NULL,                     -- 原字幕语言（en, ja, ko）
  track TEXT NOT NULL,                    -- 字幕轨道名称
  fmt TEXT NOT NULL,                      -- 格式（vtt, srv3）
  source_hash TEXT NOT NULL,              -- 原字幕 SHA256（检测变更）
  status TEXT NOT NULL,                   -- pending|translating|done|failed
  retry_count INTEGER DEFAULT 0,          -- 重试次数
  next_retry_at INTEGER,                  -- 下次重试时间戳
  error_code TEXT,                        -- 错误代码
  error_message TEXT,                     -- 错误信息
  bilingual_json TEXT,                    -- 双语字幕 JSON（最终结果）
  created_at INTEGER NOT NULL,            -- 创建时间
  updated_at INTEGER NOT NULL,            -- 更新时间
  expires_at INTEGER NOT NULL,            -- 过期时间（TTL）

  UNIQUE(video_id, lang, track, fmt, source_hash)
);

CREATE INDEX idx_jobs_status ON caption_jobs(status, next_retry_at);
CREATE INDEX idx_jobs_expires ON caption_jobs(expires_at);
```

### caption_segments 表（段落翻译）

```sql
CREATE TABLE IF NOT EXISTS caption_segments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,              -- 开始时间（毫秒）
  end_ms INTEGER NOT NULL,                -- 结束时间（毫秒）
  source_text TEXT NOT NULL,              -- 原文
  translated_text TEXT,                   -- 译文
  status TEXT NOT NULL,                   -- pending|done|failed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY(job_id) REFERENCES caption_jobs(id),
  UNIQUE(job_id, segment_index)
);
```

---

## 🔌 API 设计

### 核心端点

#### `GET /api/subtitle`

**功能**：代理 YouTube 字幕请求

**查询参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `v` | string | ✅ | 视频 ID |
| `lang` | string | ✅ | 原字幕语言 |
| `tlang` | string | ✅ | 目标翻译语言（默认 zh-CN） |
| `fmt` | string | ❌ | 格式（vtt/srv3，默认 vtt） |
| `original_url` | string | ❌ | YouTube 原始 URL（用于回源） |

**响应**：

**首次请求（缓存未命中）**：
```http
HTTP/1.1 200 OK
Content-Type: text/vtt; charset=utf-8
X-Translation-Status: pending
X-Estimated-Time: 45
X-Cache-Status: MISS

WEBVTT
[原字幕内容]
```

**二次请求（缓存命中）**：
```http
HTTP/1.1 200 OK
Content-Type: text/vtt; charset=utf-8
X-Translation-Status: completed
X-Cache-Status: HIT

WEBVTT
1
00:00:01.000 --> 00:00:04.500
Original text here
原文翻译在这里
```

---

## 🧩 核心算法

### 1. 段落切分算法

**目标**：将逐词字幕合并为 3-7 秒的段落

```typescript
interface SubtitleCue {
  startTime: number;  // 毫秒
  endTime: number;
  text: string;
}

function mergeSubtitleCues(
  rawCues: SubtitleCue[],
  minDuration = 3000,  // 3 秒
  maxDuration = 7000   // 7 秒
): SubtitleCue[] {
  const merged: SubtitleCue[] = [];
  let currentGroup: string[] = [];
  let groupStartTime: number | null = null;
  let groupEndTime: number | null = null;

  for (const cue of rawCues) {
    if (!groupStartTime) {
      // 新段落开始
      groupStartTime = cue.startTime;
      groupEndTime = cue.endTime;
      currentGroup.push(cue.text);
    } else {
      const currentDuration = cue.endTime - groupStartTime;

      if (currentDuration <= maxDuration) {
        // 继续追加到当前段落
        groupEndTime = cue.endTime;
        currentGroup.push(cue.text);
      } else {
        // 当前段落结束
        if (groupEndTime! - groupStartTime >= minDuration) {
          merged.push({
            startTime: groupStartTime,
            endTime: groupEndTime!,
            text: currentGroup.join(' ')
          });
        }

        // 开始新段落
        groupStartTime = cue.startTime;
        groupEndTime = cue.endTime;
        currentGroup = [cue.text];
      }
    }
  }

  // 处理最后一个段落
  if (currentGroup.length > 0 && groupStartTime && groupEndTime) {
    merged.push({
      startTime: groupStartTime,
      endTime: groupEndTime,
      text: currentGroup.join(' ')
    });
  }

  return merged;
}
```

---

### 2. 翻译服务

```typescript
import OpenAI from 'openai';

class TranslationService {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async translateSegment(
    text: string,
    targetLang: string = 'zh-CN'
  ): Promise<string> {
    const prompt = `Translate the following text to ${targetLang}. Return only the translation without any explanation.

Text: ${text}`;

    const response = await this.client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
      timeout: 20000  // 20 秒超时
    });

    return response.choices[0].message.content?.trim() || text;
  }

  async translateBatch(
    segments: SubtitleCue[],
    targetLang: string = 'zh-CN',
    concurrency: number = 2
  ): Promise<SubtitleCue[]> {
    const results: SubtitleCue[] = [];

    // 并发控制
    for (let i = 0; i < segments.length; i += concurrency) {
      const batch = segments.slice(i, i + concurrency);
      const promises = batch.map(segment =>
        this.translateSegment(segment.text, targetLang)
      );

      const translations = await Promise.all(promises);

      translations.forEach((translation, idx) => {
        results.push({
          ...batch[idx],
          text: `${batch[idx].text}\n${translation}`  // 双语格式
        });
      });
    }

    return results;
  }
}
```

---

### 3. WebVTT 渲染

```typescript
function renderWebVTT(segments: SubtitleCue[]): string {
  let vtt = 'WEBVTT\nKind: captions\nLanguage: zh-CN\n\n';
  vtt += 'NOTE\nGenerated by YouTube Subtitle Proxy\n\n';

  segments.forEach((segment, index) => {
    const startTime = formatTimestamp(segment.startTime);
    const endTime = formatTimestamp(segment.endTime);

    vtt += `${index + 1}\n`;
    vtt += `${startTime} --> ${endTime}\n`;
    vtt += `${segment.text}\n\n`;
  });

  return vtt;
}

function formatTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = ms % 1000;

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`;
}

function pad(num: number, length: number): string {
  return num.toString().padStart(length, '0');
}
```

---

## 🚀 部署配置

### 环境变量（.env）

```bash
# 服务器配置
PORT=3000
NODE_ENV=production

# OpenAI API
OPENAI_API_KEY=sk-proj-xxx
OPENAI_MODEL=gpt-4o
TRANSLATE_TIMEOUT_MS=20000
QUEUE_CONCURRENCY=2

# 数据库
DB_PATH=/data/subtitles.db
CACHE_TTL_HOURS=720  # 30 天

# 缓存策略
LRU_MAX_ITEMS=1000
CLEANUP_INTERVAL_MS=3600000  # 1 小时

# 重试策略
MAX_RETRIES=3
RETRY_BASE_MS=5000

# YouTube API
YT_FETCH_TIMEOUT_MS=5000

# 字幕处理
SEGMENT_GAP_MS=1200
SEGMENT_MIN_DURATION_MS=3000
SEGMENT_MAX_DURATION_MS=7000

# 可选：管理接口
ADMIN_TOKEN=your-secret-token
```

---

### Docker 配置

#### Dockerfile

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 构建应用
COPY . .
RUN npm run build

# 生产镜像
FROM node:20-alpine

WORKDIR /app

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 复制构建产物
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./

# 创建数据目录
RUN mkdir -p /data && chown nodejs:nodejs /data

USER nodejs

EXPOSE 3000

ENV NODE_ENV=production
ENV DB_PATH=/data/subtitles.db

CMD ["node", "dist/http/server.js"]
```

#### docker-compose.yml

```yaml
version: '3.8'

services:
  subtitle-proxy:
    build: .
    container_name: youtube-subtitle-proxy
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - NODE_ENV=production
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - OPENAI_MODEL=gpt-4o
      - DB_PATH=/data/subtitles.db
      - CACHE_TTL_HOURS=720
      - LRU_MAX_ITEMS=1000
      - QUEUE_CONCURRENCY=2
    volumes:
      - subtitle-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  subtitle-data:
    driver: local
```

---

## 📱 前端配置

### Loon 脚本关键代码

```javascript
const CONFIG = {
  PROXY_BASE_URL: "https://your-domain.com",  // 修改为你的服务器地址
  TARGET_LANG: "zh-CN",
  ENABLE_NOTIFICATION: true,
  REQUEST_TIMEOUT: 10,
  DEBUG: false
};

function buildProxyUrl(originalUrl) {
  const url = new URL(originalUrl);
  const params = new URLSearchParams(url.search);

  const proxyUrl = new URL(`${CONFIG.PROXY_BASE_URL}/api/subtitle`);
  proxyUrl.searchParams.set('v', params.get('v'));
  proxyUrl.searchParams.set('lang', params.get('lang') || 'en');
  proxyUrl.searchParams.set('tlang', CONFIG.TARGET_LANG);
  proxyUrl.searchParams.set('fmt', params.get('fmt') || 'vtt');
  proxyUrl.searchParams.set('original_url', encodeURIComponent(originalUrl));

  return proxyUrl.toString();
}

function handleRequest() {
  const originalUrl = $request.url;
  const proxyUrl = buildProxyUrl(originalUrl);

  return {
    url: proxyUrl,
    headers: {
      ...($request.headers || {}),
      'X-Proxy-By': 'Loon-YouTube-Subtitle-Proxy'
    }
  };
}

$done(handleRequest());
```

完整脚本见：`scripts/loon/youtube-subtitle.js`

---

## 🧪 测试计划

### 单元测试

- ✅ 段落切分算法（不同时长、边界情况）
- ✅ WebVTT 渲染（特殊字符、时间戳格式）
- ✅ 缓存键生成（一致性、哈希算法）
- ✅ 错误处理（超时、API 失败）

### 集成测试

- ✅ 完整流程（首次 → 翻译 → 二次）
- ✅ 缓存命中/未命中
- ✅ 并发请求
- ✅ 重试机制

### E2E 测试

- ✅ Loon 脚本拦截
- ✅ YouTube App 字幕显示
- ✅ 多语言组合（英→中、日→中、韩→中）
- ✅ 长视频（10+ 分钟）

---

## 📊 监控指标

### 关键指标

| 指标 | 目标值 | 监控方式 |
|------|--------|----------|
| 首次响应时间（缓存未命中） | < 2s | 服务端日志 |
| 二次响应时间（缓存命中） | < 200ms | 服务端日志 |
| 翻译完成时间 | < 60s | 异步任务监控 |
| 缓存命中率 | > 80% | SQLite 统计 |
| OpenAI API 成功率 | > 95% | 错误日志 |
| 任务失败率 | < 5% | 失败任务统计 |

### 日志示例

```typescript
logger.info('Subtitle request', {
  videoId,
  lang,
  cacheStatus: 'MISS',
  responseTime: 1850
});

logger.info('Translation completed', {
  videoId,
  segmentCount: 45,
  duration: 48500,
  cost: 0.12  // USD
});
```

---

## 🔒 安全考虑

### 1. 输入验证

```typescript
function validateRequest(params: any) {
  if (!params.v || !/^[a-zA-Z0-9_-]{11}$/.test(params.v)) {
    throw new Error('Invalid video ID');
  }

  if (!params.lang || params.lang.length > 10) {
    throw new Error('Invalid language code');
  }

  // 防止 URL 注入
  if (params.original_url) {
    const url = new URL(params.original_url);
    if (!url.hostname.includes('googlevideo.com')) {
      throw new Error('Invalid original URL');
    }
  }
}
```

### 2. 速率限制

```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 分钟
  max: 100,  // 最多 100 个请求
  message: 'Too many requests, please try again later'
});

app.use('/api/subtitle', limiter);
```

### 3. 敏感信息保护

- ❌ 不在日志中记录完整字幕内容
- ❌ 不在响应头中暴露 API key
- ✅ 使用环境变量存储敏感配置
- ✅ 定期清理过期缓存

---

## 📅 实施阶段

### 阶段 1：基础架构（2-3 天）

**目标**：搭建核心服务，验证技术可行性

**任务清单**：
- [ ] 初始化项目（TypeScript + Hono）
- [ ] 设计数据库 Schema（SQLite）
- [ ] 实现 YouTube 字幕获取
- [ ] 实现 OpenAI 翻译调用
- [ ] 实现缓存层（LRU + SQLite）
- [ ] 编写单元测试

**交付物**：
- 可运行的 HTTP 服务
- 单元测试覆盖率 > 80%

---

### 阶段 2：核心功能（3-4 天）

**目标**：实现完整的翻译流程

**任务清单**：
- [ ] 实现段落切分算法
- [ ] 实现 WebVTT 渲染
- [ ] 实现进程内任务队列
- [ ] 实现异步翻译逻辑
- [ ] 实现错误处理与重试
- [ ] 编写集成测试

**交付物**：
- 完整的翻译流程
- 集成测试通过

---

### 阶段 3：前端集成（1-2 天）

**目标**：Loon/圈X 脚本配置

**任务清单**：
- [ ] 编写 Loon 脚本
- [ ] 编写圈X 脚本
- [ ] 编写用户配置文档
- [ ] 测试 iOS 真机环境

**交付物**：
- 可用的 Loon/圈X 脚本
- 用户配置指南

---

### 阶段 4：部署与优化（1-2 天）

**目标**：生产环境部署

**任务清单**：
- [ ] 编写 Dockerfile
- [ ] 配置 Nginx 反向代理
- [ ] 配置 SSL 证书（Let's Encrypt）
- [ ] 性能测试与优化
- [ ] 监控日志配置

**交付物**：
- Docker 镜像
- 部署文档
- 监控仪表盘

---

### 阶段 5：测试与迭代（1-2 天）

**目标**：验证用户体验

**任务清单**：
- [ ] E2E 测试（真实 YouTube 视频）
- [ ] 多语言组合测试
- [ ] 长视频测试（10+ 分钟）
- [ ] 边界情况测试
- [ ] 收集用户反馈

**交付物**：
- 测试报告
- Bug 修复
- 用户反馈文档

---

## 📚 参考文档

### 技术文档

- **后端架构设计**：`docs/backend-architecture.md`（Codex 输出）
- **前端配置指南**：`docs/frontend-config.md`（Claude 输出）
- **API 接口文档**：`docs/api-reference.md`
- **数据库设计**：`docs/database-schema.md`

### 外部资源

- **Hono 框架**：https://hono.dev/
- **OpenAI API**：https://platform.openai.com/docs/
- **WebVTT 规范**：https://w3c.github.io/webvtt/
- **Loon 文档**：https://nsloon.app/docs/
- **Quantumult X 文档**：https://quantumult.app/x/

---

## 🎯 成功标准

### MVP 验收标准

✅ **功能完整性**：
- 首次请求返回原字幕（< 2s）
- 二次请求返回双语字幕
- 缓存命中率 > 80%

✅ **翻译质量**：
- GPT-4o 翻译自然流畅
- 双语对齐正确
- 特殊字符正确转义

✅ **用户体验**：
- iOS YouTube App 正常显示字幕
- Loon/圈X 脚本配置简单（< 5 分钟）
- 错误提示清晰

✅ **性能指标**：
- 首次响应 < 2s
- 缓存命中 < 200ms
- 翻译完成 < 60s

✅ **稳定性**：
- 24 小时运行无崩溃
- 错误恢复机制有效
- 任务重试成功率 > 90%

---

## 🚧 已知限制

### 当前版本（MVP）

1. **单机部署**：不支持多实例负载均衡
2. **进程内队列**：进程重启任务丢失
3. **无监控面板**：依赖日志文件
4. **无用户认证**：API 公开访问

### 未来优化方向

- 分布式架构（方案 B）
- 独立消息队列（Redis + BullMQ）
- 实时翻译进度推送（WebSocket）
- 用户管理后台（配额、API key）
- 多模型支持（Claude、Gemini 备选）
- 批量预热（热门视频提前翻译）

---

## 📞 支持与反馈

- **GitHub Issues**：https://github.com/your-repo/issues
- **文档站点**：https://your-domain.com/docs
- **邮箱**：support@your-domain.com

---

**最后更新**：2026-01-29
**文档版本**：1.0.0
**批准状态**：待用户批准
