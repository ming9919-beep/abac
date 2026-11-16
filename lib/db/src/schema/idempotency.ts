import {
  char,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idempotencyStatusEnum } from "./enums";
import { users } from "./users";
import { transactions } from "./transactions";

/* ────────────────────────────────────────────────────────────────────────────
   idempotency_keys — 幂等记录（防止重复请求导致重复入账）

   用法：与业务写入放在**同一个数据库事务**里先
     INSERT ... ON CONFLICT DO NOTHING
   插入成功 → 我是第一个请求，继续执行业务；
   插入冲突 → 重复请求：比对 request_hash 后返回首次保存的响应（或 409）。

   (scope, user_id, key) 唯一；user_id 为空时用固定 uuid 兜底，
   保证管理员发起的幂等键也受唯一约束保护。
   ──────────────────────────────────────────────────────────────────────────── */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 作用域，例如 transfer.create / deposit.create / withdrawal.create */
    scope: varchar("scope", { length: 40 }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** 客户端提供的 Idempotency-Key 头 */
    key: varchar("key", { length: 128 }).notNull(),
    /** 请求体规范化后的 SHA-256，用于识别「同 key 不同请求」 */
    requestHash: char("request_hash", { length: 64 }).notNull(),
    status: idempotencyStatusEnum("status").notNull().default("in_progress"),
    /** 首次成功的 HTTP 状态码与响应体，重复请求原样返回 */
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 过期后可清理（默认 24h，见服务层） */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    scopeUserKeyIdx: uniqueIndex("idempotency_scope_user_key_uidx").on(
      t.scope,
      sql`coalesce(${t.userId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.key,
    ),
    expiresIdx: index("idempotency_keys_expires_idx").on(t.expiresAt),
  }),
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
