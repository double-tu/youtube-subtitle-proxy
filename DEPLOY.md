# VPS 一键部署指南

## 🚀 快速开始（3分钟部署）

### 1. 登录 VPS

```bash
ssh user@your-vps-ip
```

### 2. 安装 Docker（如未安装）

```bash
# 一键安装 Docker
curl -fsSL https://get.docker.com | sh

# 启动 Docker
sudo systemctl start docker
sudo systemctl enable docker

# 安装 Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# 验证安装
docker --version
docker-compose --version
```

### 3. 克隆项目

```bash
# 克隆到 VPS
git clone https://github.com/your-repo/youtube-subtitle-proxy.git
cd youtube-subtitle-proxy
```

### 4. 配置环境

```bash
# 复制配置模板
cp .env.production.example .env.production

# 编辑配置（必需）
nano .env.production
```

**必需配置项**:
```bash
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_BASE_URL=https://ai.tt9.top/v1
OPENAI_MODEL=deepseek-v3.2
```

保存退出：`Ctrl + X` → `Y` → `Enter`

### 5. 一键部署

```bash
# 运行部署脚本
bash deploy.sh

# 选择选项 1: 首次部署
```

### 6. 验证服务

```bash
# 检查服务状态
curl http://localhost:12033/health | jq

# 查看日志
docker-compose logs -f
```

---

## 🔧 常用管理命令

### 服务管理

```bash
# 启动服务
docker-compose up -d

# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 查看状态
docker-compose ps
```

### 日志查看

```bash
# 实时日志
docker-compose logs -f

# 最近100行
docker-compose logs --tail=100

# 只看错误
docker-compose logs | grep ERROR
```

### 更新服务

```bash
# 拉取最新代码
git pull

# 重新部署
bash deploy.sh
# 选择选项 2: 重新部署
```

---

## 🌐 网络配置

### 开放防火墙端口

**UFW（Ubuntu）**:
```bash
sudo ufw allow 12033/tcp
sudo ufw reload
sudo ufw status
```

**Firewalld（CentOS）**:
```bash
sudo firewall-cmd --permanent --add-port=12033/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports
```

**阿里云/腾讯云**:
- 在控制台安全组中添加入站规则
- 端口：12033
- 协议：TCP
- 源地址：0.0.0.0/0

---

## 🔐 反向代理配置（可选）

### Nginx 配置

**1. 安装 Nginx**:
```bash
sudo apt install nginx -y
```

**2. 创建配置文件**:
```bash
sudo nano /etc/nginx/sites-available/subtitle
```

**配置内容**:
```nginx
server {
    listen 80;
    server_name subtitle.yourdomain.com;

    location / {
        proxy_pass http://localhost:12033;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**3. 启用配置**:
```bash
sudo ln -s /etc/nginx/sites-available/subtitle /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

**4. 配置 HTTPS（推荐）**:
```bash
# 安装 Certbot
sudo apt install certbot python3-certbot-nginx -y

# 自动配置 SSL
sudo certbot --nginx -d subtitle.yourdomain.com

# 自动续期
sudo certbot renew --dry-run
```

---

## 📱 Loon/圈X 配置

### 配置 URL Rewrite

**Loon**:
```ini
[URL Rewrite]
^https?://.*\.googlevideo\.com/api/timedtext\?(.*)$ http://your-vps-ip:12033/api/subtitle?$1 302

[MITM]
hostname = *.googlevideo.com
```

**Quantumult X**:
```ini
[rewrite_local]
^https?://.*\.googlevideo\.com/api/timedtext\?(.*)$ url 302 http://your-vps-ip:12033/api/subtitle?$1

[mitm]
hostname = *.googlevideo.com
```

**如果配置了域名和 HTTPS**:
```ini
# 替换为
https://subtitle.yourdomain.com/api/subtitle?$1 302
```

---

## 🛠️ 故障排查

### 问题 1: 服务无法启动

```bash
# 检查端口占用
sudo lsof -i :12033

# 检查 Docker 状态
sudo systemctl status docker

# 查看容器日志
docker-compose logs
```

### 问题 2: 无法访问服务

```bash
# 检查防火墙
sudo ufw status

# 检查服务监听
sudo netstat -tlnp | grep 12033

# 在 VPS 本地测试
curl http://localhost:12033/health
```

### 问题 3: 翻译失败

```bash
# 查看实时日志
docker-compose logs -f | grep Translation

# 检查配置
cat .env.production | grep OPENAI

# 测试 API 连接
curl -X POST https://ai.tt9.top/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model":"deepseek-v3.2","messages":[{"role":"user","content":"test"}]}'
```

### 问题 4: 数据库错误

```bash
# 备份数据库
cp data/subtitles.db data/subtitles.db.backup

# 重建数据库（会清空数据）
rm data/subtitles.db
docker-compose restart
```

---

## 📊 性能监控

### 查看资源占用

```bash
# 容器资源使用
docker stats youtube-subtitle-proxy

# 系统资源
htop
```

### 查看缓存统计

```bash
curl http://localhost:12033/health | jq '.cache'
curl http://localhost:12033/admin/stats | jq
```

### 数据库大小

```bash
ls -lh data/subtitles.db
```

---

## 🔄 定期维护

### 日志清理

```bash
# 清理 Docker 日志
docker-compose down
sudo rm -rf /var/lib/docker/containers/*/*-json.log
docker-compose up -d
```

### 缓存清理

```bash
# 备份数据库
cp data/subtitles.db data/subtitles.db.backup

# 清理过期缓存（在 SQLite 中自动执行）
# 如需手动清理：
docker-compose exec youtube-subtitle-proxy sh -c "sqlite3 /app/data/subtitles.db 'DELETE FROM caption_jobs WHERE created_at < strftime(\"%s\", \"now\", \"-30 days\") * 1000;'"
```

### 更新依赖

```bash
# 拉取最新代码
git pull

# 重新构建（不使用缓存）
docker-compose build --no-cache

# 重启服务
docker-compose up -d
```

---

## 📞 技术支持

如遇问题，请提供以下信息：

1. **系统信息**:
   ```bash
   uname -a
   docker --version
   docker-compose --version
   ```

2. **服务日志**:
   ```bash
   docker-compose logs --tail=100 > logs.txt
   ```

3. **配置信息**（隐藏敏感数据）:
   ```bash
   cat .env.production | grep -v API_KEY
   ```

---

**完成部署后，您可以通过以下方式使用服务**:

- ✅ Loon/圈X 配置 302 重定向
- ✅ 直接 API 调用测试
- ✅ 查看实时翻译日志

祝您使用愉快！🎉
