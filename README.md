# YouTube 双语字幕代理服务

基于 AI 的 YouTube 视频双语字幕代理服务，支持自动翻译和智能缓存。

## ✨ 特性

- 🚀 **极速响应**: 首次请求 < 2s 返回原字幕，后台异步翻译
- 🤖 **AI 翻译**: 支持 OpenAI GPT-4o 和所有兼容服务
- 💾 **智能缓存**: LRU + SQLite 双层缓存，30天有效期
- 📱 **移动优先**: 为 iOS (Loon/圈X) 优化
- 🌍 **双语显示**: 原文+译文逐行对照
- 🐳 **一键部署**: Docker Compose 快速部署
- 🔧 **灵活配置**: 支持自定义 API 端点

## 📦 快速部署（推荐）

### 方式一：Docker Compose（一键部署）

**1. 克隆项目到 VPS**

```bash
git clone https://github.com/your-repo/youtube-subtitle-proxy.git
cd youtube-subtitle-proxy
```

**2. 配置环境变量**

```bash
# 创建配置文件
cp .env.production.example .env

# 编辑配置文件（必须配置 OPENAI_API_KEY）
nano .env
```

**3. 一键启动**

```bash
docker-compose up -d
```

服务将在 `http://your-server-ip:12033` 启动

**4. 查看日志**

```bash
# 查看运行日志
docker-compose logs -f

# 检查服务状态
docker-compose ps
```

**5. 管理命令**

```bash
# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 更新代码后重新构建
git pull
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

---

### 方式二：手动部署

**1. 环境要求**

- Node.js 20+
- npm 或 yarn

**2. 安装依赖**

```bash
npm install
```

**3. 配置环境**

```bash
cp .env.example .env
# 编辑 .env 文件配置 API 密钥
```

**4. 构建并运行**

```bash
# 开发环境
npm run dev

# 生产环境
npm run build
npm start
```

---

## ⚙️ 配置说明

### 必需配置

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `OPENAI_API_KEY` | **必填** OpenAI API 密钥 | `sk-proj-xxx` |

### OpenAI 端点配置

支持多种 OpenAI 兼容服务：

```bash
# 官方 OpenAI（默认）
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

# Azure OpenAI
OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/gpt-4o
OPENAI_MODEL=gpt-4o

# DeepSeek（国内可用，便宜）
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat

# 自定义代理（如您的配置）
OPENAI_BASE_URL=https://ai.tt9.top/v1
OPENAI_MODEL=deepseek-v3.2

# 本地 LLM（LocalAI/vLLM）
OPENAI_BASE_URL=http://localhost:8080/v1
OPENAI_MODEL=llama3-chinese
```

### 性能优化配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `QUEUE_CONCURRENCY` | 16 | 翻译并发数（越高越快但成本越高） |
| `CACHE_TTL_HOURS` | 720 | 缓存有效期（小时，720h=30天） |
| `LRU_MAX_ITEMS` | 1000 | 内存缓存最大条目数 |
| `TRANSLATE_TIMEOUT_MS` | 20000 | 翻译超时时间（毫秒） |

### 字幕分段配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `SEGMENT_GAP_MS` | 1200 | 段落间隙阈值（毫秒） |
| `SEGMENT_MIN_DURATION_MS` | 3000 | 最小段落时长（毫秒） |
| `SEGMENT_MAX_DURATION_MS` | 7000 | 最大段落时长（毫秒） |

### 完整配置示例

```bash
# .env

# 必需配置
OPENAI_API_KEY=sk-qq0gz1lTiLXvawGSMhImDbBY4I4Esuae6xuoCrBXGHvouCfi
OPENAI_BASE_URL=https://ai.tt9.top/v1
OPENAI_MODEL=deepseek-v3.2

# 性能配置（推荐）
QUEUE_CONCURRENCY=16          # 16并发适合生产环境
CACHE_TTL_HOURS=720          # 30天缓存
TRANSLATE_TIMEOUT_MS=20000   # 20秒超时

# 数据库配置
DB_PATH=./data/subtitles.db
DB_VERBOSE=false

# 其他配置保持默认即可
```

---

## 🔌 Loon/圈X 配置

### Loon 配置

```ini
[URL Rewrite]
# 将 YouTube 字幕请求重定向到代理服务器
^https?://.*\.googlevideo\.com/api/timedtext\?(.*)$ http://your-server-ip:12033/api/subtitle?$1 302

