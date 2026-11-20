#!/bin/bash
# Render 启动脚本（免费 512Mi 实例）
#
# 架构要点：
# 1. 前端静态服务器（start-prod.cjs）是主进程：一直在线；前端自带完整离线兜底
#    （localStorage 注册 / 转账记录 / 通知），纯前端即可跑通全部演示流程。
# 2. 后端 api-server（pglite WASM）默认关闭：实测两个 Node 进程 + WASM 数据库
#    在免费 512Mi 上会被 cgroup OOM Kill 并连带整站 502。需要服务端持久化时，
#    升级付费实例或拆成两个独立免费服务，再把 BACKEND_ENABLED 置为 true。
# 3. 后端开启时由守护循环托管：崩溃自动重启；WALLET_ID_PEPPER / WALLET_ENCRYPTION_KEY
#    缺失则启动时生成（数据在 /tmp，重启即清空，换新密钥不会遗留密文问题）。

set -u

RENDER_PORT="${PORT:-10000}"
# 免费层默认关后端；Render 面板或环境变量置 "true" 可开启（需更大内存）。
BACKEND_ENABLED="${BACKEND_ENABLED:-false}"

# ── 钱包数据库所需密钥（仅后端开启时生成，缺失则启动时生成演示值）──
if [ "$BACKEND_ENABLED" = "true" ]; then
  if [ -z "${WALLET_ID_PEPPER:-}" ]; then
    export WALLET_ID_PEPPER="boot-pepper-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  fi
  if [ -z "${WALLET_ENCRYPTION_KEY:-}" ]; then
    export WALLET_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  fi
fi

# ── 前端静态服务器（主进程，常驻）──
PORT="$RENDER_PORT" node start-prod.cjs &
FRONTEND_PID=$!
echo "[start-render] frontend started (pid $FRONTEND_PID, port $RENDER_PORT, backend=${BACKEND_ENABLED})"

BACKEND_SUPERVISOR=""

if [ "$BACKEND_ENABLED" = "true" ]; then
  # 守护子循环：后端退出 5 秒后自动重启；本循环被杀时由 cleanup 统一清理 node 进程。
  # 注意：直接在子 shell 内启动后台任务并用 $! 取 PID，避免命令替换吞掉 node 日志。
  (
    while true; do
      PORT=5200 \
      DATABASE_URL=pglite: \
      WALLET_PGDATA=/tmp/.wallet-pglite \
      PAYWAY_MODE=mock \
      BAKONG_MODE=mock \
      NODE_ENV=production \
      NODE_OPTIONS="--max-old-space-size=280" \
      node artifacts/api-server/dist/index.mjs &
      BPID=$!
      echo "[start-render] backend api-server started (pid $BPID, port 5200)"
      wait "$BPID"
      RC=$?
      echo "[start-render] backend exited (rc=$RC); restart in 5s"
      sleep 5
    done
  ) &
  BACKEND_SUPERVISOR=$!
  echo "[start-render] backend supervisor pid $BACKEND_SUPERVISOR"
else
  echo "[start-render] BACKEND_ENABLED != true; backend skipped (frontend offline fallback active)"
fi

cleanup() {
  echo "[start-render] shutting down"
  kill "$FRONTEND_PID" 2>/dev/null
  if [ -n "$BACKEND_SUPERVISOR" ]; then
    kill "$BACKEND_SUPERVISOR" 2>/dev/null
  fi
  pkill -f "artifacts/api-server/dist/index.mjs" 2>/dev/null
}
trap cleanup EXIT INT TERM

# 主进程只等前端；后端崩溃由守护循环处理，不影响整站
wait "$FRONTEND_PID"
echo "[start-render] frontend exited; container will restart"
exit 0
