#!/bin/bash

# YouTube 双语字幕代理服务 - 一键部署脚本
# 使用方法: bash deploy.sh

set -e

echo "======================================"
echo "YouTube 双语字幕代理服务 - 一键部署"
echo "======================================"
echo ""

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker 未安装，请先安装 Docker"
    echo "安装命令: curl -fsSL https://get.docker.com | sh"
    exit 1
fi

# 检查 Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose 未安装，请先安装 Docker Compose"
    exit 1
fi

echo "✅ Docker 环境检查通过"
echo ""

# 检查配置文件
if [ ! -f .env ]; then
    echo "📝 未找到 .env 配置文件"
    echo "正在从模板创建..."

    if [ ! -f .env.production.example ]; then
        echo "❌ .env.production.example 文件不存在"
        exit 1
    fi

    cp .env.production.example .env
    echo "✅ 配置文件已创建: .env"
    echo ""
    echo "⚠️  请编辑 .env 文件，配置以下必需项:"
    echo "   1. OPENAI_API_KEY=your-api-key"
    echo "   2. OPENAI_BASE_URL=your-api-endpoint (可选)"
    echo "   3. OPENAI_MODEL=your-model (可选)"
    echo ""
    read -p "是否现在编辑配置文件? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ${EDITOR:-nano} .env
    else
        echo "请手动编辑 .env 后再次运行本脚本"
        exit 0
    fi
fi

# 验证必需配置
source .env
if [ -z "$OPENAI_API_KEY" ] || [ "$OPENAI_API_KEY" = "your-api-key-here" ]; then
    echo "❌ OPENAI_API_KEY 未配置，请编辑 .env"
    exit 1
fi

HOST_PORT=${HOST_PORT:-12033}

echo "✅ 配置文件验证通过"
echo ""

# 创建数据目录
if [ ! -d "data" ]; then
    mkdir -p data
    echo "✅ 数据目录已创建: ./data"
fi

# 询问操作
echo "请选择操作:"
echo "  1) 首次部署 (构建并启动)"
echo "  2) 重新部署 (停止 -> 重新构建 -> 启动)"
echo "  3) 仅启动服务"
echo "  4) 仅停止服务"
echo "  5) 查看服务状态"
echo "  6) 查看日志"
echo "  7) 清理全部缓存 (删除数据库)"
echo "  8) 重启服务 (不构建)"
echo ""
read -p "请输入选项 (1-8): " choice

case $choice in
    1)
        echo ""
        echo "🚀 开始首次部署..."
        docker-compose up -d --build
        echo ""
        echo "✅ 部署完成！"
        ;;
    2)
        echo ""
        echo "🔄 重新部署..."
        docker-compose down
        docker-compose build --no-cache
        docker-compose up -d
        echo ""
        echo "✅ 重新部署完成！"
        ;;
    3)
        echo ""
        echo "▶️  启动服务..."
        docker-compose up -d
        echo ""
        echo "✅ 服务已启动！"
        ;;
    4)
        echo ""
        echo "⏹️  停止服务..."
        docker-compose down
        echo ""
        echo "✅ 服务已停止！"
        ;;
    5)
        echo ""
        docker-compose ps
        exit 0
        ;;
    6)
        echo ""
        echo "📋 实时日志 (Ctrl+C 退出):"
        docker-compose logs -f
        exit 0
        ;;
    7)
        echo ""
        echo "🧹 清理全部缓存（删除数据库卷）..."
        docker-compose down -v
        docker-compose up -d
        echo ""
        echo "✅ 缓存已清理并重启服务！"
        ;;
    8)
        echo ""
        echo "🔁 重启服务..."
        docker-compose restart
        echo ""
        echo "✅ 服务已重启！"
        ;;
    *)
        echo "❌ 无效选项"
        exit 1
        ;;
esac

# 等待服务启动
echo ""
echo "⏳ 等待服务启动..."
sleep 5

# 检查服务状态
echo ""
echo "🔍 检查服务状态..."
if curl -s http://localhost:${HOST_PORT}/health > /dev/null 2>&1; then
    echo "✅ 服务运行正常！"
    echo ""
    echo "📡 服务信息:"
    echo "   - 本地访问: http://localhost:12033"
    echo "   - 健康检查: http://localhost:12033/health"
    echo "   - 管理统计: http://localhost:12033/admin/stats"
    echo ""
    echo "📱 Loon/圈X 配置:"
    echo "   - 服务端口: 12033"
    echo "   - 配置示例: 参见 README.md"
    echo ""
    echo "📋 常用命令:"
    echo "   - 查看日志: docker-compose logs -f"
    echo "   - 重启服务: docker-compose restart"
    echo "   - 停止服务: docker-compose down"
    echo ""

    # 显示健康检查结果
    echo "🏥 健康检查结果:"
    curl -s http://localhost:${HOST_PORT}/health | jq '.' 2>/dev/null || curl -s http://localhost:${HOST_PORT}/health
else
    echo "⚠️  服务可能未正常启动，请检查日志:"
    echo "   docker-compose logs -f"
fi

echo ""
echo "🎉 部署流程完成！"