[MITM]
hostname = *.googlevideo.com
```

### Quantumult X 配置

```ini
[rewrite_local]
# 将 YouTube 字幕请求重定向到代理服务器
^https?://.*\.googlevideo\.com/api/timedtext\?(.*)$ url 302 http://your-server-ip:12033/api/subtitle?$1

[mitm]
hostname = *.googlevideo.com
```

**注意**:
- 替换 `your-server-ip` 为您的 VPS IP 地址
- 如果使用域名，替换为 `http://your-domain.com:12033`
- 确保 VPS 防火墙开放 12033 端口

---

## 📡 API 接口

### GET /api/subtitle

代理 YouTube 字幕请求并提供 AI 翻译。

**请求参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `v` | string | 是 | YouTube 视频 ID |
| `lang` | string | 是 | 原始语言代码（如 en） |
| `tlang` | string | 否 | 目标语言（默认 zh-CN） |
| `original_url` | string | 否 | 完整的 YouTube API URL |

**响应头**:

| Header | 值 | 说明 |
|--------|-----|------|
| `X-Translation-Status` | pending/completed/failed | 翻译状态 |
| `X-Cache-Status` | HIT/MISS | 缓存状态 |
| `X-Video-Id` | string | 视频 ID |
| `X-Estimated-Time` | number | 预计翻译时间（秒） |

**示例**:

```bash
# 首次请求（返回原字幕）
curl "http://localhost:12033/api/subtitle?v=dQw4w9WgXcQ&lang=en&tlang=zh-CN"

# 第二次请求（返回双语字幕，< 2ms）
curl "http://localhost:12033/api/subtitle?v=dQw4w9WgXcQ&lang=en&tlang=zh-CN"
```

### GET /health

健康检查接口。

**响应**:

```json
{
  "status": "ok",
  "database": "connected",
  "cache": {
    "hits": 100,
    "misses": 10,
    "hitRate": 0.909
  },
  "queue": {
    "pending": 0,
    "processing": 1,
    "failed": 0
  },
  "uptime": 3600.5
}
```

### GET /admin/stats

管理统计接口（可选 token 保护）。

**响应**:

```json
{
  "statistics": {
    "total_jobs": 150,
    "completed_jobs": 145,
    "pending_jobs": 2,
    "failed_jobs": 3
  },
  "recentJobs": [
    {
      "id": "uuid",
      "video_id": "dQw4w9WgXcQ",
      "lang": "en",
      "status": "done",
      "created_at": 1769732082533
    }
  ]
}
```

---

## 🎯 工作流程

```
┌─────────────────────────────────────────┐
│ 1. 用户首次请求                          │
│    GET /api/subtitle?v=xxx&lang=en       │
└────────────┬────────────────────────────┘
             │
             ▼
┌────────────────────────────────────────┐
│ 2. 检查缓存（LRU + SQLite）              │
│    └─ 缓存未命中                         │
└────────────┬───────────────────────────┘
             │
             ▼
┌────────────────────────────────────────┐
│ 3. 获取 YouTube 原字幕（< 1s）           │
└────────────┬───────────────────────────┘
             │
             ▼
┌────────────────────────────────────────┐
│ 4. 立即返回原字幕（< 2s）                 │
│    X-Translation-Status: pending         │
└────────────────────────────────────────┘
             ┃ 后台异步
             ▼
┌────────────────────────────────────────┐
│ 5. 段落切分（1282个→406段）              │
│ 6. GPT-4o 批量翻译（16并发）             │
│ 7. 双语合并（原文\n译文）                 │
│ 8. WebVTT 渲染                          │
│ 9. 写入缓存（LRU + SQLite）              │
└────────────────────────────────────────┘
             │ ~54秒
             ▼
┌────────────────────────────────────────┐
│ 10. 用户第二次请求（< 2ms）               │
│     X-Translation-Status: completed      │
│     返回双语字幕                          │
└────────────────────────────────────────┘
```

---

## 📊 性能指标

| 指标 | 目标值 | 实际表现 |
|------|--------|---------|
| 首次响应（缓存未命中） | < 2s | ✅ 立即返回 |
| 缓存响应（缓存命中） | < 200ms | ✅ **1.6ms** |
| 翻译完成时间 | < 60s | ✅ 54秒（406段） |
| 并发翻译 | 16任务 | ✅ 已实现 |
| 缓存 TTL | 30天 | ✅ 已实现 |

