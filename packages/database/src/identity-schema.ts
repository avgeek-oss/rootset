import {
  boolean,
  integer,
  pgSchema,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
const control = pgSchema("rootset_control");
const id = () => varchar("id", { length: 26 }).primaryKey();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
export const users = control.table("users", {
  id: id(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const sessions = control.table("sessions", {
  id: id(),
  userId: varchar("user_id", { length: 26 }).notNull(),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  authenticatedAt: timestamp("authenticated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const authAccounts = control.table("auth_accounts", {
  id: id(),
  userId: varchar("user_id", { length: 26 }).notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const authVerifications = control.table("auth_verifications", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const authPasskeys = control.table("auth_passkeys", {
  id: id(),
  userId: varchar("user_id", { length: 26 }).notNull(),
  name: varchar("name", { length: 255 }),
  publicKey: text("public_key").notNull(),
  credentialID: text("credential_id").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  aaguid: text("aaguid"),
  createdAt: createdAt(),
});
export const authTwoFactors = control.table("auth_two_factors", {
  id: id(),
  userId: varchar("user_id", { length: 26 }).notNull(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  verified: boolean("verified").notNull().default(false),
  failedVerificationCount: integer("failed_verification_count")
    .notNull()
    .default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});
export const identitySchema = {
  users,
  sessions,
  authAccounts,
  authVerifications,
  authPasskeys,
  authTwoFactors,
};
