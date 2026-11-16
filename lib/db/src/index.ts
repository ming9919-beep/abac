import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

function makeDb(p: pg.Pool) {
  return drizzle(p, { schema });
}

type WalletDb = ReturnType<typeof makeDb>;

let sharedPool: pg.Pool | undefined;
let database: WalletDb | undefined;

/**
 * 懒加载数据库连接。
 *
 * 以前这里是 import 时就 `new Pool(...)`，导致任何 import 本模块的代码
 * （哪怕只是想用 schema 类型）在没有 DATABASE_URL 的环境直接抛错。
 * 现在改为首次真正访问 `db` / `pool` 时才创建连接。
 */
function getPool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return sharedPool;
}

/** 惰性 db 句柄：用 `getDb()` 或访问 `db`（Proxy）都可以 */
function getDb(): WalletDb {
  if (!database) {
    database = makeDb(getPool());
  }
  return database;
}

export { getPool as getPoolLazy, getDb };

/**
 * 代理导出：保持 `import { db } from "@workspace/db"` 的既有写法，
 * 但把连接创建推迟到第一次属性访问 / 查询调用时。
 */
export const db: WalletDb = new Proxy({} as WalletDb, {
  get(_target, prop, receiver) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export const pool: pg.Pool = new Proxy({} as pg.Pool, {
  get(_target, prop, receiver) {
    const real = getPool() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export * from "./schema";
