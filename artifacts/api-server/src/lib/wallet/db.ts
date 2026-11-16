/**
 * 钱包服务的数据库访问层。
 *
 * - 连接串取自 DATABASE_URL，**懒加载**：没有配置时不会在 import 阶段抛错
 * - 所有 SQL 都是参数化查询（$1/$2...），无字符串拼接
 * - withTransaction 提供 BEGIN/COMMIT/ROLLBACK，并保证按固定顺序加行锁
 *
 * 两种驱动（WALLET_DB_DRIVER）：
 *   postgres（默认）— 真正的 PostgreSQL，生产/联调用，需要 DATABASE_URL
 *   pglite           — 嵌入式 PostgreSQL（WASM，零安装），本地演示/冒烟用，
 *                      数据落在 WALLET_PGDATA 目录，首次启动自动执行 migrations
 *
 * 说明：DDL 权威来源是手写 SQL（lib/db/migrations/*.sql），
 * 避免 ORM 与迁移脚本出现两套真相。
 */

import path from "node:path";
import fs from "node:fs";
import type { Pool, PoolClient, QueryResultRow } from "pg";

/* ────────────────────────────────────────────────────────────────
   最小接口：pg.Pool 与 PGlite 都能满足
   ──────────────────────────────────────────────────────────────── */

interface QueryResultLike<T> {
  rows: T[];
}

interface ClientLike {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<T>>;
  release(): void;
}

interface PoolLike {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<T>>;
  connect(): Promise<ClientLike>;
  on(event: string, listener: (err: Error) => void): void;
  end(): Promise<void>;
}

/* ────────────────────────────────────────────────────────────────
   PostgreSQL 驱动
   ──────────────────────────────────────────────────────────────── */

async function createPgPool(url: string): Promise<PoolLike> {
  const { default: pg } = await import("pg");
  const pool: Pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.WALLET_DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (err: Error) => {
    console.error("[wallet] idle client error:", err.message);
  });
  return pool as unknown as PoolLike;
}

/* ────────────────────────────────────────────────────────────────
   PGlite 驱动（零安装的嵌入式 PostgreSQL）
   ──────────────────────────────────────────────────────────────── */

/** 找到 migrations 目录（支持环境变量覆盖与多种运行位置） */
function resolveMigrationsDir(): string | null {
  const candidates = [
    process.env.WALLET_MIGRATIONS_DIR,
    // 仓库根目录下运行：pnpm --filter @workspace/api-server ... → cwd = artifacts/api-server
    path.resolve(process.cwd(), "../../lib/db/migrations"),
    // 在仓库根运行
    path.resolve(process.cwd(), "lib/db/migrations"),
    // 从本文件推算（源码运行时：artifacts/api-server/src/lib/wallet → 仓库根）
    path.resolve(import.meta.dirname ?? process.cwd(), "../../../../../lib/db/migrations"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".sql"))) {
      return dir;
    }
  }
  return null;
}

type PgliteLike = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** 多语句执行（迁移脚本是整段 DDL，不能走参数化协议） */
  exec(text: string): Promise<unknown>;
  waitReady: Promise<unknown>;
  close(): Promise<void>;
};

/** 执行 migrations/*.sql（按文件名字典序，已执行的跳过） */
async function migratePglite(db: PgliteLike): Promise<void> {
  const dir = resolveMigrationsDir();
  if (!dir) {
    console.warn("[wallet] 找不到 lib/db/migrations，跳过自动迁移");
    return;
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    char(64) NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    );
  `);
  const applied = new Set(
    (
      await db.query<{ filename: string }>(`SELECT filename FROM schema_migrations`)
    ).rows.map((r) => r.filename),
  );

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const started = Date.now();
    await db.query("BEGIN");
    try {
      await db.exec(sql);
      await db.query(
        `INSERT INTO schema_migrations (filename, checksum, duration_ms)
         VALUES ($1, $2, $3)`,
        [file, "pglite-local", Date.now() - started],
      );
      await db.query("COMMIT");
      console.log(`[wallet] 迁移已执行: ${file}`);
    } catch (err) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw new Error(
        `迁移失败 ${file}: ${(err as Error).message}`,
      );
    }
  }
}

async function createPglite(): Promise<PoolLike> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.WALLET_PGDATA || ".wallet-pglite";
  const db = new PGlite(dir) as unknown as PgliteLike;
  await db.waitReady;

  if (process.env.WALLET_AUTO_MIGRATE !== "false") {
    await migratePglite(db);
  }

  // 单连接语义：所有查询都走同一个连接，BEGIN/COMMIT 天然串行
  const asPool: PoolLike = {
    query: (text, params) => db.query(text, (params ?? []) as unknown[]),
    connect: async () => ({
      query: (text: string, params?: readonly unknown[]) =>
        db.query(text, (params ?? []) as unknown[]),
      release: () => undefined,
    }),    on: () => undefined,
    end: async () => {
      await db.close();
    },
  };
  return asPool;
}

/* ────────────────────────────────────────────────────────────────
   懒加载入口
   ──────────────────────────────────────────────────────────────── */

let poolPromise: Promise<PoolLike> | null = null;

function driver(): "pglite" | "postgres" {
  const explicit = (process.env.WALLET_DB_DRIVER ?? "").toLowerCase();
  if (explicit === "pglite") return "pglite";
  if (explicit === "postgres") return "postgres";
  // 未显式指定：DATABASE_URL 以 pglite: 开头时用嵌入式驱动
  return process.env.DATABASE_URL?.startsWith("pglite:") ? "pglite" : "postgres";
}

async function createPool(): Promise<PoolLike> {
  if (driver() === "pglite") {
    return createPglite();
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw Object.assign(new Error("DATABASE_URL is not set"), {
      code: "ECONNREFUSED",
    });
  }
  return createPgPool(url);
}

export function getPool(): Promise<PoolLike> {
  if (!poolPromise) poolPromise = createPool();
  return poolPromise;
}

/** 单条参数化查询 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<T[]> {
  const pool = await getPool();
  const res = await pool.query<T>(text, params);
  return res.rows;
}

/** 取一行；没有则返回 null */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** 在事务中执行 fn；异常自动回滚 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = await getPool();
  const client = (await pool.connect()) as unknown as PoolClient;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* 连接已断开时忽略，事务由数据库自动回滚 */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** 事务内的参数化查询（必须用 client，否则会跑到别的连接上） */
export function txQuery<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  params?: readonly unknown[],
): Promise<T[]> {
  return client
    .query<T>(text, params as unknown[])
    .then((r) => r.rows);
}

export async function txQueryOne<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  params?: readonly unknown[],
): Promise<T | null> {
  const rows = await txQuery<T>(client, text, params);
  return rows[0] ?? null;
}

/**
 * 按钱包 id 升序加行锁 —— 并发转账/结算必须用它，
 * 固定顺序才能避免互相等待形成死锁。
 */
export async function lockWallets(
  client: PoolClient,
  walletIds: string[],
): Promise<string[]> {
  const ordered = [...new Set(walletIds)].sort();
  if (ordered.length === 0) return ordered;
  await client.query(
    `SELECT id FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [ordered],
  );
  return ordered;
}

/** 关闭连接池（测试/优雅退出用） */
export async function closePool(): Promise<void> {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = null;
  await pool.end();
}
