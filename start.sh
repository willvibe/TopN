#!/usr/bin/env bash
# TopN 评分系统启动脚本
# 从 .env 加载环境变量并在后台启动服务（端口 5678）

set -e
cd "$(dirname "$0")"

# 从 .env 文件加载环境变量（项目未使用 dotenv，需手动注入）
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# 停止已有实例（避免端口占用）
pkill -f "node server/index.js" 2>/dev/null || true
sleep 1

# 后台启动，日志写入 logs/app.log
mkdir -p logs
nohup node server/index.js > logs/app.log 2>&1 &
echo $! > app.pid
echo "TopN 服务已启动，PID: $(cat app.pid)"
echo "访问地址: http://localhost:${PORT:-5678}"
echo "日志文件: logs/app.log"
