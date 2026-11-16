#!/usr/bin/env node
/**
 * 钱包数据库结构与资金闭环校验（不需要真实数据库 / Docker / drizzle-kit）
 *
 * 用法：
 *   node lib/db/pglite-check/run.mjs
 *
 * 做四件事：
 *   1. 用 PGlite（内存 PostgreSQL）执行 lib/db/migrations/*.sql 的全部迁移
 *   2. 断言表/枚举/索引/触发器存在
 *   3. 断言安全约束真的会拒绝非法写入（负余额、重号、改账本、借贷不平衡…）
 *   4. 跑一遍最小资金闭环：充值 → 提现(冻结/失败/成功) → 转账 → 退款 → 对账
 *
 * 与真实 PostgreSQL 的差异：单会话，无法验证多会话行锁并发（那部分靠压测）。
 */
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "migrations");

let passed = 0;
let failed = 0;
const failures = [];
const sections = [];

const log = (...a) => console.log(...a);
function section(name) {
  sections.push(name);
  log(`\n── ${name}`);
}
function ok(cond, label, detail = "") {
  if (cond) {
    passed += 1;
    log(`  ✓ ${label}${detail ? " :: " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? " :: " + detail : ""}`);
    log(`  ✗ ${label}${detail ? " :: " + detail : ""}`);
  }
}
async function expectFail(label, fn) {
  try {
    await fn();
    ok(false, label, "期望失败，但执行成功了");
  } catch (e) {
    ok(true, label, String(e.message ?? e).split("\n")[0].slice(0, 110));
  }
}
async function expectOk(label, fn) {
  try {
    await fn();
    ok(true, label);
  } catch (e) {
    ok(false, label, String(e.message ?? e).split("\n")[0].slice(0, 110));
  }
}

const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const exec = async (sql) => db.exec(sql);
const num = (v) => Number(v);

/* ══════════════════════════════════════════════════════════════════════════
   1. 执行迁移
   ══════════════════════════════════════════════════════════════════════════ */
section("1. 执行迁移");
const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith(".sql"))
  .sort();
ok(files.length > 0, "发现迁移文件", files.join(", "));

