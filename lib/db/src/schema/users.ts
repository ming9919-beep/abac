import {
  char,
  check,
  date,
  index,
  inet,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { userStatusEnum } from "./enums";

/* ────────────────────────────────────────────────────────────────────────────
   users — 用户（登录入口）
   规则：手机号是唯一登录标识；手机号未注册 → 不允许登录（PHONE_NOT_REGISTERED）。
   ──────────────────────────────────────────────────────────────────────────── */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 对外用户编号，例如 U202611140001 */
    userNo: varchar("user_no", { length: 20 }).notNull(),
    /** 规范化后的登录手机号，例如 855979935561 */
    phone: varchar("phone", { length: 20 }).notNull(),
    phoneCountry: char("phone_country", { length: 2 }).notNull().default("KH"),
    email: varchar("email", { length: 255 }),
    /** 只存哈希：scrypt$N$r$p$salt$hash —— 绝不存明文密码 */
    passwordHash: text("password_hash").notNull(),
    status: userStatusEnum("status").notNull().default("pending_verification"),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    /** 0–3，决定限额档位 */
    kycLevel: smallint("kyc_level").notNull().default(0),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** 连续登录失败次数，用于限流 */
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    /** 临时锁定到期时间 */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 软注销：唯一索引会排除已注销行 */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userNoIdx: uniqueIndex("users_user_no_uidx").on(t.userNo),
    phoneIdx: uniqueIndex("users_phone_uidx")
      .on(t.phone)
      .where(sql`${t.deletedAt} IS NULL`),
    // 邮箱小写唯一索引在迁移脚本里建（表达式索引 lower(email)），此处只建普通索引
    emailIdx: index("users_email_idx").on(t.email),
    kycCheck: check(
      "users_kyc_level_check",
      sql`${t.kycLevel} >= 0 AND ${t.kycLevel} <= 3`,
    ),
    failedLoginCheck: check(
      "users_failed_login_attempts_check",
      sql`${t.failedLoginAttempts} >= 0`,
    ),
  }),
);

/* ────────────────────────────────────────────────────────────────────────────
   user_profiles — 用户资料（一人一行）
   证件号一人一号：national_id_no_hash 上有唯一索引（每个用户都不同）。
   密文用于按需还原；哈希用于唯一性校验且不可反推；last4 用于客服展示。
   ──────────────────────────────────────────────────────────────────────────── */
export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    fullNameKh: varchar("full_name_kh", { length: 200 }),
    dateOfBirth: date("date_of_birth"),
    gender: varchar("gender", { length: 20 }),
    /** AES-256-GCM 密文（base64：iv.tag.ciphertext），需服务端密钥解密 */
    nationalIdNoEncrypted: text("national_id_no_encrypted"),
    /** HMAC-SHA256(密钥, 规范化证件号)，唯一索引：一个证件号只能绑一个用户 */
    nationalIdNoHash: char("national_id_no_hash", { length: 64 }),
    /** 展示用后 4 位，客服/用户界面只看这个 */
    nationalIdNoLast4: char("national_id_no_last4", { length: 4 }),
    address: text("address"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationalIdIdx: uniqueIndex("user_profiles_national_id_hash_uidx")
      .on(t.nationalIdNoHash)
      .where(sql`${t.nationalIdNoHash} IS NOT NULL`),
    last4Check: check(
      "user_profiles_national_id_last4_check",
      sql`${t.nationalIdNoLast4} IS NULL OR length(${t.nationalIdNoLast4}) = 4`,
    ),
  }),
);

/* ────────────────────────────────────────────────────────────────────────────
   user_sessions — 会话（只存 token 的 SHA-256，明文 token 只在登录响应出现一次）
   ──────────────────────────────────────────────────────────────────────────── */
export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    tokenIdx: uniqueIndex("user_sessions_token_hash_uidx").on(t.tokenHash),
    userIdx: index("user_sessions_user_idx").on(t.userId, t.createdAt),
    expiresIdx: index("user_sessions_expires_idx").on(t.expiresAt),
  }),
);

/* ────────────────────────────────────────────────────────────────────────────
   login_attempts — 登录尝试留痕（限流 + 风控）
   outcome: success / bad_password / phone_not_registered /
            account_locked / account_suspended
   ──────────────────────────────────────────────────────────────────────────── */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: varchar("phone", { length: 20 }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    outcome: varchar("outcome", { length: 40 }).notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    phoneTimeIdx: index("login_attempts_phone_time_idx").on(
      t.phone,
      t.createdAt,
    ),
    timeIdx: index("login_attempts_time_idx").on(t.createdAt),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
export type UserSession = typeof userSessions.$inferSelect;
