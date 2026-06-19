@echo off
chcp 65001 >nul
REM ============================================================
REM  TopN 服务启动脚本 (Windows)
REM  请在下方填入你的数据库连接信息后双击运行, 或在 cmd 中执行
REM ============================================================

REM ===== 数据库配置 (请修改为真实值) =====
set DB_HOST=127.0.0.1
set DB_PORT=3306
set DB_USER=root
set DB_PASSWORD=
set DB_NAME=TopN
set PORT=5678

REM ===== 启动服务 =====
cd /d F:\TopN
echo 正在启动 TopN 评分服务 (端口 5678)...
echo 访问地址: http://localhost:5678
node server/index.js
pause