---

## 🛠️ 故障排查

### 1. 服务无法启动

```bash
# 检查端口是否被占用
sudo lsof -i :12033

# 查看服务日志
docker-compose logs -f

# 检查配置文件
cat .env
```

### 2. 翻译失败

**症状**: `X-Translation-Status: failed`

**检查**:
1. API 密钥是否正确
2. API 端点是否可访问
3. 查看服务器日志: `docker-compose logs -f`

### 3. 连接超时

**症状**: `Translation failed: timeout`

**解决**:
```bash
# 增加超时时间
TRANSLATE_TIMEOUT_MS=30000
```

### 4. 缓存未命中

**检查**:
```bash
# 进入容器
docker-compose exec youtube-subtitle-proxy sh

# 检查数据库
ls -lh /app/data/subtitles.db

# 查看缓存统计
curl http://localhost:12033/health
```

---

## 📁 项目结构

```
youtube-subtitle-proxy/
├── src/
│   ├── config/env.ts          # 环境配置
│   ├── db/
│   │   ├── schema.sql         # 数据库 Schema
│   │   └── sqlite.ts          # 数据库连接
│   ├── http/
│   │   ├── server.ts          # HTTP 服务器
│   │   └── routes.ts          # API 路由
│   ├── queue/queue.ts         # 翻译队列
│   ├── services/
│   │   ├── youtube.ts         # YouTube 字幕服务
│   │   ├── translator.ts      # OpenAI 翻译
│   │   └── cache.ts           # 缓存服务
│   ├── subtitle/
│   │   ├── parse.ts           # 字幕解析
│   │   ├── segment.ts         # 段落切分
│   │   └── render.ts          # WebVTT 渲染
│   └── types/subtitle.ts      # 类型定义
├── docs/
│   ├── backend-architecture.md        # 后端架构
│   ├── frontend-config.md             # 前端配置
│   └── openai-endpoint-config.md      # OpenAI 端点配置
├── Dockerfile                  # Docker 镜像
├── docker-compose.yml          # Docker Compose 配置
├── .env.production.example     # 生产环境配置模板（复制为 .env）
└── README.md                   # 本文档
```

---

## 🔐 安全建议

1. **API 密钥保护**:
- 不要将 `.env` 提交到 Git
   - 使用环境变量或密钥管理服务

2. **管理接口保护**:
   ```bash
   # 设置管理令牌
   ADMIN_TOKEN=your-secure-random-token

   # 访问时带上令牌
   curl -H "Authorization: Bearer your-token" http://localhost:12033/admin/stats
   ```

3. **反向代理**（推荐）:
   ```nginx
   # Nginx 配置
   server {
       listen 80;
       server_name subtitle.yourdomain.com;

       location / {
           proxy_pass http://localhost:12033;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }
   ```

4. **HTTPS 配置**（推荐）:
   ```bash
   # 使用 Let's Encrypt
   sudo certbot --nginx -d subtitle.yourdomain.com
   ```

---

## 💰 成本优化

### 1. 使用更便宜的模型

```bash
# GPT-4o mini（便宜50%）
OPENAI_MODEL=gpt-4o-mini

# DeepSeek（更便宜）
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
```

### 2. 调整并发数

```bash
# 降低并发减少峰值成本
QUEUE_CONCURRENCY=8
```

### 3. 延长缓存时间

```bash
# 90天缓存，减少重复翻译
CACHE_TTL_HOURS=2160
```

---

## 📚 相关文档

- [完整实施计划](.claude/plan/implementation-plan.md)
- [后端架构设计](docs/backend-architecture.md)
- [Loon/圈X 配置指南](docs/frontend-config.md)
- [OpenAI 端点配置指南](docs/openai-endpoint-config.md)
- [项目完成总结](PROJECT_SUMMARY.md)
- [功能验证报告](VERIFICATION_REPORT.md)

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 许可证

MIT License

---

## 🎉 致谢

本项目使用以下技术构建：
- Node.js + TypeScript
- Hono (HTTP Framework)
- OpenAI API
- SQLite
- Docker

---

**如有问题，请查看 [故障排查](#🛠️-故障排查) 或提交 Issue**
