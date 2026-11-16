import {
  bigserial,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { actorTypeEnum } from "./enums";

/* ────────────────────────────────────────────────────────────────────────────
   audit_logs — 操作审计（管理员 + 系统对关键数据的操作，只追加）

   - 记录 before/after，便于回答「谁在什么时候把什么改成了什么」
   - UPDATE / DELETE 由触发器 reject_mutation() 拒绝
   - requestId 贯穿：接口日志 ↔ 数据库审计可关联
   ──────────────────────────────────────────────────────────────────────────── */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorType: actorTypeEnum("actor_type").notNull(),
    /** 管理员/系统账号/渠道的标识；用户发起时为用户 id */
    actorId: uuid("actor_id"),
    /** 动作名，例如 transaction.approve / wallet.freeze / admin.login */
    action: varchar("action", { length: 80 }).notNull(),
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityId: varchar("entity_id", { length: 64 }).notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    requestId: varchar("request_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    entityIdx: index("audit_logs_entity_idx").on(
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
    actorIdx: index("audit_logs_actor_idx").on(
      t.actorType,
      t.actorId,
      t.createdAt,
    ),
    actionIdx: index("audit_logs_action_idx").on(t.action, t.createdAt),
  }),
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
