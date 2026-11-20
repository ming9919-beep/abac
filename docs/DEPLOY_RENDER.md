# Deploy 到 Render.com

仓库：`https://github.com/ming9919-beep/abac`，分支 `main`。
线上服务：`abac-wallet` → **https://abac-wallet.onrender.com**
（旧域名 `https://aba001.onrender.com` 已无对应服务，访问会返回
`x-render-routing: no-server` 的 404，不要再测这个地址。）

## 一次配置

1. 打开 https://dashboard.render.com/ → **New** → **Blueprint**（或用 API 创建 Web Service）
2. 选仓库 `ming9919-beep/abac`，分支 `main`
3. Render 读到 `render.yaml` 后点 **Apply**，等 2–4 分钟首次构建
4. 构建命令：
   `corepack enable && pnpm install --no-frozen-lockfile && PORT=5173 BASE_PATH=/ pnpm build && pnpm --filter @workspace/api-server build`
   前端产物 `dist/public`；后端产物 `artifacts/api-server/dist/index.mjs`
5. 启动命令：`bash start-render.sh`；健康检查路径 `/api/health`

## 进程架构（start-render.sh）

- **前端 `start-prod.cjs` 是主进程**：静态资源 + SPA 回退 + `/api/*` 代理，常驻不退出。
- **后端 api-server 由守护循环托管**：崩溃/OOM 后 5 秒自动重启，不会拖垮前端。
- `BACKEND_ENABLED=false`（Render 面板环境变量）可完全跳过后端；前端注册、转账记录
  都有 localStorage 离线兜底，演示流程不受影响。
- `WALLET_ID_PEPPER` / `WALLET_ENCRYPTION_KEY` 未配置时启动时自动生成。免费层数据
  在 `/tmp`（实例重启即清空），无需在面板固定密钥。

## 内存与 OOM（免费 512Mi）

- **免费层默认 `BACKEND_ENABLED=false`**：实测 pglite WASM 后端 + 前端两个 Node 进程
  会触发 cgroup `oomKilled`，整站间歇性 502。纯前端模式下注册/转账/通知均走
  localStorage 兜底，演示流程完整可用。
- 后端开启需满足其一：升级付费实例；或拆成两个免费服务（前端服务 + 独立后端服务，
  前端用 `API_UPSTREAM_HOST/PORT` 指向后端公网地址）。
- `db.ts` 已压低 `shared_buffers/work_mem` 等参数、`start-render.sh` 用
  `--max-old-space-size=280` 限制 V8 堆，单后端内存约 370MB（本地实测）。
- 代理 `proxyApi` 带 15 秒超时：后端卡死时快速返回 JSON 502，前端自动走本地兜底。

## 关键点

- **BASE_PATH 必须是 `/`**：GitHub Pages 用 `/ABA001/`，Render 是根域名，两个 base 不通用。
- 免费实例会休眠，首次访问冷启动约 10–30 秒；升级付费版可常驻。
- 每次 push 到 `main`，Render 自动构建部署（Auto-Deploy）；也可在面板 Manual Deploy
  → Clear build cache & Deploy。
- 语音播报：`/api/tts` 代理 Google Translate TTS，不可达时前端回退浏览器 TTS。
