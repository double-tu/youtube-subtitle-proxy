#!/bin/bash

echo "======================================"
echo "YouTube 字幕代理 - 故障诊断"
echo "======================================"
echo ""

echo "📋 1. 检查 Docker Compose 配置"
echo "--------------------------------------"
grep -A 2 "ports:" docker-compose.yml
echo ""

echo "📦 2. 检查容器状态"
echo "--------------------------------------"
docker ps -a | grep youtube-subtitle-proxy
echo ""

echo "🔍 3. 检查容器日志（最近 20 行）"
echo "--------------------------------------"
docker logs --tail 20 youtube-subtitle-proxy 2>&1
echo ""

echo "🌐 4. 检查端口监听"
echo "--------------------------------------"
echo "宿主机端口监听："
netstat -tlnp 2>/dev/null | grep ":12033" || ss -tlnp 2>/dev/null | grep ":12033" || echo "未找到 12033 端口监听"
echo ""
echo "Docker 容器端口映射："
docker port youtube-subtitle-proxy 2>/dev/null || echo "容器不存在或未运行"
echo ""

echo "💾 5. 检查数据目录"
echo "--------------------------------------"
ls -la ./data/ 2>/dev/null || echo "数据目录不存在"
echo ""

echo "🔐 6. 检查环境变量"
echo "--------------------------------------"
if [ -f .env ]; then
    echo "✅ .env 文件存在"
    echo "OPENAI_API_KEY: $(grep OPENAI_API_KEY .env | cut -d'=' -f2 | head -c 20)..."
else
    echo "❌ .env 文件不存在"
fi
echo ""

echo "🧪 7. 尝试连接测试"
echo "--------------------------------------"
echo "测试端口 12033..."
timeout 2 bash -c "echo > /dev/tcp/localhost/12033" 2>&1 && echo "✅ 端口 12033 可访问" || echo "❌ 端口 12033 无法访问"
echo ""

echo "======================================"
echo "诊断完成"
echo "======================================"
