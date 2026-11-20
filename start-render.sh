#!/bin/bash
# Render 双进程启动：后端 API (5200) + 前端静态服务器 (Render PORT)
set -e

RENDER_PORT="${PORT:-10000}"

# ── 后端 API 服务器（嵌入式 pglite，mock 支付渠道）──
PORT=5200 \
DATABASE_URL=pglite: \
WALLET_PGDATA=/tmp/.wallet-pglite \
PAYWAY_MODE=mock \
BAKONG_MODE=mock \
NODE_ENV=production \
  node artifacts/api-server/dist/index.mjs &
BACKEND_PID=$!
echo "[start-render] backend api-server started (pid $BACKEND_PID, port 5200)"

# 等后端就绪（最多 15 秒）
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:5200/api/health >/dev/null 2>&1; then
    echo "[start-render] backend health check OK after ${i}s"
    break
  fi
  sleep 0.5
done

# ── 前端静态服务器 + /api 代理（→ 127.0.0.1:5200）──
PORT="$RENDER_PORT" node start-prod.cjs &
FRONTEND_PID=$!
echo "[start-render] frontend started (pid $FRONTEND_PID, port $RENDER_PORT)"

# 任一进程退出则终止另一个，让 Render 自动重启
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait -n
exit $?
