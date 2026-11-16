#!/usr/bin/env node
/**
 * 钱包数据库迁移执行器 —— 只依赖 `pg`，不依赖 drizzle-kit。
 *
 * 用法：
 *   node lib/db/migrations/run-migrations.mjs            # 应用 migrations/*.sql
 *   node lib/db/migrations/run-migrations.mjs --status   # 只查看已应用/待应用
 *   node lib/db/migrations/run-migrations.mjs --dry-run  # 只打印将执行的文件
 *
 * 连接串取自环境变量 DATABASE_URL（或 --database-url 参数）。
 *
 * 保证：
 *   - 每个文件在一个事务里执行，失败整体回滚
 *   - 已执行的文件记录在 schema_migrations（只追加）
 *   - 同一个文件重复执行会被跳过（文件名即主键）
 *   - 文件按文件名字典序执行，只向前不回滚
 */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const valueOf = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const databaseUrl =
  valueOf("--database-url") || process.env.DATABASE_URL || null;

const onlyStatus = hasFlag("--status");
const dryRun = hasFlag("--dry-run");

if (!databaseUrl && !onlyStatus) {
  console.error(
    "✗ 缺少连接串：请设置 DATABASE_URL 或传 --database-url postgresql://...",
  );
  process.exit(1);
}

/** 读取 migrations 目录下按名字典序排列的 .sql 文件 */
async function listFiles() {
  const files = (await readdir(here)).filter((f) => f.endsWith(".sql")).sort();
  return files;
}

async function main() {
  const files = await listFiles();
  if (files.length === 0) {
    console.log("（migrations 目录为空）");
    return;
  }

  if (dryRun) {
    console.log("将要执行的迁移（按顺序）：");
    for (const f of files) console.log("  ·", f);
    return;
  }

  // 延迟 import：--dry-run / 未配置 DATABASE_URL 时不需要 pg
  const { default: pg } = await import("pg");
  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    // schema_migrations：只追加的执行记录
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename     text PRIMARY KEY,
        checksum     char(64) NOT NULL,
        applied_at   timestamptz NOT NULL DEFAULT now(),
        duration_ms  integer NOT NULL DEFAULT 0
      );
      COMMENT ON TABLE schema_migrations IS '钱包迁移执行记录（只追加，禁止 UPDATE/DELETE）';
    `);

    const { rows: appliedRows } = await pool.query(
      `SELECT filename, checksum FROM schema_migrations`,
    );
    const applied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

    if (onlyStatus) {
      console.log(`迁移状态（${files.length} 个文件）：`);
      for (const f of files) {
        const sql = await readFile(path.join(here, f), "utf8");
        const sum = checksum(sql);
        const done = applied.get(f);
        const mark = !done ? "○ 待执行" : done === sum ? "✓ 已执行" : "⚠ 已执行但内容已变更";
        console.log(`  ${mark}  ${f}`);
      }
      return;
    }

    let ran = 0;
    let skipped = 0;

    for (const f of files) {
      const sql = await readFile(path.join(here, f), "utf8");
      const sum = checksum(sql);
      const done = applied.get(f);

      if (done) {
        if (done !== sum) {
          console.warn(
            `⚠ ${f} 已执行过，但文件内容发生变化。迁移只向前：请新增 00xx_*.sql，不要改历史文件。`,
          );
        } else {
          skipped += 1;
          console.log(`  ↷ 跳过 ${f}（已执行）`);
        }
        continue;
      }

      const started = Date.now();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum, duration_ms)
           VALUES ($1, $2, $3)`,
          [f, sum, Date.now() - started],
        );
        await client.query("COMMIT");
        ran += 1;
        console.log(`  ✓ 执行 ${f}（${Date.now() - started} ms）`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`  ✗ 执行 ${f} 失败，已回滚：`, err.message);
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(
      `\n完成：新执行 ${ran} 个，跳过 ${skipped} 个，共 ${files.length} 个。`,
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

function checksum(sql) {
  // 统一换行符后再哈希，避免 Windows/Linux checkout 差异导致误报
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

main().catch((err) => {
  console.error("\n迁移失败：", err.message);
  process.exit(1);
});
