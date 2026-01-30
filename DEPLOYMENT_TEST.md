# 部署功能验证指南

## 📋 测试环境

- **本地 VPS**: `http://localhost:3000`
- **Nginx 反向代理**: `https://subtitle.t22.top`
- **视频测试样例**: `dQw4w9WgXcQ` (Rick Astley - Never Gonna Give You Up)

---

## ✅ 第一步：VPS 本地测试

在你的 VPS 服务器上执行以下命令：

### 1. 健康检查

```bash
# 测试服务是否正常运行
curl -s http://localhost:3000/health | jq '.'
```

**预期输出**：
```json
{
  "status": "ok",
  "database": "connected",
  "cache": {
    "hits": 0,
    "misses": 0,
    "hitRate": 0
  },
  "queue": {
    "pending": 0,
    "processing": 0,
    "failed": 0
  },
  "uptime": 123.456
}
```

### 2. 字幕 API 测试（快速检查）

```bash
# 测试获取原始字幕（无翻译，返回很快）
curl -s "http://localhost:3000/api/subtitle?v=dQw4w9WgXcQ&lang=en&fmt=json3" \
  -w "\n\n状态码: %{http_code}\n响应时间: %{time_total}s\n" \
  | head -n 20
```

**预期结果**：
- 状态码: `200`
- 响应时间: `< 5s`
- 响应头包含:
  - `X-Translation-Status: pending` (首次请求，翻译进行中)
  - `X-Cache-Status: MISS` (缓存未命中)
  - `X-Video-Id: dQw4w9WgXcQ`

### 3. 字幕 API 测试（等待翻译）

```bash
# 等待 60 秒后再次请求，应该返回翻译后的字幕
echo "⏳ 等待 60 秒让翻译任务完成..."
sleep 60

# 再次请求相同字幕
curl -s "http://localhost:3000/api/subtitle?v=dQw4w9WgXcQ&lang=en&fmt=json3" \
  -i | grep -E "(HTTP|X-Translation-Status|X-Cache-Status)" | head -n 5
```

**预期结果**：
```
HTTP/1.1 200 OK
X-Translation-Status: completed
X-Cache-Status: HIT
```

### 4. 管理统计测试（需要配置 ADMIN_TOKEN）

```bash
# 检查是否配置了管理员令牌
grep ADMIN_TOKEN .env

# 如果有令牌，测试管理接口
ADMIN_TOKEN="your-admin-token-here"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3000/admin/stats | jq '.'
```

---

## 🌐 第二步：Nginx 反向代理测试

### 1. 健康检查（远程）

```bash
# 从任何地方执行（包括你的本地机器）
curl -s https://subtitle.t22.top/health | jq '.'
```

**预期输出**：与本地测试相同的 JSON 响应

### 2. 字幕 API 测试（HTTPS）

```bash
# 测试获取字幕（首次请求）
curl -s "https://subtitle.t22.top/api/subtitle?v=dQw4w9WgXcQ&lang=en&tlang=zh-CN&fmt=json3" \
  -w "\n\n状态码: %{http_code}\n响应时间: %{time_total}s\n" \
  -o /dev/null
```

**预期结果**：
- 状态码: `200`
- 响应时间: `< 5s`（首次请求）
- HTTPS 连接正常

### 3. 完整功能测试（双语字幕）

```bash
# 完整的 YouTube 字幕代理请求
VIDEO_ID="dQw4w9WgXcQ"
LANG="en"
TLANG="zh-CN"

echo "🎬 测试视频: https://www.youtube.com/watch?v=$VIDEO_ID"
echo "🌍 翻译: $LANG → $TLANG"
echo ""

# 第一次请求（触发翻译）
echo "📝 首次请求（触发翻译任务）..."
curl -s "https://subtitle.t22.top/api/subtitle?v=$VIDEO_ID&lang=$LANG&tlang=$TLANG&fmt=json3" \
  -I | grep -E "(HTTP|X-Translation|X-Cache|X-Video)"

# 等待翻译完成
echo ""
echo "⏳ 等待 60 秒让翻译完成..."
sleep 60

# 第二次请求（从缓存获取）
echo ""
echo "🎯 第二次请求（应该命中缓存）..."
curl -s "https://subtitle.t22.top/api/subtitle?v=$VIDEO_ID&lang=$LANG&tlang=$TLANG&fmt=json3" \
  -I | grep -E "(HTTP|X-Translation|X-Cache|X-Video)"
```

---

## 🔍 第三步：Nginx 配置验证

在 VPS 上检查 Nginx 配置：

```bash
# 查看 Nginx 配置
sudo cat /etc/nginx/sites-enabled/subtitle.t22.top

# 测试配置是否正确
sudo nginx -t

# 查看 Nginx 日志
sudo tail -f /var/log/nginx/access.log
```

**期望的 Nginx 配置**：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name subtitle.t22.top;

    # 重定向到 HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name subtitle.t22.top;

    # SSL 证书
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # 反向代理到 Docker 容器
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时配置（字幕翻译可能需要较长时间）
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 90s;
    }
}
```

---

## 🧪 第四步：常见测试场景

### 场景 1: 测试不同语言对

```bash
# 英文 → 中文（简体）
curl -s "https://subtitle.t22.top/api/subtitle?v=dQw4w9WgXcQ&lang=en&tlang=zh-CN" -I

# 英文 → 日文
curl -s "https://subtitle.t22.top/api/subtitle?v=dQw4w9WgXcQ&lang=en&tlang=ja" -I

