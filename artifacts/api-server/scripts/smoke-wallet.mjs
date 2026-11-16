#!/usr/bin/env node
/**
 * 钱包接口冒烟测试（阶段五）—— 直接打 HTTP，不依赖任何测试框架。
 *
 * 用法（两种数据库驱动都可以）：
 *   # A. 嵌入式 PGlite（零安装，本地演示）
 *   cd artifacts/api-server
 *   PORT=5200 WALLET_DB_DRIVER=pglite WALLET_PGDATA=/tmp/wallet-pglite \
 *     node --import tsx src/index.ts &
 *
 *   # B. 真实 PostgreSQL
 *   DATABASE_URL=postgresql://... node --import tsx src/index.ts &
 *
 *   # 然后跑冒烟：
 *   node scripts/smoke-wallet.mjs [baseUrl]
 *
 * 覆盖：手机号未注册拦截、注册/登录、幂等重放、充值入账、重复回调不重复入账、
 *       提现冻结与结算、转账、账本借贷平衡、管理员对账 0 差异。
 */
const BASE = (process.argv[2] || process.env.WALLET_API_BASE || "http://localhost:5200/api").replace(/\/$/, "");

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function call(method, path, { body, headers = {}, token, idem } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (idem) h["Idempotency-Key"] = idem;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, data };
}

const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const DEMO_PHONE = "+855 097 993 5561";
const PASSWORD = "Smoke#2026";