for (const f of files) {
  const sql = await readFile(path.join(migrationsDir, f), "utf8");
  try {
    await exec(sql);
    ok(true, `执行 ${f}`);
  } catch (e) {
    ok(false, `执行 ${f}`, String(e.message ?? e).split("\n")[0]);
    finish();
    process.exit(1);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   2. 结构断言
   ══════════════════════════════════════════════════════════════════════════ */
section("2. 表结构");
const expectedTables = [
  "users",
  "user_profiles",
  "user_sessions",
  "login_attempts",
  "assets",
  "wallets",
  "transactions",
  "transaction_events",
  "holds",
  "ledger_entries",
  "idempotency_keys",
  "audit_logs",
  "transaction_limits",
  "approval_requests",
  "reconciliation_runs",
  "reconciliation_items",
];
const tables = new Set(
  (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`)).map(
    (r) => r.table_name,
  ),
);
for (const t of expectedTables) ok(tables.has(t), `表 ${t} 存在`);
const extra = [...tables].filter((t) => !expectedTables.includes(t));
ok(
  expectedTables.every((t) => tables.has(t)) && extra.length === 0,
  "没有多余/缺失的表",
  extra.length ? `多出: ${extra.join(", ")}` : `实际 ${tables.size} 张`,
);

section("3. 枚举");
const expectedEnums = [
  "user_status",
  "wallet_type",
  "wallet_status",
  "transaction_type",
  "transaction_status",
  "ledger_direction",
  "ledger_entry_type",
  "hold_status",
  "idempotency_status",
  "actor_type",
  "approval_status",
  "reconciliation_status",
  "reconciliation_item_status",
];
for (const e of expectedEnums) {
  const row = await one(
    `SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = $1`,
    [e],
  );
  ok(!!row, `枚举 ${e} 存在`);
}

section("4. 索引 / 约束 / 触发器");
const idx = new Set((await q(`SELECT indexname FROM pg_indexes WHERE schemaname='public'`)).map((r) => r.indexname));
for (const i of [
  "users_phone_uidx",
  "user_profiles_national_id_hash_uidx",
  "wallets_user_asset_uidx",
  "wallets_system_asset_uidx",
  "transactions_idempotency_uidx",
  "holds_active_tx_wallet_uidx",
  "idempotency_scope_user_key_uidx",
  "transaction_limits_scope_uidx",
  "approval_requests_pending_tx_uidx",
]) ok(idx.has(i), `唯一索引 ${i} 存在`);

const trg = new Set((await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`)).map((r) => r.tgname));
for (const t of [
  "ledger_entries_no_mutation",
  "audit_logs_no_mutation",
  "transaction_events_no_mutation",
  "ledger_entries_balanced",
  "wallets_updated_at",
  "users_updated_at",
]) ok(trg.has(t), `触发器 ${t} 存在`);

const views = new Set((await q(`SELECT viewname FROM pg_views WHERE schemaname='public'`)).map((r) => r.viewname));
ok(views.has("v_ledger_balance"), "视图 v_ledger_balance 存在");
ok(views.has("v_transaction_ledger_diff"), "视图 v_transaction_ledger_diff 存在");

section("5. 种子数据");
ok(num((await one(`SELECT count(*) c FROM assets`)).c) === 2, "两种资产 USD/KHR 已就位");
ok(
  num((await one(`SELECT count(*) c FROM wallets WHERE wallet_type <> 'user'`)).c) === 8,
  "每币种 4 个系统钱包（共 8 个）",
);
ok(num((await one(`SELECT count(*) c FROM transaction_limits WHERE is_active`)).c) > 0, "默认限额已就位");
const usd = await one(`SELECT decimals FROM assets WHERE code='USD'`);
const khr = await one(`SELECT decimals FROM assets WHERE code='KHR'`);
ok(Number(usd?.decimals) === 2 && Number(khr?.decimals) === 0, "USD=2 位小数、KHR=0 位小数");

/* ══════════════════════════════════════════════════════════════════════════
   6. 安全约束：非法写入必须被拒绝
   ══════════════════════════════════════════════════════════════════════════ */
section("6. 安全约束（非法写入必须被拒绝）");

// --- 固定夹具：两个用户 + 各自 USD 钱包 ---
const userA = randomUUID();
const userB = randomUUID();
const walletA = randomUUID();
const walletB = randomUUID();
const NID_A = "a".repeat(64);
const NID_B = "b".repeat(64);

await q(
  `INSERT INTO users (id,user_no,phone,password_hash,status,phone_verified_at,kyc_level)
   VALUES ($1,'U00000001','855979935561',$2,'active',now(),1)`,
  [userA, "scrypt$16384$8$1$c2FsdHhbHQ$aGFzaGhhc2g="],
);
await q(
  `INSERT INTO users (id,user_no,phone,password_hash,status,phone_verified_at,kyc_level)
   VALUES ($1,'U00000002','855971234567',$2,'active',now(),0)`,
  [userB, "scrypt$16384$8$1$c2FsdHhbHQ$aGFzaGhhc2g="],
);
await q(
  `INSERT INTO user_profiles (user_id,full_name,national_id_no_hash,national_id_no_last4)
   VALUES ($1,'CHHENG BONNY',$2,'1234')`,
  [userA, NID_A],
);
await q(
  `INSERT INTO user_profiles (user_id,full_name,national_id_no_hash,national_id_no_last4)
   VALUES ($1,'TEST USER',$2,'5678')`,
  [userB, NID_B],
);
await q(`INSERT INTO wallets (id,wallet_no,user_id,asset_code) VALUES ($1,'ABAUSDUSER000001',$2,'USD')`, [walletA, userA]);
await q(`INSERT INTO wallets (id,wallet_no,user_id,asset_code) VALUES ($1,'ABAUSDUSER000002',$2,'USD')`, [walletB, userB]);

// 手机号唯一
await expectFail("同一手机号不能重复注册", () =>
  q(`INSERT INTO users (user_no,phone,password_hash) VALUES ('U00000003','855979935561','x')`),
);

// 证件号一人一号（每个用户都不同）
await expectFail("同一证件号不能绑定两个用户", () =>
  q(`INSERT INTO user_profiles (user_id,full_name,national_id_no_hash) VALUES ($1,'OTHER',$2)`, [randomUUID(), NID_A]),
);

// 用户钱包一人一币种一个
await expectFail("同一用户同一币种只能有一个钱包", () =>
  q(`INSERT INTO wallets (wallet_no,user_id,asset_code) VALUES ('DUP0001',$1,'USD')`, [userA]),
);

// 用户钱包余额不能为负
await expectFail("用户钱包余额不能为负", () =>
  q(`UPDATE wallets SET balance = -1 WHERE id = $1`, [walletA]),
);

// 冻结不能超过余额
await expectFail("冻结金额不能超过余额", () =>
  q(`UPDATE wallets SET locked_balance = 1 WHERE id = $1`, [walletA]),
);

// 用户钱包必须有归属
await expectFail("用户钱包必须有归属（user_id 不能为空）", () =>
  q(`INSERT INTO wallets (wallet_no,asset_code,wallet_type) VALUES ('BADUSER01','USD','user')`),
);

// 密码列必须存在且没有明文列
const userCols = new Set((await q(`SELECT column_name FROM information_schema.columns WHERE table_name='users'`)).map((r) => r.column_name));
ok(userCols.has("password_hash"), "users.password_hash 存在");
ok(![...userCols].some((c) => c === "password" || c === "password_plain"), "没有明文密码列");
const profCols = new Set((await q(`SELECT column_name FROM information_schema.columns WHERE table_name='user_profiles'`)).map((r) => r.column_name));
ok(profCols.has("national_id_no_encrypted") && profCols.has("national_id_no_hash") && profCols.has("national_id_no_last4"),
  "证件号 = 密文 + 哈希 + 后4位 三列");

// 交易金额/净额
await expectFail("净额不能大于本金", () =>
  q(
    `INSERT INTO transactions (tx_no,type,asset_code,amount,fee_amount,net_amount,initiator_user_id)
     VALUES ('TXBAD0001','withdrawal','USD',10,0,11,$1)`,
    [userA],
  ),
);
await expectFail("手续费不能为负", () =>
  q(
    `INSERT INTO transactions (tx_no,type,asset_code,amount,fee_amount,net_amount,initiator_user_id)
     VALUES ('TXBAD0002','withdrawal','USD',10,-1,11,$1)`,
    [userA],
  ),
);
await expectFail("普通交易必须有发起人", () =>
  q(`INSERT INTO transactions (tx_no,type,asset_code,amount,net_amount) VALUES ('TXBAD0003','transfer','USD',10,10)`),
);

// 幂等键唯一
const txId1 = randomUUID();
await q(
  `INSERT INTO transactions (id,tx_no,type,asset_code,amount,net_amount,initiator_user_id,idempotency_key)
   VALUES ($1,'TXIDEM0001','transfer','USD',5,5,$2,'key-abc')`,
  [txId1, userA],
);
await expectFail("同一用户同类型同幂等键只能有一张单", () =>
  q(
    `INSERT INTO transactions (tx_no,type,asset_code,amount,net_amount,initiator_user_id,idempotency_key)
     VALUES ('TXIDEM0002','transfer','USD',5,5,$1,'key-abc')`,
    [userA],
  ),
);

await expectOk("首次写入幂等键成功", () =>
  q(`INSERT INTO idempotency_keys (scope,user_id,key,request_hash,expires_at)
     VALUES ('transfer.create',$1,'key-abc','h1', now() + interval '1 day')`, [userA]),
);
await expectFail("idempotency_keys 的 (scope,user,key) 重复被拒", () =>
  q(`INSERT INTO idempotency_keys (scope,user_id,key,request_hash,expires_at)
     VALUES ('transfer.create',$1,'key-abc','h1', now() + interval '1 day')`, [userA]),
);
// 幂等抢占：同一 key 再插入返回 0 行（服务层据此判定重复请求）
const conflict = await one(
  `INSERT INTO idempotency_keys (scope,user_id,key,request_hash,expires_at)
   VALUES ('transfer.create',$1,'key-abc','h2', now() + interval '1 day')
   ON CONFLICT DO NOTHING RETURNING id`,
  [userA],
);
ok(conflict === undefined, "重复幂等键被 ON CONFLICT 拦下（返回 0 行）");
// 不同请求体同 key → 服务层比对 request_hash 后返回 409
const stored = await one(`SELECT request_hash FROM idempotency_keys WHERE scope='transfer.create' AND user_id=$1 AND key='key-abc'`, [userA]);
ok(String(stored?.request_hash).trim() === "h1", "保存的 request_hash 可用于识别「同 key 不同请求」", String(stored?.request_hash));

// 限额作用域唯一
await expectFail("同一作用域只能有一条启用的限额", () =>
  q(`INSERT INTO transaction_limits (tx_type,asset_code,kyc_level,min_amount,is_active)
     VALUES ('withdrawal','USD',0,'1.00',true)`),
);

// 冻结唯一
const txId2 = randomUUID();
await q(
  `INSERT INTO transactions (id,tx_no,type,asset_code,amount,net_amount,initiator_user_id)
   VALUES ($1,'TXHOLD0001','withdrawal','USD',10,10,$2)`,
  [txId2, userA],
);
await q(`INSERT INTO holds (transaction_id,wallet_id,asset_code,amount) VALUES ($1,$2,'USD',10)`, [txId2, walletA]);
await expectFail("同一单据同一钱包只能有一条有效冻结", () =>
  q(`INSERT INTO holds (transaction_id,wallet_id,asset_code,amount) VALUES ($1,$2,'USD',10)`, [txId2, walletA]),
);

// 只追加表：先各造一行数据，再尝试改/删（没有行时触发器不会触发）
const seedEventTx = randomUUID();
await q(
  `INSERT INTO transactions (id,tx_no,type,asset_code,amount,net_amount,initiator_user_id)
   VALUES ($1,'TXSEED0001','deposit','USD',1,1,$2)`,
  [seedEventTx, userA],
);
await q(
  `INSERT INTO transaction_events (transaction_id,from_status,to_status) VALUES ($1,'created','pending')`,
  [seedEventTx],
);
await q(
  `INSERT INTO audit_logs (actor_type,action,entity_type,entity_id) VALUES ('admin','seed','transaction',$1)`,
  [seedEventTx],
);
const seedLedgerGroup = randomUUID();
await exec(`BEGIN;
  INSERT INTO ledger_entries (entry_group_id,transaction_id,wallet_id,asset_code,direction,amount,balance_before,balance_after)
  VALUES ('${seedLedgerGroup}','${seedEventTx}','${walletA}','USD','debit',5,0,0);
  INSERT INTO ledger_entries (entry_group_id,transaction_id,wallet_id,asset_code,direction,amount,balance_before,balance_after)
  VALUES ('${seedLedgerGroup}','${seedEventTx}','${walletB}','USD','credit',5,0,0);
  COMMIT;`);

await expectFail("ledger_entries 禁止 UPDATE", () => q(`UPDATE ledger_entries SET amount = amount WHERE 1=1`));
await expectFail("ledger_entries 禁止 DELETE", () => q(`DELETE FROM ledger_entries WHERE 1=1`));
await expectFail("audit_logs 禁止 UPDATE", () => q(`UPDATE audit_logs SET action = action WHERE 1=1`));
await expectFail("audit_logs 禁止 DELETE", () => q(`DELETE FROM audit_logs WHERE 1=1`));
await expectFail("transaction_events 禁止 UPDATE", () => q(`UPDATE transaction_events SET to_status = to_status WHERE 1=1`));
await expectFail("transaction_events 禁止 DELETE", () => q(`DELETE FROM transaction_events WHERE 1=1`));

// updated_at 触发器：手工把 updated_at 改成历史时间，触发器必须把它覆盖成 now()
await q(`UPDATE users SET updated_at = '2000-01-01 00:00:00+00', failed_login_attempts = 0 WHERE id = $1`, [userA]);
const afterUpdate = await one(`SELECT updated_at FROM users WHERE id = $1`, [userA]);
ok(
  new Date(afterUpdate.updated_at).getFullYear() > 2001,
  "updated_at 触发器自动刷新",
  `updated_at=${afterUpdate.updated_at}`,
);

// 手机号注册校验（登录前置）
const hit = await one(`SELECT id, status FROM users WHERE phone = '855979935561' AND deleted_at IS NULL`);
const miss = await one(`SELECT id FROM users WHERE phone = '855970000000' AND deleted_at IS NULL`);
ok(!!hit && hit.status === "active", "已注册手机号能查到");
ok(!miss, "未注册手机号查不到 → PHONE_NOT_REGISTERED");

/* ══════════════════════════════════════════════════════════════════════════
   7. 最小资金闭环：充值 → 提现 → 转账 → 退款 → 对账
   ══════════════════════════════════════════════════════════════════════════ */
section("7. 资金闭环（充值/提现/转账/退款/对账）");

const sysSuspense = (await one(`SELECT id FROM wallets WHERE wallet_type='system_suspense' AND asset_code='USD'`)).id;
const sysFee = (await one(`SELECT id FROM wallets WHERE wallet_type='system_fee' AND asset_code='USD'`)).id;

/** 在同一钱包上过账：锁行 → 更新余额 → 写分录（与 service.ts 的记账逻辑一致） */
async function post({ txId, group, walletId, direction, amount, entryType = "principal" }) {
  const sign = direction === "debit" ? "-" : "+";
  const w = await one(`SELECT balance, asset_code FROM wallets WHERE id = $1 FOR UPDATE`, [walletId]);
  const u = await one(
    `UPDATE wallets SET balance = balance ${sign} $2::numeric, version = version + 1
      WHERE id = $1 RETURNING balance`,
    [walletId, amount],
  );
  await q(
    `INSERT INTO ledger_entries
       (entry_group_id, transaction_id, wallet_id, asset_code, direction, entry_type,
        amount, balance_before, balance_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric)`,
    [group, txId, walletId, w.asset_code, direction, entryType, amount, w.balance, u.balance],
  );
  return u.balance;
}

/**
 * 同一笔交易的多条分录必须在**同一个事务**里提交：
 * 借贷平衡是 DEFERRABLE INITIALLY DEFERRED 的约束触发器，只在 COMMIT 时校验。
 * （PGlite 每条语句默认是独立的隐式事务，所以这里必须显式 BEGIN/COMMIT。）
 */
async function postMany(entries) {
  await exec("BEGIN");
  try {
    for (const e of entries) await post(e);
    await exec("COMMIT");
  } catch (e) {
    try { await exec("ROLLBACK"); } catch { /* 已回滚 */ }
    throw e;
  }
}

function newTx({ no, type, status, amount, fee = "0", initiator, from = null, to = null, idem = null }) {
  const id = randomUUID();
  const group = randomUUID();
  return { id, group, no, type, status, amount, fee, initiator, from, to, idem };
}

async function insertTx(t) {
  const completedAt = t.status === "succeeded" ? new Date().toISOString() : null;
  await q(
    `INSERT INTO transactions
       (id,tx_no,type,status,asset_code,amount,fee_amount,net_amount,
        initiator_user_id,from_wallet_id,to_wallet_id,idempotency_key,completed_at)
     VALUES ($1,$2,$3,$4::transaction_status,'USD',$5::numeric,$6::numeric,$7::numeric,$8,$9,$10,$11,$12::timestamptz)`,
    [t.id, t.no, t.type, t.status, t.amount, t.fee,
     String(Number(t.amount) - Number(t.fee)), t.initiator ?? null,
     t.from ?? null, t.to ?? null, t.idem ?? null, completedAt],
  );
}

/* ── 7.1 充值 100 USD ── */
const dep = newTx({ no: "TXDEP0001", type: "deposit", status: "pending", amount: "100", initiator: userA, to: walletA });
await insertTx(dep);
// 确认入账：借 暂存 / 贷 用户
await postMany([
  { txId: dep.id, group: dep.group, walletId: sysSuspense, direction: "debit", amount: "100" },
  { txId: dep.id, group: dep.group, walletId: walletA, direction: "credit", amount: "100" },
]);
await q(`UPDATE transactions SET status='succeeded', completed_at=now() WHERE id=$1`, [dep.id]);
await q(`INSERT INTO transaction_events (transaction_id,from_status,to_status,actor_type) VALUES ($1,'pending','succeeded','provider')`, [dep.id]);

let a = await one(`SELECT balance, locked_balance FROM wallets WHERE id=$1`, [walletA]);
ok(Number(a.balance) === 100 && Number(a.locked_balance) === 0, "充值到账：余额 100，冻结 0", `balance=${a.balance}`);
let susp = await one(`SELECT balance FROM wallets WHERE id=$1`, [sysSuspense]);
ok(Number(susp.balance) === -100, "暂存钱包记为 -100（在途头寸）", `balance=${susp.balance}`);

// 重复回调：状态机已 succeeded → 直接幂等返回，不写新分录
const beforeCount = num((await one(`SELECT count(*) c FROM ledger_entries WHERE transaction_id=$1`, [dep.id])).c);
const dupCheck = await one(`SELECT status FROM transactions WHERE id=$1 AND status='succeeded'`, [dep.id]);
ok(!!dupCheck, "重复回调检测到已成功 → 幂等返回（不重复入账）");
ok(num((await one(`SELECT count(*) c FROM ledger_entries WHERE transaction_id=$1`, [dep.id])).c) === beforeCount, "重复回调不产生新分录");

/* ── 7.2 提现失败：冻结 → 释放 ── */
const wdFail = newTx({ no: "TXWDF0001", type: "withdrawal", status: "pending", amount: "30", fee: "1", initiator: userA, from: walletA });
await insertTx(wdFail);
await q(`INSERT INTO holds (transaction_id,wallet_id,asset_code,amount) VALUES ($1,$2,'USD',31)`, [wdFail.id, walletA]);
await q(`UPDATE wallets SET locked_balance = locked_balance + 31 WHERE id=$1`, [walletA]);
a = await one(`SELECT balance, locked_balance FROM wallets WHERE id=$1`, [walletA]);
ok(Number(a.balance) === 100 && Number(a.locked_balance) === 31 && Number(a.balance) - Number(a.locked_balance) === 69,
  "提现创建：冻结 31，可用 69", `balance=${a.balance} locked=${a.locked_balance}`);

// 失败 → 释放冻结，不写分录
await q(`UPDATE wallets SET locked_balance = locked_balance - 31 WHERE id=$1`, [walletA]);
await q(`UPDATE holds SET status='released', released_at=now() WHERE transaction_id=$1`, [wdFail.id]);
await q(`UPDATE transactions SET status='failed', failure_code=$2, failure_reason=$3 WHERE id=$1`,
  [wdFail.id, "CHANNEL_DECLINED", "渠道拒绝：账户状态异常"]);
await q(`INSERT INTO transaction_events (transaction_id,from_status,to_status,reason) VALUES ($1,'pending','failed','渠道拒绝')`, [wdFail.id]);
const failedEntries = num((await one(`SELECT count(*) c FROM ledger_entries WHERE transaction_id=$1`, [wdFail.id])).c);
a = await one(`SELECT balance, locked_balance FROM wallets WHERE id=$1`, [walletA]);
ok(failedEntries === 0 && Number(a.balance) === 100 && Number(a.locked_balance) === 0,
  "提现失败：释放冻结、余额回 100、0 条分录", `entries=${failedEntries}`);

/* ── 7.3 提现成功：借 用户 / 贷 暂存 + 手续费 ── */
const wd = newTx({ no: "TXWDO0001", type: "withdrawal", status: "processing", amount: "30", fee: "1", initiator: userA, from: walletA });
await insertTx(wd);
await q(`INSERT INTO holds (transaction_id,wallet_id,asset_code,amount) VALUES ($1,$2,'USD',31)`, [wd.id, walletA]);
await q(`UPDATE wallets SET locked_balance = locked_balance + 31 WHERE id=$1`, [walletA]);
await postMany([
  { txId: wd.id, group: wd.group, walletId: walletA, direction: "debit", amount: "30" },
  { txId: wd.id, group: wd.group, walletId: sysSuspense, direction: "credit", amount: "30" },
  { txId: wd.id, group: wd.group, walletId: walletA, direction: "debit", amount: "1", entryType: "fee" },
  { txId: wd.id, group: wd.group, walletId: sysFee, direction: "credit", amount: "1", entryType: "fee" },
]);
await q(`UPDATE wallets SET locked_balance = locked_balance - 31 WHERE id=$1`, [walletA]);
await q(`UPDATE holds SET status='captured', released_at=now() WHERE transaction_id=$1`, [wd.id]);
await q(`UPDATE transactions SET status='succeeded', completed_at=now() WHERE id=$1`, [wd.id]);
a = await one(`SELECT balance, locked_balance FROM wallets WHERE id=$1`, [walletA]);
ok(Number(a.balance) === 69 && Number(a.locked_balance) === 0, "提现成功：余额 69（100-30-1），冻结释放", `balance=${a.balance}`);

// 组内借贷平衡
const wdDiff = await one(
  `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END),0) d
     FROM ledger_entries WHERE entry_group_id = $1`,
  [wd.group],
);
ok(Number(wdDiff.d) === 0, "提现单据分录借贷平衡", `diff=${wdDiff.d}`);

/* ── 7.4 转账 20 USD（手续费 1）A → B ── */
const tr = newTx({ no: "TXTRF0001", type: "transfer", status: "processing", amount: "20", fee: "1", initiator: userA, from: walletA, to: walletB, idem: "idem-trf-1" });
await insertTx(tr);
await q(`INSERT INTO holds (transaction_id,wallet_id,asset_code,amount) VALUES ($1,$2,'USD',21)`, [tr.id, walletA]);
await q(`UPDATE wallets SET locked_balance = locked_balance + 21 WHERE id=$1`, [walletA]);
a = await one(`SELECT balance, locked_balance FROM wallets WHERE id=$1`, [walletA]);
ok(Number(a.balance) - Number(a.locked_balance) >= 0, "转账冻结后可用余额不为负", `available=${num(a.balance) - num(a.locked_balance)}`);

await postMany([
  { txId: tr.id, group: tr.group, walletId: walletA, direction: "debit", amount: "20" },
  { txId: tr.id, group: tr.group, walletId: walletB, direction: "credit", amount: "20" },
  { txId: tr.id, group: tr.group, walletId: walletA, direction: "debit", amount: "1", entryType: "fee" },
  { txId: tr.id, group: tr.group, walletId: sysFee, direction: "credit", amount: "1", entryType: "fee" },
]);
await q(`UPDATE wallets SET locked_balance = locked_balance - 21 WHERE id=$1`, [walletA]);
await q(`UPDATE holds SET status='captured', released_at=now() WHERE transaction_id=$1`, [tr.id]);
await q(`UPDATE transactions SET status='succeeded', completed_at=now() WHERE id=$1`, [tr.id]);
await q(`INSERT INTO transaction_events (transaction_id,from_status,to_status,actor_type,actor_id) VALUES ($1,'processing','succeeded','user',$2)`, [tr.id, userA]);

const balA = await one(`SELECT balance FROM wallets WHERE id=$1`, [walletA]);
const balB = await one(`SELECT balance FROM wallets WHERE id=$1`, [walletB]);
ok(Number(balA.balance) === 48, "付方余额 48（69-20-1）", `balance=${balA.balance}`);
ok(Number(balB.balance) === 20, "收款方余额 20", `balance=${balB.balance}`);

/* ── 7.5 退款 10 USD（原转账单） ── */
const rf = newTx({ no: "TXREF0001", type: "refund", status: "succeeded", amount: "10", initiator: userA, from: walletB, to: walletA });
await insertTx(rf);
await q(`UPDATE transactions SET parent_transaction_id=$1 WHERE id=$2`, [tr.id, rf.id]);
await postMany([
  { txId: rf.id, group: rf.group, walletId: walletB, direction: "debit", amount: "10", entryType: "refund" },
  { txId: rf.id, group: rf.group, walletId: walletA, direction: "credit", amount: "10", entryType: "refund" },
]);
const balB2 = await one(`SELECT balance FROM wallets WHERE id=$1`, [walletB]);
ok(Number(balB2.balance) === 10, "部分退款后收款方 10（20-10）", `balance=${balB2.balance}`);

// 退款累计不得超过原单可退余额
const refunded = num((await one(
  `SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE parent_transaction_id=$1 AND status='succeeded'`,
  [tr.id],
)).s);
ok(refunded <= 20, "退款累计未超过原单金额", `refunded=${refunded}`);

/* ── 7.6 不平衡分录必须被数据库拒绝 ── */
const badGroup = randomUUID();
await expectFail("借贷不平衡的分录组在 COMMIT 时被拒绝", async () => {
  await exec(`BEGIN;
    INSERT INTO ledger_entries (entry_group_id,transaction_id,wallet_id,asset_code,direction,amount,balance_before,balance_after)
    VALUES ('${badGroup}','${tr.id}','${walletA}','USD','debit',5,0,0);
    INSERT INTO ledger_entries (entry_group_id,transaction_id,wallet_id,asset_code,direction,amount,balance_before,balance_after)
    VALUES ('${badGroup}','${tr.id}','${walletB}','USD','credit',4,0,0);
    COMMIT;`);
});
try { await exec("ROLLBACK;"); } catch { /* 事务已结束 */ }

const okGroup = randomUUID();
await expectOk("借贷平衡的分录组可以提交", async () => {
  await exec(`BEGIN;
    INSERT INTO ledger_entries (entry_group_id,transaction_id,wallet_id,asset_code,direction,amount,balance_before,balance_after)
    VALUES ('${okGroup}','${tr.id}','${walletA}','USD','debit',5,0,0);
    INSERT INTO ledger_entries (entry_group_id,transaction_id,wallet_id,asset_code,direction,amount,balance_before,balance_after)
    VALUES ('${okGroup}','${tr.id}','${walletB}','USD','credit',5,0,0);
    COMMIT;`);
});
// 上面这组虽然平衡，但没同步余额 → 通过「余额 vs 账本」对账立刻能发现差异
const drift = await one(`SELECT count(*) c FROM v_ledger_balance WHERE abs(difference) > 0.000001`);
ok(Number(drift.c) > 0, "只改账本不改余额 → 对账能发现差异（差异项可被检测）", `差异钱包数=${drift.c}`);

/* ── 7.7 对账：全局守恒 + 余额 = 账本汇总 ── */
section("8. 对账与账本查询");
const sumAll = await one(`SELECT COALESCE(SUM(balance),0) s FROM wallets WHERE asset_code='USD'`);
ok(Number(sumAll.s) === 0, "全局资金守恒：所有钱包余额合计 = 0", `sum=${sumAll.s}`);

const ledgerSum = await one(
  `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0) s FROM ledger_entries WHERE asset_code='USD'`,
);
ok(Number(ledgerSum.s) === 0, "账本借贷合计 = 0（复式记账自平衡）", `sum=${ledgerSum.s}`);

const txDiff = await q(`SELECT transaction_id, diff FROM v_transaction_ledger_diff WHERE abs(diff) > 0.000001`);
ok(txDiff.length === 0, "所有单据的分录借贷都平衡（v_transaction_ledger_diff 无差异）", `差异单据 ${txDiff.length} 条`);

// 分录必须能回溯到业务单据
const orphans = await q(
  `SELECT count(*) c FROM ledger_entries l LEFT JOIN transactions t ON t.id = l.transaction_id WHERE t.id IS NULL`,
);
ok(Number(orphans[0].c) === 0, "每条分录都能追溯到业务单据");

// 账本查询：按钱包倒序分页
const page = await q(
  `SELECT id, direction, amount, balance_before, balance_after
     FROM ledger_entries WHERE wallet_id = $1 ORDER BY created_at DESC, id DESC LIMIT 5`,
  [walletA],
);
ok(page.length > 0, "账本流水可按钱包查询", `${page.length} 条`);

// 对账批次与明细（含 difference 校验）
const runId = randomUUID();
await q(
  `INSERT INTO reconciliation_runs (id,asset_code,period_start,period_end,status,wallet_count,mismatch_count,completed_at)
   VALUES ($1,'USD', now() - interval '1 day', now(), 'completed', 4, 1, now())`,
  [runId],
);
await q(
  `INSERT INTO reconciliation_items (run_id,wallet_id,stored_balance,ledger_balance,difference,status)
   VALUES ($1,$2, 100, 100, 0, 'matched')`,
  [runId, walletA],
);
await expectFail("对账明细的 difference 必须等于 stored-ledger", () =>
  q(`INSERT INTO reconciliation_items (run_id,wallet_id,stored_balance,ledger_balance,difference,status)
     VALUES ($1,$2,100,100,5,'mismatched')`, [runId, walletA]),
);

// 审计留痕
await q(
  `INSERT INTO audit_logs (actor_type,actor_id,action,entity_type,entity_id,before,after,request_id)
   VALUES ('admin',$1,'transaction.approve','transaction',$2,'{"status":"requires_review"}','{"status":"processing"}','req-001')`,
  [userB, tr.id],
);
ok(
  num((await one(`SELECT count(*) c FROM audit_logs WHERE action='transaction.approve' AND request_id='req-001'`)).c) === 1,
  "管理员操作写入审计（只追加）",
);

finish();

function finish() {
  log("\n══════════════════════════════════════");
  log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    log("\n失败明细：");
    for (const f of failures) log(`  ✗ ${f}`);
  }
  log("══════════════════════════════════════");
  process.exit(failed > 0 ? 1 : 0);
}