# 西班牙文 → 英文
curl -s "https://subtitle.t22.top/api/subtitle?v=VIDEO_ID&lang=es&tlang=en" -I
```

### 场景 2: 测试错误处理

```bash
# 无效的视频 ID
curl -s "https://subtitle.t22.top/api/subtitle?v=invalid&lang=en" | jq '.'
# 预期: {"error": "invalid_video_id", "message": "Invalid or missing video ID"}

# 缺少参数
curl -s "https://subtitle.t22.top/api/subtitle?v=dQw4w9WgXcQ" | jq '.'
# 预期: {"error": "invalid_language", "message": "Invalid or missing language code"}
```

### 场景 3: 测试缓存命中

```bash
# 连续请求 3 次相同字幕，观察缓存状态
for i in {1..3}; do
  echo "请求 $i:"
  curl -s "https://subtitle.t22.top/api/subtitle?v=dQw4w9WgXcQ&lang=en&tlang=zh-CN" \
    -I | grep "X-Cache-Status"
  sleep 1
done
```

**预期输出**：
```
请求 1: X-Cache-Status: MISS
请求 2: X-Cache-Status: MISS (翻译进行中)
请求 3: X-Cache-Status: HIT (翻译完成，命中缓存)
```

### 场景 4: 性能测试

```bash
# 使用 Apache Bench 测试并发性能
ab -n 100 -c 10 "https://subtitle.t22.top/health"

# 或使用 curl 测试响应时间
for i in {1..5}; do
  curl -w "请求 $i - 响应时间: %{time_total}s\n" \
    -o /dev/null -s "https://subtitle.t22.top/health"
done
```

---

## 📊 第五步：监控和日志

### Docker 容器日志

```bash
# 实时查看应用日志
docker logs -f youtube-subtitle-proxy

# 查看最近 100 行日志
docker logs --tail 100 youtube-subtitle-proxy

# 查看错误日志
docker logs youtube-subtitle-proxy 2>&1 | grep -i error
```

### 数据库检查

```bash
# 进入容器
docker exec -it youtube-subtitle-proxy sh

# 查看 SQLite 数据库
sqlite3 /app/data/cache.db "SELECT COUNT(*) FROM caption_jobs;"
sqlite3 /app/data/cache.db "SELECT status, COUNT(*) FROM caption_jobs GROUP BY status;"

# 退出容器
exit
```

---

## ✅ 验证清单

请依次完成以下验证：

- [ ] **本地健康检查**: `curl http://localhost:3000/health` 返回 200
- [ ] **本地字幕 API**: 首次请求返回原始字幕 (X-Translation-Status: pending)
- [ ] **本地缓存测试**: 60 秒后再次请求，返回翻译字幕 (X-Cache-Status: HIT)
- [ ] **远程健康检查**: `curl https://subtitle.t22.top/health` 返回 200
- [ ] **远程 HTTPS**: SSL 证书有效，无安全警告
- [ ] **远程字幕 API**: 功能与本地一致
- [ ] **Nginx 配置**: 反向代理正确，超时配置合理
- [ ] **错误处理**: 无效参数返回正确的错误信息
- [ ] **Docker 日志**: 无严重错误，翻译任务正常执行
- [ ] **数据持久化**: 重启容器后数据库数据保留

---

## 🚨 故障排查

### 问题 1: 本地可访问，Nginx 无法访问

```bash
# 检查 Nginx 是否运行
sudo systemctl status nginx

# 检查端口监听
sudo netstat -tlnp | grep -E '(3000|80|443)'

# 检查防火墙
sudo ufw status
sudo ufw allow 443/tcp
```

### 问题 2: SSL 证书错误

```bash
# 检查证书有效期
openssl x509 -in /path/to/fullchain.pem -noout -dates

# 重新申请 Let's Encrypt 证书
sudo certbot --nginx -d subtitle.t22.top
```

### 问题 3: 翻译一直 pending

```bash
# 检查 OpenAI API 配置
docker exec youtube-subtitle-proxy env | grep OPENAI

# 检查翻译队列
docker logs youtube-subtitle-proxy | grep -i "translation"

# 手动测试 OpenAI API
docker exec youtube-subtitle-proxy node -e "
const openai = require('openai');
console.log('Testing OpenAI connection...');
"
```

### 问题 4: 容器频繁重启

```bash
# 查看容器状态
docker ps -a | grep youtube-subtitle-proxy

# 查看退出原因
docker inspect youtube-subtitle-proxy | jq '.[0].State'

# 检查内存和资源
docker stats youtube-subtitle-proxy
```

---

## 📞 技术支持

如果遇到问题：

1. 收集日志: `docker logs youtube-subtitle-proxy > debug.log`
2. 检查配置: `docker exec youtube-subtitle-proxy cat /app/.env`
3. 查看数据库: `docker exec youtube-subtitle-proxy sqlite3 /app/data/cache.db ".tables"`
4. 提供信息:
   - 错误日志
   - curl 命令和响应
   - Nginx 配置
   - Docker 版本和系统信息

---

## 🎉 成功标志

当所有测试通过后，你应该能够：

1. ✅ 通过 HTTPS 访问服务（无证书警告）
2. ✅ 获取 YouTube 字幕并自动翻译
3. ✅ 翻译结果被缓存，第二次请求极快（< 0.5s）
4. ✅ 健康检查返回正常状态
5. ✅ 容器稳定运行，日志无错误
6. ✅ 数据持久化（重启后缓存仍存在）

**祝贺你成功部署 YouTube 双语字幕代理服务！** 🚀