async function main() {
  console.log(`\n── 钱包接口冒烟 @ ${BASE}\n`);

  /* 1. 健康检查 */
  const health = await call("GET", "/healthz");
  ok("健康检查 /healthz", health.status === 200 && health.data?.status === "ok", `HTTP ${health.status}`);

  /* 2. 手机号未注册 → 404 + 固定文案（用户需求的核心规则） */
  const stranger = `011${Math.floor(Math.random() * 10000000).toString().padStart(7, "0")}`;
  const notRegistered = await call("POST", "/wallet/auth/phone-check", { body: { phone: stranger } });
  ok(
    "未注册手机号被拦截（404 PHONE_NOT_REGISTERED）",
    notRegistered.status === 404 && notRegistered.data?.code === "PHONE_NOT_REGISTERED",
    `HTTP ${notRegistered.status} ${notRegistered.data?.code}`,
  );
  ok(
    "返回用户要求的那句话",
    String(notRegistered.data?.message || "").includes("还没注册本银行使用"),
    String(notRegistered.data?.message || "").slice(0, 40),
  );

  const loginStranger = await call("POST", "/wallet/auth/login", {
    body: { phone: stranger, password: PASSWORD },
  });
  ok(
    "未注册手机号无法登录（404）",
    loginStranger.status === 404 && loginStranger.data?.code === "PHONE_NOT_REGISTERED",
    `HTTP ${loginStranger.status}`,
  );

  /* 3. 注册（证件号必填：缺证件号必须被拒） */
  const noId = await call("POST", "/wallet/auth/register", {
    body: { phone: `+855 09${Math.floor(1000000 + Math.random() * 8999999)}`, password: PASSWORD, fullName: "NO ID USER" },
  });
  ok(
    "注册缺证件号 → 被拒（开户必须完成身份证信息）",
    noId.status === 422 || noId.status === 400,
    `HTTP ${noId.status} ${noId.data?.code ?? ""}`,
  );

  const phone = `+855 09${Math.floor(1000000 + Math.random() * 8999999)}`;
  const reg = await call("POST", "/wallet/auth/register", {
    body: {
      phone: DEMO_PHONE,
      password: PASSWORD,
      fullName: "CHHENG BONNY",
      nationalIdNo: `49399${Math.floor(100000 + Math.random() * 899999)}`,
      currencies: ["USD", "KHR"],
    },
  });
  const registeredNow = reg.status === 201 || reg.data?.code === "PHONE_ALREADY_REGISTERED";
  ok("注册演示手机号（重复注册则视为已存在）", registeredNow, `HTTP ${reg.status} ${reg.data?.code ?? ""}`);
  const token = reg.data?.token;

  const phoneCheck = await call("POST", "/wallet/auth/phone-check", { body: { phone: DEMO_PHONE } });
  ok(
    "已注册手机号放行（registered=true）",
    phoneCheck.status === 200 && phoneCheck.data?.registered === true,
    `HTTP ${phoneCheck.status} registered=${phoneCheck.data?.registered}`,
  );

  /* 4. 登录 */
  const login = await call("POST", "/wallet/auth/login", {
    body: { phone: DEMO_PHONE, password: PASSWORD },
  });
  ok("登录成功拿到 token", login.status === 200 && Boolean(login.data?.token), `HTTP ${login.status}`);
  const userToken = login.data?.token || token;
  if (!userToken) throw new Error("拿不到 token，后续用例无法继续");

  const badLogin = await call("POST", "/wallet/auth/login", {
    body: { phone: DEMO_PHONE, password: "wrong-password" },
  });
  ok("密码错误 → 401 BAD_PASSWORD", badLogin.status === 401 && badLogin.data?.code === "BAD_PASSWORD", `HTTP ${badLogin.status}`);

  const me = await call("GET", "/wallet/me", { token: userToken });
  const wallets = me.data?.wallets ?? [];
  ok("GET /me 返回 USD/KHR 两个钱包", me.status === 200 && wallets.length >= 2, `wallets=${wallets.length}`);
  const usd = wallets.find((w) => w.asset === "USD");
  if (!usd) throw new Error("没有 USD 钱包");
  // 起始余额（脚本可重复跑：断言按增量计算，不写死 0）
  const startBal = Number(usd.balance ?? 0);

  /* 5. 充值 + 幂等重放 */
  const idem = `smoke-${rnd()}-${Date.now()}`;
  const dep = await call("POST", "/wallet/deposits", {
    token: userToken,
    idem,
    body: { asset: "USD", amount: "100.00", description: "smoke deposit" },
  });
  ok("创建充值单（201）", dep.status === 201 && Boolean(dep.data?.txNo), `HTTP ${dep.status} ${dep.data?.txNo ?? dep.data?.code}`);

  const depAgain = await call("POST", "/wallet/deposits", {
    token: userToken,
    idem,
    body: { asset: "USD", amount: "100.00", description: "smoke deposit" },
  });
  ok(
    "同 Idempotency-Key 重放 → 同一单号（不重复开单）",
    depAgain.data?.txNo === dep.data?.txNo,
    `${dep.data?.txNo} vs ${depAgain.data?.txNo}`,
  );

  const depConfirm = await call("POST", `/wallet/deposits/${dep.data.txNo}/confirm`, {
    body: { amount: "100.00", providerRef: "SMOKE-REF-1" },
  });
  ok("渠道回调入账 → succeeded", depConfirm.status === 200 && depConfirm.data?.status === "succeeded", `HTTP ${depConfirm.status} ${depConfirm.data?.status}`);

  const depConfirmAgain = await call("POST", `/wallet/deposits/${dep.data.txNo}/confirm`, {
    body: { amount: "100.00", providerRef: "SMOKE-REF-1" },
  });
  ok(
    "重复回调 → 幂等返回 succeeded（不重复入账）",
    depConfirmAgain.data?.status === "succeeded",
    `HTTP ${depConfirmAgain.status}`,
  );

  const afterDeposit = await call("GET", "/wallet/wallets", { token: userToken });
  const usdAfter = (afterDeposit.data ?? []).find((w) => w.asset === "USD");
  const num = (v) => Number(v ?? NaN);
  ok(
    `充值后余额 = 起始 + 100（${startBal} → ${usdAfter?.balance}）`,
    num(usdAfter?.balance) === startBal + 100,
    `balance=${usdAfter?.balance}`,
  );

  /* 6. 提现：创建即冻结，确认才真正出款 */
  const wd = await call("POST", "/wallet/withdrawals", {
    token: userToken,
    idem: `smoke-wd-${rnd()}`,
    body: { asset: "USD", amount: "30.00", feeAmount: "1.00", destination: { type: "bank", account: "016 681 281" } },
  });
  ok("创建提现单（201）", wd.status === 201 && Boolean(wd.data?.txNo), `HTTP ${wd.status}`);

  const midWallets = await call("GET", "/wallet/wallets", { token: userToken });
  const usdMid = (midWallets.data ?? []).find((w) => w.asset === "USD");
  ok(
    `冻结后余额不变、可用减少（${startBal + 100} / 可用 ${startBal + 69}）`,
    num(usdMid?.balance) === startBal + 100 && num(usdMid?.available) === startBal + 69,
    `balance=${usdMid?.balance} locked=${usdMid?.locked} available=${usdMid?.available}`,
  );

  const wdConfirm = await call("POST", `/wallet/withdrawals/${wd.data.txNo}/confirm`, {});
  ok("提现出款结算 → succeeded", wdConfirm.status === 200 && wdConfirm.data?.status === "succeeded", `HTTP ${wdConfirm.status} ${wdConfirm.data?.status}`);

  const afterWd = await call("GET", "/wallet/wallets", { token: userToken });
  const usdWd = (afterWd.data ?? []).find((w) => w.asset === "USD");
  ok(
    `提现后余额 = 起始 + 69（100 - 30 - 手续费 1）`,
    num(usdWd?.balance) === startBal + 69 && num(usdWd?.locked) === 0,
    `balance=${usdWd?.balance} locked=${usdWd?.locked} expect=${startBal + 69}`,
  );

  /* 7. 转账（第二个用户） */
  const phone2 = `+855 09${Math.floor(1000000 + Math.random() * 8999999)}`;
  const reg2 = await call("POST", "/wallet/auth/register", {
    body: {
      phone: phone2,
      password: PASSWORD,
      fullName: "SMOKE PAYEE",
      nationalIdNo: `49399${Math.floor(100000 + Math.random() * 899999)}`,
      currencies: ["USD"],
    },
  });
  ok("注册收款方", reg2.status === 201, `HTTP ${reg2.status}`);
  const me2 = await call("GET", "/wallet/me", { token: reg2.data?.token });
  const usd2 = (me2.data?.wallets ?? []).find((w) => w.asset === "USD");

  const tr = await call("POST", "/wallet/transfers", {
    token: userToken,
    idem: `smoke-tr-${rnd()}`,
    body: { asset: "USD", amount: "10.00", feeAmount: "0.50", toWalletId: usd2.walletId, note: "smoke" },
  });
  ok("创建转账单（201）", tr.status === 201 && Boolean(tr.data?.txNo), `HTTP ${tr.status} ${tr.data?.code ?? ""}`);

  const trConfirm = await call("POST", `/wallet/transfers/${tr.data.txNo}/confirm`, {});
  ok("转账结算 → succeeded", trConfirm.status === 200 && trConfirm.data?.status === "succeeded", `HTTP ${trConfirm.status}`);

  const afterTr1 = await call("GET", "/wallet/wallets", { token: userToken });
  const afterTr2 = await call("GET", "/wallet/wallets", { token: reg2.data.token });
  const a1 = (afterTr1.data ?? []).find((w) => w.asset === "USD");
  const a2 = (afterTr2.data ?? []).find((w) => w.asset === "USD");
  ok(
    `付方余额 = 起始 + 58.50（${startBal + 58.5}）`,
    num(a1?.balance) === startBal + 58.5,
    `balance=${a1?.balance}`,
  );
  ok("收方余额 = 10.00（新账号从 0 开始）", num(a2?.balance) === 10, `balance=${a2?.balance}`);

  /* 8. 账本查询（资金变化的唯一依据） */
  const ledger = await call("GET", `/wallet/ledger?walletId=${usd.walletId}&limit=100`, { token: userToken });
  const entries = ledger.data?.entries ?? [];
  ok("账本流水可查询", ledger.status === 200 && entries.length > 0, `entries=${entries.length}`);
  const sum = entries.reduce(
    (acc, e) => acc + (e.direction === "credit" ? Number(e.amount) : -Number(e.amount)),
    0,
  );
  // 账本净额必须等于当前余额（账本是资金变化唯一依据，含历史全部分录）
  ok(
    `账本按钱包借贷净额 = 余额（${sum} vs ${a1?.balance}）`,
    Math.abs(sum - num(a1?.balance)) < 1e-9,
    `sum=${sum}`,
  );
  ok("每条分录都能追溯到业务单号", entries.every((e) => Boolean(e.txNo)), `sample=${entries[0]?.txNo}`);

  const detail = await call("GET", `/wallet/transactions/${tr.data.txNo}`, { token: userToken });
  ok("单据详情含状态事件与分录", (detail.data?.events?.length ?? 0) > 0 && (detail.data?.entries?.length ?? 0) >= 2,
    `events=${detail.data?.events?.length} entries=${detail.data?.entries?.length}`);

  /* 9. 管理端对账：余额快照 vs 账本汇总必须 0 差异 */
  const recon = await call("POST", "/wallet/admin/reconciliations", {
    body: { asset: "USD" },
    headers: { "X-Admin-Key": process.env.WALLET_ADMIN_KEY || "" },
  });
  ok("对账批次生成", recon.status === 201 && Boolean(recon.data?.runId), `HTTP ${recon.status} ${recon.data?.code ?? ""}`);
  ok("对账 0 差异（mismatch_count=0）", recon.data?.mismatchCount === 0,
    `mismatch=${recon.data?.mismatchCount} wallets=${recon.data?.walletCount}`);

  /* 10. 审计留痕 */
  const audit = await call("GET", "/wallet/admin/audit-logs?limit=50", {
    headers: { "X-Admin-Key": process.env.WALLET_ADMIN_KEY || "" },
  });
  ok("审计日志可查询（只读）", audit.status === 200 && Array.isArray(audit.data), `rows=${audit.data?.length ?? 0}`);

  /* 11. 未授权访问被拒 */
  const noAuth = await call("GET", "/wallet/wallets");
  ok("无 token → 401", noAuth.status === 401, `HTTP ${noAuth.status}`);

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
  if (failed > 0) {
    console.log("失败项：\n  - " + failures.join("\n  - "));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n冒烟脚本异常：", err);
  process.exit(1);
});
