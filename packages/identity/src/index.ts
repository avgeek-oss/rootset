import { AsyncLocalStorage } from "node:async_hooks";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  ALL_SCOPES,
  assertAccess,
  roleAllows,
  type Actor,
  type Role,
} from "@rootset/access";
import {
  IdSchema,
  InvitationSchema,
  KeyCreatedSchema,
  PreferencesSchema,
  RootsetError,
  ViewPreferencesSchema,
  OperatorRepairIntentSchema,
  OperatorRepairReasonSchema,
  operationMap,
  assertSchemaNumberLexemes,
  newId,
  type Preferences,
  type JsonValue,
  type NumberLexeme,
} from "@rootset/contracts";
import {
  transaction,
  withOrg,
  type Pool,
  type PoolClient,
} from "@rootset/database";
import { identitySchema } from "@rootset/database/identity-schema";
import {
  identityMutationSet,
  mutationSet,
  runMutation,
  stripMutationSecrets,
} from "@rootset/idempotency";
export { identityMutationSet } from "@rootset/idempotency";
import {
  EmailOutbox,
  decryptProtected,
  encryptProtected,
  type EmailConfig,
  type EmailPayload,
  type EmailTemplate,
} from "@rootset/email";

export interface IdentityConfig extends EmailConfig {
  pool: Pool;
  secret: string;
  bootstrapSecret: string;
  keyHashSecret: string;
  oauthResolver?: (request: Request, audience: string) => Promise<Actor | null>;
  authoriseRepair?: (
    actor: Actor,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}
export interface ExecutionContext {
  requestId?: string;
  idempotencyKey?: string;
  actionId?: string;
  jobId?: string;
  surface?: "browser" | "rest" | "api" | "mcp" | "worker";
  approvalClient?: PoolClient;
  numericLexemes?: readonly NumberLexeme[];
}
export interface IdentityPageRequest {
  resource: string;
  filter?: JsonValue;
  limit?: number;
  cursor?: string | null;
}
export interface IdentityPaging {
  read(
    actor: Actor,
    request: IdentityPageRequest,
  ): { afterId: string | null; limit: number; pageNumber: number };
  paginate<T extends { id: string }>(
    rows: readonly T[],
    actor: Actor,
    request: IdentityPageRequest,
  ): { data: T[]; nextCursor: string | null; hasMore: boolean };
}
const nameSchema = z.string().trim().min(1).max(255);
const emailSchema = z.string().trim().toLowerCase().email().max(320);
const passwordSchema = z.string().min(15).max(1024);
const signOutEverywhereInputSchema = z.strictObject({
  revokeDelegated: z.boolean().optional(),
});
const pendingProvision = new AsyncLocalStorage<{
  reason: "bootstrap" | "invitation";
}>();
const authRequest = new AsyncLocalStorage<{
  client?: PoolClient;
  factorUserId?: string;
  factorHash?: string;
}>();
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new RootsetError(
      "VALIDATION_FAILED",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  return result.data;
};
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
const businessInput = (
  input: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => key !== "approvalId" && key !== "actionId",
    ),
  );
const keyIssuanceOperations = new Set([
  "createPersonalKey",
  "rotatePersonalKey",
]);
const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const notFound = (): never => {
  throw new RootsetError("RESOURCE_NOT_FOUND", "Resource was not found", 404);
};
const keyFields = `id,name,user_id,creator_user_id,prefix,expires_at,revoked_at,last_used_at,created_at,rotated_from`;
const mapKey = (r: Record<string, unknown>, orgId: string) => ({
  id: r.id,
  orgId,
  name: r.name,
  userId: r.user_id,
  prefix: r.prefix,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  lastUsedAt: r.last_used_at,
  createdAt: r.created_at,
});
const normaliseOperation = (operation: string) =>
  operation
    .replace(/^rootset_/, "")
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const defaultPreferences: Preferences = {
  timezone: "UTC",
  locale: "en",
  dateFormat: "YYYY-MM-DD",
  timeFormat: "24h",
  theme: "system",
};
const redact = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(redact)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            /password|secret|token|recovery|credential|private.?key|totp|code$/i.test(
              key,
            )
              ? "[redacted]"
              : redact(item),
          ]),
        )
      : value;
const stripSecrets = stripMutationSecrets;
const sensitiveOperations = new Set([
  "changePassword",
  "changeEmail",
  "registerPasskey",
  "removePasskey",
  "enableTwoFactor",
  "disableTwoFactor",
  "rotateRecoveryCodes",
  "signOutEverywhere",
  "createPersonalKey",
  "rotatePersonalKey",
  "deleteDatabase",
  "deleteTable",
  "restoreBackup",
  "setHistoryRetentionPolicy",
  "archiveHistory",
  "updateMember",
  "removeMember",
  "mutateRows",
]);
const factorRoutes: Record<string, string> = {
  "/passkey/generate-register-options": "registerPasskey",
  "/passkey/verify-registration": "registerPasskey",
  "/passkey/delete-passkey": "removePasskey",
  "/two-factor/enable": "enableTwoFactor",
  "/two-factor/disable": "disableTwoFactor",
  "/two-factor/generate-backup-codes": "rotateRecoveryCodes",
  "/two-factor/get-totp-uri": "enableTwoFactor",
};
const actionTypes: Record<string, string> = {
  changePassword: "change_password",
  changeEmail: "change_email",
  registerPasskey: "register_passkey",
  removePasskey: "remove_passkey",
  enableTwoFactor: "enable_totp",
  disableTwoFactor: "disable_totp",
  rotateRecoveryCodes: "rotate_recovery_codes",
  signOutEverywhere: "sign_out_everywhere",
  updateMember: "update_member",
  removeMember: "remove_member",
  createPersonalKey: "create_key",
  rotatePersonalKey: "rotate_key",
  setHistoryRetentionPolicy: "set_history_retention_policy",
  archiveHistory: "archive_history",
  restoreBackup: "restore_backup",
  deleteDatabase: "delete_database",
  deleteTable: "delete_table",
  mutateRows: "operator_repair",
};
const requiresOperationApproval = (
  operation: string,
  input: Record<string, unknown>,
): boolean =>
  sensitiveOperations.has(operation) &&
  !(operation === "restoreBackup" && input.mode === "new") &&
  !(operation === "mutateRows" && input.repair === undefined);

const repairIntent = (input: Record<string, unknown>) =>
  OperatorRepairIntentSchema.parse({
    orgId: input.orgId,
    databaseId: input.databaseId,
    tableId: input.tableId,
    expectedSchemaVersion: input.expectedSchemaVersion,
    reason: (input.repair as { reason: string }).reason,
    updates: (input.mutations as Record<string, unknown>[]).map((update) => ({
      rowId: update.rowId,
      expectedVersion: update.expectedVersion,
      values: update.values,
    })),
  });

export class IdentityService {
  readonly emailOutbox: EmailOutbox;
  private readonly rawAuth;
  readonly auth;
  private paging?: IdentityPaging;
  setPaging(paging: IdentityPaging): void {
    this.paging = paging;
  }
  private externalExecutor?: (
    operationId: string,
    actor: Actor,
    input: Record<string, unknown>,
    context: ExecutionContext,
  ) => Promise<unknown>;
  setExecutor(
    executor: (
      operationId: string,
      actor: Actor,
      input: Record<string, unknown>,
      context: ExecutionContext,
    ) => Promise<unknown>,
  ): void {
    this.externalExecutor = executor;
  }
  constructor(readonly config: IdentityConfig) {
    if (
      config.secret.length < 32 ||
      config.keyHashSecret.length < 32 ||
      config.bootstrapSecret.length < 32
    )
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Identity secrets must contain at least 32 characters",
        500,
      );
    this.emailOutbox = new EmailOutbox(config.pool, config);
    const database = drizzle(config.pool, { schema: identitySchema });
    this.rawAuth = betterAuth({
      appName: "Rootset",
      baseURL: config.baseURL,
      basePath: "/v1/auth",
      secret: config.secret,
      trustedOrigins: [new URL(config.baseURL).origin],
      database: drizzleAdapter(database, {
        provider: "pg",
        transaction: true,
        schema: identitySchema,
      }),
      user: {
        modelName: "users",
        changeEmail: { enabled: false },
      },
      account: {
        modelName: "authAccounts",
        accountLinking: { enabled: false },
      },
      verification: { modelName: "authVerifications" },
      session: {
        modelName: "sessions",
        expiresIn: 7 * 86400,
        updateAge: 3600,
        freshAge: 0,
        cookieCache: { enabled: false },
        additionalFields: {
          authenticatedAt: {
            type: "date",
            input: false,
            returned: false,
            defaultValue: () => new Date(),
          },
        },
      },
      advanced: {
        database: { generateId: () => newId() },
        useSecureCookies: new URL(config.baseURL).protocol === "https:",
        cookiePrefix: "rootset",
        defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      },
      emailAndPassword: {
        enabled: true,
        autoSignIn: false,
        minPasswordLength: 15,
        maxPasswordLength: 1024,
        requireEmailVerification: true,
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: async ({ user, url }) =>
          this.sendEmail({
            template: "password-reset",
            to: user.email,
            payload: {
              name: user.name,
              actionUrl: url,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            },
            dedupeKey: `password-reset:${user.id}:${digest(url)}`,
            expiresAt: new Date(Date.now() + 3600000),
          }),
        onPasswordReset: async ({ user }) => {
          await this.revokeAllUserAccess(user.id);
          await this.sendEmail({
            template: "password-changed",
            to: user.email,
            payload: { name: user.name },
            dedupeKey: `password-reset-notice:${user.id}:${newId()}`,
          });
        },
      },
      emailVerification: {
        sendOnSignUp: false,
        sendOnSignIn: true,
        autoSignInAfterVerification: false,
        expiresIn: 3600,
        sendVerificationEmail: async ({ user, url }) =>
          this.sendEmail({
            template: "account-verification",
            to: user.email,
            payload: {
              name: user.name,
              actionUrl: url,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            },
            dedupeKey: `email-verify:${user.id}:${digest(url)}`,
            expiresAt: new Date(Date.now() + 3600000),
          }),
      },
      databaseHooks: {
        user: {
          create: {
            before: async (user) => {
              if (!pendingProvision.getStore())
                throw new APIError("FORBIDDEN", {
                  message: "Use an invitation to create an account",
                });
              return {
                data: {
                  ...user,
                  email: user.email.trim().toLowerCase(),
                  emailVerified: false,
                },
              };
            },
          },
          update: {
            after: async (user) => {
              if (user.emailVerified)
                await this.finishBootstrapVerification(user.id);
            },
          },
        },
        session: {
          create: {
            before: async (session) => {
              const result = await config.pool.query(
                `SELECT email_verified FROM rootset_control.users WHERE id=$1`,
                [session.userId],
              );
              if (!result.rows[0]?.email_verified)
                throw new APIError("UNAUTHORIZED", {
                  message: "Account is unavailable",
                });
              return { data: { ...session, authenticatedAt: new Date() } };
            },
          },
        },
      },
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path === "/sign-up/email" && !pendingProvision.getStore())
            throw new APIError("FORBIDDEN", {
              message: "Use an invitation to create an account",
            });
          if (
            ctx.path === "/two-factor/verify-totp" ||
            ctx.path === "/two-factor/verify-backup-code"
          ) {
            if (ctx.body?.trustDevice)
              throw new APIError("BAD_REQUEST", {
                message: "Trusted-device bypass is not enabled",
              });
            const signedCookie = ctx.context.createAuthCookie("two_factor", {
              maxAge: 600,
            });
            const identifier = await ctx.getSignedCookie(
              signedCookie.name,
              ctx.context.secret,
            );
            const pending = identifier
              ? await ctx.context.internalAdapter.findVerificationValue(
                  identifier,
                )
              : null;
            const session = await this.rawAuth.api.getSession({
              headers: ctx.headers ?? new Headers(),
            });
            const userId = pending?.value ?? session?.user.id;
            if (userId && ctx.body?.code) {
              const store = authRequest.getStore();
              if (!store)
                throw new APIError("FORBIDDEN", {
                  message: "Factor verification must use the HTTP proof flow",
                });
              const client = await config.pool.connect();
              store.client = client;
              await client.query("BEGIN");
              await client.query(
                "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
                [`factor:${userId}`],
              );
              const proofHash = this.hashSecret(`${userId}:${ctx.body.code}`);
              const used = await client.query(
                `SELECT 1 FROM rootset_control.factor_proofs WHERE user_id=$1 AND proof_hash=$2 AND expires_at>now()`,
                [userId, proofHash],
              );
              if (used.rowCount)
                throw new APIError("UNAUTHORIZED", {
                  message: "This proof has already been used",
                });
              store.factorUserId = userId;
              store.factorHash = proofHash;
              if (ctx.path === "/two-factor/verify-backup-code")
                ctx.body.code = `hmac:${this.hashSecret(ctx.body.code)}`;
            }
          }
        }),
      },
      plugins: [
        twoFactor({
          issuer: "Rootset",
          skipVerificationOnEnable: false,
          backupCodeOptions: {
            storeBackupCodes: {
              encrypt: async (value) =>
                JSON.stringify(
                  (JSON.parse(value) as string[]).map((code) =>
                    code.startsWith("hmac:")
                      ? code
                      : `hmac:${this.hashSecret(code)}`,
                  ),
                ),
              decrypt: async (value) => value,
            },
          },
          schema: { twoFactor: { modelName: "authTwoFactors" } },
        }),
        passkey({
          rpID: new URL(config.baseURL).hostname,
          rpName: "Rootset",
          origin: new URL(config.baseURL).origin,
          authenticatorSelection: {
            residentKey: "required",
            userVerification: "required",
          },
          schema: { passkey: { modelName: "authPasskeys" } },
          registration: {
            requireSession: true,
            afterVerification: ({ verification }) => {
              if (!verification.registrationInfo?.userVerified)
                throw new APIError("FORBIDDEN", {
                  message: "User verification is required",
                });
            },
          },
          authentication: {
            afterVerification: async ({ ctx, verification, clientData }) => {
              if (!verification.authenticationInfo.userVerified)
                throw new APIError("FORBIDDEN", {
                  message: "User verification is required",
                });
              const existing = await this.rawAuth.api.getSession({
                headers: ctx.headers ?? new Headers(),
              });
              if (existing) {
                const credential = await config.pool.query(
                  `SELECT user_id FROM rootset_control.auth_passkeys WHERE credential_id=$1`,
                  [clientData.id],
                );
                if (credential.rows[0]?.user_id !== existing.user.id)
                  throw new APIError("FORBIDDEN", {
                    message:
                      "Use a passkey belonging to your signed-in account",
                  });
              }
            },
          },
        }),
      ],
    });
    this.auth = {
      api: this.rawAuth.api,
      handler: (request: Request) => this.handleAuth(request),
    };
  }
  private hashSecret(secret: string): string {
    return createHmac("sha256", this.config.keyHashSecret)
      .update(secret)
      .digest("hex");
  }
  private requestDigest(value: unknown): string {
    return this.hashSecret(`rootset:bound-request:v2:${canonical(value)}`);
  }
  private async sendEmail(input: {
    template: EmailTemplate;
    to: string;
    payload: EmailPayload;
    dedupeKey: string;
    expiresAt?: Date;
  }): Promise<void> {
    await this.emailOutbox.enqueue(this.config.pool, input);
  }
  private async finishBootstrapVerification(userId: string): Promise<void> {
    const row = await this.config.pool.query(
      `SELECT org_id FROM rootset_control.bootstrap WHERE user_id=$1 AND verified_at IS NULL`,
      [userId],
    );
    if (row.rows[0])
      await withOrg(this.config.pool, row.rows[0].org_id, async (client) => {
        await client.query(
          `UPDATE rootset_control.memberships SET version=version+1 WHERE org_id=$1 AND user_id=$2`,
          [row.rows[0].org_id, userId],
        );
        await client.query(
          `UPDATE rootset_control.bootstrap SET verified_at=now() WHERE user_id=$1`,
          [userId],
        );
      });
  }
  async setupStatus(): Promise<{ claimed: boolean; verified: boolean }> {
    const r = await this.config.pool.query(
      `SELECT claimed_at,verified_at FROM rootset_control.bootstrap WHERE singleton`,
    );
    return {
      claimed: !!r.rows[0]?.claimed_at,
      verified: !!r.rows[0]?.verified_at,
    };
  }
  async claimSetup(value: unknown): Promise<unknown> {
    const input = parse(
      z.strictObject({
        bootstrapSecret: z.string(),
        name: nameSchema,
        email: emailSchema,
        password: passwordSchema,
        organisationName: nameSchema,
        preferences: PreferencesSchema.pick({
          timezone: true,
          dateFormat: true,
          timeFormat: true,
        }).optional(),
      }),
      value,
    );
    if (
      !safeEqual(
        this.hashSecret(input.bootstrapSecret),
        this.hashSecret(this.config.bootstrapSecret),
      )
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "Setup credentials are invalid",
        403,
      );
    const password = await hashPassword(input.password),
      claimDigest = this.requestDigest({
        ...input,
        bootstrapSecret: undefined,
      });
    const result = await transaction(this.config.pool, async (client) => {
      const state = await client.query(
        `SELECT * FROM rootset_control.bootstrap WHERE singleton FOR UPDATE`,
      );
      if (state.rows[0]?.claimed_at) {
        if (state.rows[0].claim_digest !== claimDigest)
          throw new RootsetError(
            "SETUP_ALREADY_CLAIMED",
            "Setup has already been claimed",
            409,
          );
        return {
          orgId: state.rows[0].org_id as string,
          userId: state.rows[0].user_id as string,
        };
      }
      const orgId = newId(),
        userId = newId();
      await client.query(`SELECT set_config('rootset.org_id',$1,true)`, [
        orgId,
      ]);
      await client.query(
        `INSERT INTO rootset_control.users(id,name,email) VALUES($1,$2,$3)`,
        [userId, input.name, input.email],
      );
      const preferences = { ...defaultPreferences, ...input.preferences };
      await client.query(
        `INSERT INTO rootset_control.user_preferences(user_id,timezone,locale,date_format,time_format,theme) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          userId,
          preferences.timezone,
          preferences.locale,
          preferences.dateFormat,
          preferences.timeFormat,
          preferences.theme,
        ],
      );
      await client.query(
        `INSERT INTO rootset_control.auth_accounts(id,user_id,account_id,provider_id,password) VALUES($1,$2,$4,'credential',$3)`,
        [newId(), userId, password, userId],
      );
      await client.query(
        `INSERT INTO rootset_control.organisations(id,name) VALUES($1,$2)`,
        [orgId, input.organisationName],
      );
      await client.query(
        `INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')`,
        [newId(), orgId, userId],
      );
      await client.query(
        `UPDATE rootset_control.bootstrap SET org_id=$1,user_id=$2,claimed_at=now(),claim_digest=$3 WHERE singleton`,
        [orgId, userId, claimDigest],
      );
      return { orgId, userId };
    });
    await this.rawAuth.api.sendVerificationEmail({
      body: { email: input.email, callbackURL: `${this.config.baseURL}/login` },
    });
    return { state: "awaiting_verification", ...result };
  }
  async refreshActor(actor: Actor): Promise<Actor> {
    return this.hydrateActor(actor, true);
  }
  async refreshPolicyActor(actor: Actor): Promise<Actor> {
    return this.hydrateActor(actor, actor.kind !== "session");
  }
  private async hydrateActor(
    actor: Actor,
    requireSession: boolean,
    transactionClient?: PoolClient,
  ): Promise<Actor> {
    const hydrate = async (client: PoolClient): Promise<Actor> => {
      const membership = (
        await client.query(
          `SELECT m.role,m.version,u.email_verified FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id JOIN rootset_control.organisations o ON o.id=m.org_id AND o.singleton WHERE m.org_id=$1 AND m.user_id=$2`,
          [actor.orgId, actor.userId],
        )
      ).rows[0];
      if (!actor.userId || !membership?.email_verified)
        throw new RootsetError(
          "UNAUTHENTICATED",
          "Membership is unavailable",
          401,
        );
      if (actor.kind === "session" && requireSession) {
        const session = (
          await client.query(
            `SELECT authenticated_at FROM rootset_control.sessions WHERE id=$1 AND user_id=$2 AND expires_at>now()`,
            [actor.id, actor.userId],
          )
        ).rows[0];
        if (!session)
          throw new RootsetError(
            "UNAUTHENTICATED",
            "Session is unavailable",
            401,
          );
        actor = {
          ...actor,
          authenticatedAt: new Date(session.authenticated_at).getTime(),
        };
      }
      if (
        actor.kind === "personal_key" &&
        !(
          await client.query(
            `SELECT 1 FROM rootset_control.api_keys WHERE id=$1 AND org_id=$2 AND user_id=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,
            [actor.credentialId ?? actor.id, actor.orgId, actor.userId],
          )
        ).rowCount
      )
        throw new RootsetError(
          "UNAUTHENTICATED",
          "Credential is unavailable",
          401,
        );
      let grantedScopes: string[] = [...ALL_SCOPES];
      if (actor.kind === "oauth") {
        const grant = (
          await client.query(
            `SELECT scopes FROM rootset_control.oauth_grants WHERE id=$1 AND org_id=$2 AND user_id=$3 AND revoked_at IS NULL AND created_at>now()-interval '30 days'`,
            [actor.credentialId, actor.orgId, actor.userId],
          )
        ).rows[0];
        if (!actor.credentialId || !grant)
          throw new RootsetError(
            "UNAUTHENTICATED",
            "OAuth grant is unavailable",
            401,
          );
        grantedScopes = actor.scopes.filter((scope) =>
          (grant.scopes as string[]).includes(scope),
        );
      }
      return {
        kind: actor.kind,
        id: actor.id,
        orgId: actor.orgId,
        userId: actor.userId,
        ...(actor.credentialId ? { credentialId: actor.credentialId } : {}),
        ...(actor.clientId ? { clientId: actor.clientId } : {}),
        ...(actor.authenticatedAt !== undefined
          ? { authenticatedAt: actor.authenticatedAt }
          : {}),
        role: membership.role,
        scopes: grantedScopes.filter((scope) =>
          roleAllows(membership.role, scope),
        ),
        membershipVersion: Number(membership.version),
      };
    };
    return transactionClient
      ? hydrate(transactionClient)
      : withOrg(this.config.pool, actor.orgId, hydrate);
  }
  async resolveActor(
    request: Request,
    audience = "api",
  ): Promise<Actor | null> {
    const authorization = request.headers.get("authorization");
    if (audience === "browser") {
      if (authorization) return null;
      const session = await this.rawAuth.api.getSession({
        headers: request.headers,
      });
      if (!session) return null;
      const membership = (
        await this.config.pool.query(
          `SELECT org_id FROM rootset_control.memberships_for_user($1)`,
          [session.user.id],
        )
      ).rows[0];
      if (!membership) return null;
      return this.refreshActor({
        kind: "session",
        id: session.session.id,
        orgId: membership.org_id,
        userId: session.user.id,
        role: "viewer",
        scopes: [],
      });
    }
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice(7);
    const match =
      /^rst_([0-7][0-9A-HJKMNP-TV-Z]{25})_([A-Za-z0-9_-]{43})$/.exec(token);
    if (match) {
      const locator = (
        await this.config.pool.query(
          `SELECT org_id FROM rootset_control.key_locator($1)`,
          [match[1]],
        )
      ).rows[0];
      if (!locator) return null;
      const candidate = await withOrg(
        this.config.pool,
        locator.org_id,
        async (client) =>
          (
            await client.query(
              `SELECT * FROM rootset_control.api_keys WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,
              [match[1], locator.org_id],
            )
          ).rows[0],
      );
      if (
        !candidate ||
        !safeEqual(candidate.secret_hash, this.hashSecret(token))
      )
        return null;
      const actor = await this.refreshActor({
        kind: "personal_key",
        id: candidate.id,
        credentialId: candidate.id,
        orgId: candidate.org_id,
        userId: candidate.user_id,
        role: "viewer",
        scopes: [],
      });
      await withOrg(this.config.pool, actor.orgId, (client) =>
        client.query(
          `UPDATE rootset_control.api_keys SET last_used_at=now() WHERE id=$1 AND user_id=$2`,
          [candidate.id, actor.userId],
        ),
      );
      return actor;
    }
    const oauth = await this.config.oauthResolver?.(request, audience);
    return oauth ? this.refreshActor(oauth) : null;
  }
  private async limitRequest(request: Request, path: string): Promise<void> {
    const address =
      request.headers.get("x-rootset-client-address") ?? "unknown";
    const key = this.hashSecret(`${address}:${path}`);
    const result = await this.config.pool.query(
      `INSERT INTO rootset_control.identity_rate_limits(bucket_hash,attempts,expires_at) VALUES($1,1,now()+interval '1 minute') ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN identity_rate_limits.expires_at<=now() THEN 1 ELSE identity_rate_limits.attempts+1 END,expires_at=CASE WHEN identity_rate_limits.expires_at<=now() THEN now()+interval '1 minute' ELSE identity_rate_limits.expires_at END RETURNING attempts`,
      [key],
    );
    if (result.rows[0].attempts > 20)
      throw new RootsetError("RATE_LIMITED", "Try again in one minute", 429);
  }
  private async handleAuth(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/^\/v1\/auth/, "");
    let approvalLease: PoolClient | undefined;
    try {
      if (request.method !== "GET") await this.limitRequest(request, path);
      if (
        !["GET", "HEAD"].includes(request.method) &&
        request.headers.has("cookie") &&
        request.headers.get("origin") !== new URL(this.config.baseURL).origin
      )
        throw new RootsetError(
          "ACCESS_DENIED",
          "The request origin is invalid",
          403,
        );
      if (["/organisations", "/organisation", "/delete-user"].includes(path))
        notFound();
      if (path.startsWith("/invitations/"))
        return await this.handleInvitation(request, path);
      if (path === "/reauthenticate") return await this.reauthenticate(request);
      if (path === "/email-change")
        return await this.pendingEmailChange(request);
      if (path === "/email-change/confirm")
        return await this.confirmEmailChange(request);
      const actionId = request.headers.get("x-rootset-action-id");
      let actionOperation = factorRoutes[path];
      if (path === "/two-factor/verify-totp" && actionId)
        actionOperation = "enableTwoFactor";
      const factorBefore =
        path === "/two-factor/verify-totp"
          ? await this.rawAuth.api.getSession({ headers: request.headers })
          : null;
      const wasEnabled = factorBefore
        ? (
            await this.config.pool.query(
              `SELECT two_factor_enabled FROM rootset_control.users WHERE id=$1`,
              [factorBefore.user.id],
            )
          ).rows[0]?.two_factor_enabled
        : true;
      if (
        path === "/change-password" ||
        path === "/update-user" ||
        path === "/delete-user"
      )
        return Response.json(
          {
            error: {
              code: "STEP_UP_REQUIRED",
              message: "Use the bound Rootset account action",
            },
          },
          { status: 403 },
        );
      if (actionOperation) {
        const actor = await this.resolveActor(request, "browser");
        if (!actor)
          throw new RootsetError("UNAUTHENTICATED", "Sign in to continue", 401);
        if (actionId) {
          approvalLease = await this.config.pool.connect();
          await approvalLease.query("BEGIN");
          await approvalLease.query(
            `SELECT set_config('rootset.org_id',$1,true)`,
            [actor.orgId],
          );
          const approved = await this.requireApprovedAction(
            actor,
            actionId,
            actionOperation,
            approvalLease,
            true,
          );
          const expected = decryptProtected<Record<string, unknown>>(
            approved.payload_encrypted as string,
            this.config,
          );
          if (path === "/passkey/delete-passkey") {
            const body = (await request.clone().json()) as { id?: string };
            if (expected.id !== body.id)
              throw new RootsetError(
                "STEP_UP_REQUIRED",
                "The approved passkey does not match this request",
                403,
              );
          }
        } else this.requireRecentAuthentication(actor);
      }
      const store: {
        client?: PoolClient;
        factorUserId?: string;
        factorHash?: string;
      } = {};
      const passkeySession =
        path === "/passkey/verify-authentication"
          ? await this.rawAuth.api.getSession({ headers: request.headers })
          : null;
      let response: Response;
      try {
        response = await authRequest.run(store, () =>
          this.rawAuth.handler(request),
        );
        if (store.client && store.factorUserId && store.factorHash) {
          if (response.ok)
            await store.client.query(
              `INSERT INTO rootset_control.factor_proofs(user_id,proof_hash,expires_at) VALUES($1,$2,now()+interval '2 minutes') ON CONFLICT(user_id,proof_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
              [store.factorUserId, store.factorHash],
            );
          await store.client.query("COMMIT");
        }
      } finally {
        if (store.client) {
          await store.client.query("ROLLBACK");
          store.client.release();
        }
      }
      if (response.ok && passkeySession) {
        const payload = (await response.clone().json()) as {
          session: { id: string };
          user: { id: string };
        };
        if (payload.user.id !== passkeySession.user.id)
          throw new RootsetError(
            "ACCESS_DENIED",
            "Use a passkey belonging to your signed-in account",
            403,
          );
        await this.config.pool.query(
          `DELETE FROM rootset_control.sessions WHERE id=$1 AND id<>$2`,
          [payload.session.id, passkeySession.session.id],
        );
        const authenticatedAt = new Date();
        await this.config.pool.query(
          `UPDATE rootset_control.sessions SET authenticated_at=$2 WHERE id=$1`,
          [passkeySession.session.id, authenticatedAt],
        );
        const headers = new Headers(response.headers);
        headers.delete("set-cookie");
        for (const cookie of response.headers.getSetCookie())
          if (!/rootset\.session_token=/.test(cookie))
            headers.append("set-cookie", cookie);
        response = Response.json(
          {
            session: passkeySession.session,
            user: passkeySession.user,
            reauthenticated: true,
          },
          { status: 200, headers },
        );
      }
      if (
        response.ok &&
        actionId &&
        actionOperation &&
        !path.includes("generate-register") &&
        !path.includes("get-totp-uri") &&
        path !== "/two-factor/enable"
      ) {
        if (approvalLease)
          await approvalLease.query(
            `UPDATE rootset_control.account_actions SET consumed_at=now(),payload_encrypted='',result=$2 WHERE id=$1 AND consumed_at IS NULL`,
            [actionId, JSON.stringify({ completed: true })],
          );
      }
      if (
        response.ok &&
        ([
          "/two-factor/disable",
          "/two-factor/generate-backup-codes",
          "/passkey/verify-registration",
          "/passkey/delete-passkey",
        ].includes(path) ||
          (path === "/two-factor/verify-totp" && factorBefore && !wasEnabled))
      ) {
        const session = await this.rawAuth.api.getSession({
          headers: request.headers,
        });
        if (session) {
          await this.revokeAllUserAccess(session.user.id, session.session.id);
          await this.sendEmail({
            template: "factor-changed",
            to: session.user.email,
            payload: { name: session.user.name },
            dedupeKey: `factor:${session.user.id}:${newId()}`,
          });
        }
      }
      if (approvalLease)
        await approvalLease.query(response.ok ? "COMMIT" : "ROLLBACK");
      return response;
    } catch (error) {
      const status = error instanceof RootsetError ? error.status : 500;
      return Response.json(
        {
          error: {
            code: error instanceof RootsetError ? error.code : "INTERNAL_ERROR",
            message:
              error instanceof RootsetError
                ? error.message
                : "Authentication could not be completed",
          },
        },
        { status },
      );
    } finally {
      if (approvalLease) {
        await approvalLease.query("ROLLBACK");
        approvalLease.release();
      }
    }
  }
  private requireRecentAuthentication(actor: Actor): void {
    if (
      actor.kind !== "session" ||
      !actor.authenticatedAt ||
      Date.now() - actor.authenticatedAt > 300000
    )
      throw new RootsetError(
        "STEP_UP_REQUIRED",
        "Authenticate again in the browser",
        403,
      );
  }
  private async requireApprovedAction(
    actor: Actor,
    id: string,
    operation: string,
    client?: PoolClient,
    lock = false,
  ): Promise<Record<string, unknown>> {
    const read = async (c: PoolClient) => {
      const r = await c.query(
        `SELECT * FROM rootset_control.account_actions WHERE id=$1 AND user_id=$2 AND org_id=$3 AND operation=$4 AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at>now()${lock ? " FOR UPDATE" : ""}`,
        [id, actor.userId, actor.orgId, operation],
      );
      if (!r.rows[0])
        throw new RootsetError(
          "STEP_UP_REQUIRED",
          "The approved action is unavailable",
          403,
        );
      return r.rows[0];
    };
    return client ? read(client) : withOrg(this.config.pool, actor.orgId, read);
  }
  private async assertSensitive(
    actor: Actor,
    operation: string,
    input: unknown,
    context: ExecutionContext,
    client: PoolClient,
  ): Promise<void> {
    if (!requiresOperationApproval(operation, input as Record<string, unknown>))
      return;
    if (
      actor.kind === "session" &&
      !context.actionId &&
      operation !== "mutateRows"
    ) {
      this.requireRecentAuthentication(actor);
      return;
    }
    if (!context.actionId)
      throw new RootsetError(
        "STEP_UP_REQUIRED",
        "Start an account action and approve it in the browser",
        403,
        { operationId: operation },
      );
    const action = await this.requireApprovedAction(
      actor,
      context.actionId,
      operation,
      client,
      true,
    );
    if (
      action.actor_id !== actor.id ||
      action.client_id !== (actor.clientId ?? null) ||
      action.digest !==
        this.requestDigest({
          operation,
          input: businessInput(input as Record<string, unknown>),
          actorId: actor.id,
          clientId: actor.clientId ?? null,
          userId: actor.userId,
          orgId: actor.orgId,
        })
    )
      throw new RootsetError(
        "STEP_UP_REQUIRED",
        "Approval is bound to a different request",
        403,
      );
    if (context.approvalClient !== client)
      await client.query(
        `UPDATE rootset_control.account_actions SET consumed_at=now(),payload_encrypted='' WHERE id=$1`,
        [context.actionId],
      );
  }
  async approveAction(id: string, actor: Actor): Promise<unknown> {
    actor = await this.refreshActor(actor);
    this.requireRecentAuthentication(actor);
    return withOrg(this.config.pool, actor.orgId, async (client) => {
      const row = await client.query(
        `UPDATE rootset_control.account_actions SET approved_at=now() WHERE id=$1 AND user_id=$2 AND org_id=$3 AND consumed_at IS NULL AND expires_at>now() RETURNING id,operation,expires_at,payload_encrypted`,
        [id, actor.userId, actor.orgId],
      );
      if (!row.rows[0]) notFound();
      const intent =
        row.rows[0].operation === "mutateRows"
          ? decryptProtected<Record<string, unknown>>(
              row.rows[0].payload_encrypted,
              this.config,
            )
          : undefined;
      if (intent) await this.authoriseRepair(actor, intent);
      return this.actionMetadata(
        row.rows[0],
        "approved",
        undefined,
        intent ? repairIntent(intent) : undefined,
      );
    });
  }
  private actionMetadata(
    row: Record<string, unknown>,
    state: "pending" | "approved" | "consumed" | "expired",
    result?: unknown,
    intent?: unknown,
  ): Record<string, unknown> {
    return {
      id: row.id,
      type: actionTypes[row.operation as string],
      state,
      expiresAt: new Date(row.expires_at as string | Date).toISOString(),
      approvalUrl: `${this.config.baseURL}/account-actions/${row.id}`,
      ...(result === undefined ? {} : { result }),
      ...(intent === undefined ? {} : { repairIntent: intent }),
    };
  }
  async assertOperationApproval(
    actor: Actor,
    operationId: string,
    input: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<void> {
    const operation = normaliseOperation(operationId);
    if (!requiresOperationApproval(operation, input)) return;
    actor = await this.hydrateActor(actor, true, context.approvalClient);
    if (
      actor.kind === "session" &&
      !context.actionId &&
      operation !== "mutateRows"
    ) {
      this.requireRecentAuthentication(actor);
      return;
    }
    if (!context.actionId)
      throw new RootsetError(
        "STEP_UP_REQUIRED",
        "Start an account action and approve it in the browser",
        403,
        { operationId: operation },
      );
    const validate = async (client: PoolClient) => {
      const row = await this.requireApprovedAction(
        actor,
        context.actionId!,
        operation,
        client,
      );
      if (
        row.actor_id !== actor.id ||
        row.client_id !== (actor.clientId ?? null) ||
        row.digest !==
          this.requestDigest({
            operation,
            input: businessInput(input),
            actorId: actor.id,
            clientId: actor.clientId ?? null,
            userId: actor.userId,
            orgId: actor.orgId,
          })
      )
        throw new RootsetError(
          "STEP_UP_REQUIRED",
          "Approval is bound to a different request",
          403,
        );
    };
    if (context.approvalClient) await validate(context.approvalClient);
    else await withOrg(this.config.pool, actor.orgId, validate);
  }
  async withOperationApproval<T>(
    actor: Actor,
    operationId: string,
    input: Record<string, unknown>,
    context: ExecutionContext,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const operation = normaliseOperation(operationId);
    const sensitive = requiresOperationApproval(operation, input);
    actor = await this.hydrateActor(actor, true, context.approvalClient);
    const approveAndRun = async (client: PoolClient) => {
      const approvedContext = { ...context, approvalClient: client };
      if (sensitive && context.actionId)
        await this.requireApprovedAction(
          actor,
          context.actionId,
          operation,
          client,
          true,
        );
      await this.assertOperationApproval(
        actor,
        operation,
        input,
        approvedContext,
      );
      const result = await work(client);
      if (sensitive && context.actionId)
        await client.query(
          `UPDATE rootset_control.account_actions SET consumed_at=now(),payload_encrypted='',result=$2 WHERE id=$1 AND consumed_at IS NULL`,
          [context.actionId, JSON.stringify(stripSecrets(result))],
        );
      return result;
    };
    const run = async (client: PoolClient): Promise<T> => {
      if (keyIssuanceOperations.has(operation)) {
        const replay = await this.prepareKeyReceipt(
          client,
          operation,
          actor,
          businessInput(input),
          context,
        );
        if (replay) return replay as T;
      }
      return mutationSet.has(operation) &&
        (operation !== "mutateRows" || sensitive)
        ? runMutation(
            client,
            actor,
            operation,
            input,
            context.idempotencyKey ?? "",
            this.config.keyHashSecret,
            () => approveAndRun(client),
          )
        : approveAndRun(client);
    };
    return context.approvalClient
      ? run(context.approvalClient)
      : withOrg(this.config.pool, actor.orgId, run);
  }
  private async page(
    client: PoolClient,
    actor: Actor,
    operation: string,
    input: Record<string, unknown>,
    sql: string,
    parameters: unknown[],
    map?: (row: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.paging)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Metadata cursor service is unavailable",
        503,
      );
    const options = parse(
      z.strictObject({
        limit: z.number().int().min(1).max(25000).optional(),
        cursor: z.string().nullable().optional(),
      }),
      { limit: input.limit, cursor: input.cursor },
    );
    const request: IdentityPageRequest = {
      resource: `identity:${operation}:${actor.orgId}:${actor.userId ?? "installation"}`,
      filter: JSON.parse(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(input).filter(
              ([key]) => key !== "limit" && key !== "cursor",
            ),
          ),
        ),
      ) as JsonValue,
      ...options,
    };
    const position = this.paging.read(actor, request),
      after = parameters.length + 1,
      limit = after + 1;
    const result = await client.query(
      `SELECT * FROM (${sql}) metadata_page WHERE ($${after}::text IS NULL OR id>$${after}) ORDER BY id LIMIT $${limit}`,
      [...parameters, position.afterId, position.limit + 1],
    );
    return this.paging.paginate(
      result.rows.map((row) => (map ? map(row) : row)) as Array<
        Record<string, unknown> & { id: string }
      >,
      actor,
      request,
    );
  }
  async revokeAllUserAccess(
    userId: string,
    exceptSessionId?: string,
    client: PoolClient | Pool = this.config.pool,
  ): Promise<void> {
    if ("totalCount" in client) {
      await transaction(client, (c) =>
        this.revokeAllUserAccess(userId, exceptSessionId, c),
      );
      return;
    }
    await this.lockUserAuthorities(client, [userId]);
    const originalContext =
      (
        await client.query(
          `SELECT current_setting('rootset.org_id',true) org_id`,
        )
      ).rows[0].org_id ?? "";
    await client.query(
      `DELETE FROM rootset_control.sessions WHERE user_id=$1 AND ($2::text IS NULL OR id<>$2)`,
      [userId, exceptSessionId ?? null],
    );
    await client.query(
      `UPDATE rootset_control.users SET authentication_version=authentication_version+1 WHERE id=$1`,
      [userId],
    );
    const memberships = await client.query(
      `SELECT * FROM rootset_control.memberships_for_user($1)`,
      [userId],
    );
    for (const m of memberships.rows) {
      await client.query(`SELECT set_config('rootset.org_id',$1,true)`, [
        m.org_id,
      ]);
      await client.query(
        `UPDATE rootset_control.api_keys SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`,
        [userId],
      );
      const exists = await client.query(
        `SELECT to_regclass('rootset_control.oauth_grants') present`,
      );
      if (exists.rows[0].present)
        await client.query(
          `UPDATE rootset_control.oauth_grants SET revoked_at=now() WHERE user_id=$1 AND org_id=$2 AND revoked_at IS NULL`,
          [userId, m.org_id],
        );
    }
    await client.query(`SELECT set_config('rootset.org_id',$1,true)`, [
      originalContext,
    ]);
  }
  validateAccountActionRequest(
    actor: Actor,
    input: Record<string, unknown>,
    context: ExecutionContext = {},
  ): { operationId: string; input: Record<string, unknown> } {
    if (!actor.userId)
      throw new RootsetError(
        "PERSONAL_IDENTITY_REQUIRED",
        "A user identity is required",
        403,
      );
    const data = parse(
      z.strictObject({
        type: z.string().optional(),
        operationId: z.string().optional(),
        input: z.record(z.string(), z.unknown()).default({}),
        orgId: IdSchema.optional(),
      }),
      input,
    );
    if (data.orgId && data.orgId !== actor.orgId) notFound();
    const inferred = Object.entries(actionTypes).find(
      ([, type]) => type === data.type,
    )?.[0];
    const target = normaliseOperation(data.operationId ?? inferred ?? "");
    if (
      !sensitiveOperations.has(target) ||
      (target === "mutateRows" && data.input.repair === undefined) ||
      (data.type && actionTypes[target] !== data.type)
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "The action type must match the requested operation",
      );
    let boundInput = businessInput(data.input);
    this.checkActionAuthority(actor, target, boundInput);
    // Factor ceremonies belong to the authentication protocol adapter.
    const targetOperation = operationMap[target];
    if (targetOperation) {
      if (
        targetOperation.inputSchema instanceof z.ZodObject &&
        targetOperation.inputSchema.shape.orgId &&
        boundInput.orgId === undefined
      )
        boundInput.orgId = actor.orgId;
      const parsedInput = parse(targetOperation.inputSchema, boundInput);
      if (target === "mutateRows")
        boundInput = parsedInput as Record<string, unknown>;
      assertSchemaNumberLexemes(
        targetOperation.inputSchema,
        (context.numericLexemes ?? [])
          .filter((info) => info.path[0] === "input")
          .map((info) => ({
            ...info,
            path: info.path.slice(1),
            pointer: info.pointer.replace(/^\/input/, ""),
          })),
      );
    } else
      parse(
        target === "changePassword"
          ? z.strictObject({
              currentPassword: z.string().max(1024),
              newPassword: passwordSchema,
            })
          : target === "changeEmail"
            ? z.strictObject({ newEmail: emailSchema })
            : target === "signOutEverywhere"
              ? signOutEverywhereInputSchema
              : target === "removePasskey"
                ? z.strictObject({ id: z.string().min(1).max(255) })
                : z.strictObject({}),
        boundInput,
      );
    this.checkActionAuthority(actor, target, boundInput);
    return { operationId: target, input: boundInput };
  }
  async execute(
    operationId: string,
    incomingActor: Actor,
    value: unknown,
    context: ExecutionContext = {},
  ): Promise<unknown> {
    const operation = normaliseOperation(operationId),
      actor = await this.hydrateActor(
        incomingActor,
        true,
        context.approvalClient,
      ),
      input = (value ?? {}) as Record<string, unknown>;
    if (
      (typeof input.actionId === "string" ||
        typeof input.approvalId === "string") &&
      !context.actionId
    )
      context = {
        ...context,
        actionId: (input.actionId ?? input.approvalId) as string,
      };
    const normalizedInput = businessInput(input);
    const executionInput = normalizedInput;
    if (
      typeof normalizedInput.orgId === "string" &&
      normalizedInput.orgId !== actor.orgId
    )
      notFound();
    const run = async (client: PoolClient) => {
      if (!identityMutationSet.has(operation))
        return this.executeWithin(
          client,
          operation,
          actor,
          executionInput,
          context,
        );
      const definition = operationMap[operation];
      if (definition) {
        const ranks = { viewer: 1, editor: 2, admin: 3 };
        if (ranks[actor.role] < ranks[definition.minimumRole])
          throw new RootsetError(
            "ACCESS_DENIED",
            "Your role does not allow this operation",
            403,
          );
        if (definition.personal && !actor.userId)
          throw new RootsetError(
            "PERSONAL_IDENTITY_REQUIRED",
            "A user identity is required",
            403,
          );
        if (
          typeof normalizedInput.orgId === "string" &&
          normalizedInput.orgId !== actor.orgId
        )
          notFound();
        for (const scope of definition.scopes)
          assertAccess(actor, {
            scope,
            personal: definition.personal,
            orgId: actor.orgId,
            databaseId:
              typeof normalizedInput.databaseId === "string"
                ? normalizedInput.databaseId
                : undefined,
            tableId:
              typeof normalizedInput.tableId === "string"
                ? normalizedInput.tableId
                : undefined,
          });
      }
      if (operation === "beginAccountAction") {
        const bound = this.validateAccountActionRequest(
          actor,
          normalizedInput,
          context,
        );
        if (bound.operationId === "mutateRows")
          await this.authoriseRepair(actor, bound.input);
      }
      if (operation === "updateViewPreferences") {
        const table = (
          await client.query(
            "SELECT database_id FROM rootset_control.tables WHERE id=$1 AND org_id=$2 AND state='active'",
            [normalizedInput.tableId, actor.orgId],
          )
        ).rows[0];
        if (!table) notFound();
        assertAccess(actor, {
          scope: "rows:read",
          personal: true,
          databaseId: table.database_id,
          tableId: String(normalizedInput.tableId),
        });
      }
      const result = await runMutation(
        client,
        actor,
        operation,
        normalizedInput,
        context.idempotencyKey ?? "",
        this.config.keyHashSecret,
        async () => {
          const output = await this.executeWithin(
            client,
            operation,
            actor,
            executionInput,
            { ...context, approvalClient: client },
          );
          const json = JSON.parse(JSON.stringify(output)) as unknown;
          return definition ? definition.outputSchema.parse(json) : json;
        },
      );
      return definition ? definition.outputSchema.parse(result) : result;
    };
    const result =
      operation === "completeAccountAction"
        ? await this.completeAction(
            actor,
            parse(z.strictObject({ id: IdSchema }), normalizedInput).id,
            context,
          )
        : await (context.approvalClient
            ? run(context.approvalClient)
            : withOrg(this.config.pool, actor.orgId, run));
    return JSON.parse(JSON.stringify(result)) as unknown;
  }
  private async executeWithin(
    client: PoolClient,
    operation: string,
    actor: Actor,
    input: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<unknown> {
    const personal = () =>
      assertAccess(actor, { scope: "profile:manage", personal: true });
    const security = () =>
      assertAccess(actor, { scope: "account:security", personal: true });
    const org = (scope: string, roles?: Role[]) =>
      assertAccess(actor, {
        scope,
        orgId: typeof input.orgId === "string" ? input.orgId : actor.orgId,
        roles,
      });
    switch (operation) {
      case "getContext":
        return {
          principal: {
            id: actor.id,
            kind: actor.kind,
            ...(actor.userId ? { userId: actor.userId } : {}),
            role: actor.role,
          },
          organisation: (
            await client.query(
              `SELECT id,name,created_at "createdAt",updated_at "updatedAt" FROM rootset_control.organisations WHERE id=$1`,
              [actor.orgId],
            )
          ).rows[0],
          scopes: actor.scopes,
          profile:
            actor.userId && actor.scopes.includes("profile:manage")
              ? await this.getProfile(client, actor.userId)
              : null,
          preferences:
            actor.userId && actor.scopes.includes("profile:manage")
              ? await this.readPreferences(client, actor.userId)
              : null,
          onboarding: {
            needsEmailVerification: false,
            setupComplete: (await this.setupStatus()).verified,
          },
        };
      case "getProfile":
        personal();
        return this.getProfile(client, actor.userId!);
      case "updateProfile": {
        personal();
        const update = parse(z.strictObject({ name: nameSchema }), input);
        await client.query(
          `UPDATE rootset_control.users SET name=$2,updated_at=now() WHERE id=$1`,
          [actor.userId, update.name],
        );
        return this.getProfile(client, actor.userId!);
      }
      case "getPreferences":
        personal();
        return this.readPreferences(client, actor.userId!);
      case "updatePreferences": {
        personal();
        const preferences = parse(PreferencesSchema, {
          ...(await this.readPreferences(client, actor.userId!)),
          ...parse(PreferencesSchema.partial(), input),
        });
        await client.query(
          `INSERT INTO rootset_control.user_preferences(user_id,timezone,locale,date_format,time_format,theme) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET timezone=$2,locale=$3,date_format=$4,time_format=$5,theme=$6,updated_at=now()`,
          [
            actor.userId,
            preferences.timezone,
            preferences.locale,
            preferences.dateFormat,
            preferences.timeFormat,
            preferences.theme,
          ],
        );
        return preferences;
      }
      case "getPreferenceOptions": {
        const selected =
          actor.userId && actor.scopes.includes("profile:manage")
            ? (await this.readPreferences(client, actor.userId)).timezone
            : undefined;
        return {
          timezones: [
            ...new Set([
              "UTC",
              ...Intl.supportedValuesOf("timeZone"),
              ...(selected ? [selected] : []),
            ]),
          ],
          locales: ["en", "en-GB", "en-IN"],
          dateFormats: ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"],
          timeFormats: ["12h", "24h"],
          themes: ["system", "light", "dark"],
        };
      }
      case "previewPreferences": {
        const data = parse(
            z.strictObject({
              preferences: PreferencesSchema,
              value: z.string().datetime(),
            }),
            input,
          ),
          p = data.preferences;
        return {
          utc: new Date(data.value).toISOString(),
          displayed: new Intl.DateTimeFormat(p.locale, {
            timeZone: p.timezone,
            dateStyle: "medium",
            timeStyle: "medium",
            hour12: p.timeFormat === "12h",
          }).format(new Date(data.value)),
          timezone: p.timezone,
        };
      }
      case "listSessions":
        security();
        return {
          data: (
            await client.query(
              `SELECT id,created_at,expires_at,user_agent,updated_at FROM rootset_control.sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC`,
              [actor.userId],
            )
          ).rows.map((r) => ({
            id: r.id,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
            lastActivityAt: r.updated_at,
            ...(r.user_agent ? { userAgent: r.user_agent } : {}),
            current: r.id === actor.id,
          })),
        };
      case "revokeSession": {
        security();
        const id = parse(IdSchema, input.id);
        const result = await client.query(
          `DELETE FROM rootset_control.sessions WHERE id=$1 AND user_id=$2 RETURNING id`,
          [id, actor.userId],
        );
        if (!result.rowCount) notFound();
        return { deleted: true };
      }
      case "listConnections":
        security();
        return {
          data: (
            await client.query(
              `SELECT id,client_id,resource,scopes,created_at,revoked_at FROM rootset_control.oauth_grants WHERE user_id=$1 AND org_id=$2 ORDER BY created_at DESC`,
              [actor.userId, actor.orgId],
            )
          ).rows.map((r) => ({
            id: r.id,
            clientId: r.client_id,
            clientName: r.client_id,
            orgId: actor.orgId,
            audience: r.resource,
            scopes: r.scopes,
            createdAt: r.created_at,
            expiresAt: new Date(
              new Date(r.created_at).getTime() + 30 * 86400000,
            ),
            revokedAt: r.revoked_at,
          })),
        };
      case "revokeConnection": {
        security();
        const id = parse(IdSchema, input.id);
        const result = await client.query(
          `UPDATE rootset_control.oauth_grants SET revoked_at=now() WHERE id=$1 AND org_id=$2 AND user_id=$3 RETURNING id`,
          [id, actor.orgId, actor.userId],
        );
        if (!result.rowCount) notFound();
        return { deleted: true };
      }
      case "beginAccountAction": {
        const { operationId: target, input: boundInput } =
          this.validateAccountActionRequest(actor, input, context);
        if (target === "mutateRows")
          await this.authoriseRepair(actor, boundInput);
        const id = newId(),
          expiresAt = new Date(Date.now() + 600000),
          requestDigest = this.requestDigest({
            operation: target,
            input: boundInput,
            actorId: actor.id,
            clientId: actor.clientId ?? null,
            userId: actor.userId,
            orgId: actor.orgId,
          });
        await client.query(
          `INSERT INTO rootset_control.account_actions(id,user_id,org_id,actor_id,client_id,operation,payload_encrypted,digest,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            actor.userId,
            actor.orgId,
            actor.id,
            actor.clientId ?? null,
            target,
            encryptProtected(boundInput, this.config),
            requestDigest,
            expiresAt,
          ],
        );
        return this.actionMetadata(
          { id, operation: target, expires_at: expiresAt },
          "pending",
          target === "mutateRows"
            ? undefined
            : {
                operationId: target,
                input: redact(boundInput),
                requestDigest,
                clientId: actor.clientId ?? null,
              },
          target === "mutateRows" ? repairIntent(boundInput) : undefined,
        );
      }
      case "getAccountAction": {
        const id = parse(IdSchema, input.id);
        const row = await client.query(
          `SELECT id,operation,expires_at,approved_at,consumed_at,result,payload_encrypted,digest,client_id FROM rootset_control.account_actions WHERE id=$1 AND user_id=$2 AND org_id=$3 AND (actor_id=$4 OR $5)`,
          [id, actor.userId, actor.orgId, actor.id, actor.kind === "session"],
        );
        if (!row.rows[0]) notFound();
        const item = row.rows[0];
        const repair =
          item.operation === "mutateRows" && !item.consumed_at
            ? decryptProtected<Record<string, unknown>>(
                item.payload_encrypted,
                this.config,
              )
            : undefined;
        if (repair) await this.authoriseRepair(actor, repair);
        return this.actionMetadata(
          item,
          item.consumed_at
            ? "consumed"
            : new Date(item.expires_at) < new Date()
              ? "expired"
              : item.approved_at
                ? "approved"
                : "pending",
          item.consumed_at
            ? (item.result ?? undefined)
            : repair
              ? undefined
              : (item.result ?? {
                  operationId: item.operation,
                  input: redact(
                    decryptProtected(item.payload_encrypted, this.config),
                  ),
                  requestDigest: item.digest,
                  clientId: item.client_id,
                }),
          repair ? repairIntent(repair) : undefined,
        );
      }
      case "getOrganisation":
        org("org:read");
        return (
          await client.query(
            `SELECT id,name,created_at "createdAt",updated_at "updatedAt" FROM rootset_control.organisations WHERE id=$1`,
            [actor.orgId],
          )
        ).rows[0];
      case "updateOrganisation": {
        org("org:manage", ["admin"]);
        const update = parse(
          z.strictObject({
            orgId: IdSchema.optional(),
            name: nameSchema.optional(),
          }),
          input,
        );
        await client.query(
          `UPDATE rootset_control.organisations SET name=COALESCE($2,name),updated_at=now() WHERE id=$1`,
          [actor.orgId, update.name ?? null],
        );
        return this.executeWithin(
          client,
          "getOrganisation",
          actor,
          {},
          context,
        );
      }
      case "listMembers":
        org("members:read", ["admin"]);
        return this.page(
          client,
          actor,
          operation,
          input,
          `SELECT m.id,m.org_id "orgId",m.user_id "userId",u.name,u.email,u.email_verified verified,u.two_factor_enabled "twoFactorEnabled",m.role,m.version::text FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE m.org_id=$1`,
          [actor.orgId],
        );
      case "updateMember":
      case "removeMember":
        return this.mutateMember(client, operation, actor, input, context);
      case "listInvitations":
        org("members:manage", ["admin"]);
        return this.page(
          client,
          actor,
          operation,
          input,
          `SELECT id,org_id "orgId",email,role,CASE WHEN state='pending' AND expires_at<=now() THEN 'expired' ELSE state END state,expires_at "expiresAt",created_at "createdAt" FROM rootset_control.invitations WHERE org_id=$1 AND ($2::text IS NULL OR CASE WHEN state='pending' AND expires_at<=now() THEN 'expired' ELSE state END=$2)`,
          [
            actor.orgId,
            input.state === undefined
              ? null
              : parse(InvitationSchema.shape.state, input.state),
          ],
        );
      case "inviteMember":
        return this.inviteMember(client, actor, input);
      case "cancelInvitation": {
        org("members:manage", ["admin"]);
        const id = parse(IdSchema, input.id);
        const result = await client.query(
          `UPDATE rootset_control.invitations SET state='cancelled' WHERE id=$1 AND org_id=$2 AND state='pending' RETURNING id`,
          [id, actor.orgId],
        );
        if (!result.rowCount) notFound();
        return { deleted: true };
      }
      case "listPersonalKeys": {
        assertAccess(actor, { scope: "keys:manage", personal: true });
        return this.page(
          client,
          actor,
          operation,
          input,
          `SELECT ${keyFields} FROM rootset_control.api_keys WHERE org_id=$1 AND user_id=$2`,
          [actor.orgId, actor.userId],
          (row) => mapKey(row, actor.orgId),
        );
      }
      case "createPersonalKey":
      case "rotatePersonalKey":
        return this.createOrRotateKey(client, operation, actor, input, context);
      case "revokePersonalKey":
        return this.revokeKey(client, actor, input);
      case "getSecurityStatus": {
        security();
        const factor = (
          await client.query(
            `SELECT backup_codes FROM rootset_control.auth_two_factors WHERE user_id=$1`,
            [actor.userId],
          )
        ).rows[0];
        return {
          twoFactorEnabled: (
            await client.query(
              `SELECT two_factor_enabled FROM rootset_control.users WHERE id=$1`,
              [actor.userId],
            )
          ).rows[0].two_factor_enabled,
          recoveryCodesRemaining: factor
            ? (JSON.parse(factor.backup_codes) as string[]).length
            : 0,
          passkeys: (
            await client.query(
              `SELECT id,COALESCE(name,'Passkey') name,created_at "createdAt",NULL::timestamptz "lastUsedAt" FROM rootset_control.auth_passkeys WHERE user_id=$1 ORDER BY created_at`,
              [actor.userId],
            )
          ).rows,
        };
      }
      case "getViewPreferences":
      case "updateViewPreferences": {
        const tableId = parse(IdSchema, input.tableId);
        const table = (
          await client.query(
            `SELECT database_id FROM rootset_control.tables WHERE id=$1 AND org_id=$2 AND state='active'`,
            [tableId, actor.orgId],
          )
        ).rows[0];
        if (!table) notFound();
        assertAccess(actor, {
          scope: "rows:read",
          personal: true,
          databaseId: table.database_id,
          tableId,
        });
        if (operation === "getViewPreferences") {
          const row = (
            await client.query(
              `SELECT preferences FROM rootset_control.view_preferences WHERE user_id=$1 AND table_id=$2 AND org_id=$3`,
              [actor.userId, tableId, actor.orgId],
            )
          ).rows[0];
          return {
            tableId,
            preferences: row?.preferences ?? {
              columnOrder: [],
              columnWidths: {},
              frozenColumns: 0,
              hiddenColumns: [],
            },
          };
        }
        const preferences = parse(ViewPreferencesSchema, input.preferences);
        const fields = new Set(
          (
            await client.query(
              `SELECT id FROM rootset_control.fields WHERE table_id=$1 AND org_id=$2 AND state='active'`,
              [tableId, actor.orgId],
            )
          ).rows.map((r) => r.id),
        );
        for (const fieldId of [
          ...preferences.columnOrder,
          ...preferences.hiddenColumns,
          ...Object.keys(preferences.columnWidths),
        ])
          if (!fields.has(fieldId))
            throw new RootsetError(
              "VALIDATION_FAILED",
              "View preferences refer to an unknown field",
            );
        if (
          new Set(preferences.columnOrder).size !==
            preferences.columnOrder.length ||
          new Set(preferences.hiddenColumns).size !==
            preferences.hiddenColumns.length ||
          preferences.frozenColumns > fields.size
        )
          throw new RootsetError(
            "VALIDATION_FAILED",
            "View column order, visibility or freeze count is invalid",
          );
        await client.query(
          `INSERT INTO rootset_control.view_preferences(user_id,org_id,table_id,preferences) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,table_id) DO UPDATE SET preferences=$4,updated_at=now()`,
          [actor.userId, actor.orgId, tableId, JSON.stringify(preferences)],
        );
        return { tableId, preferences };
      }
      case "changePassword":
        return this.changePassword(client, actor, input, context);
      case "changeEmail":
        return this.beginEmailChange(client, actor, input, context);
      case "signOutEverywhere": {
        security();
        const data = parse(signOutEverywhereInputSchema, input);
        await this.assertSensitive(actor, operation, input, context, client);
        const delegated = data.revokeDelegated !== false;
        await client.query(
          `DELETE FROM rootset_control.sessions WHERE user_id=$1`,
          [actor.userId],
        );
        if (delegated)
          await this.revokeAllUserAccess(actor.userId!, undefined, client);
        return { revoked: true };
      }
      case "registerPasskey":
      case "removePasskey":
      case "enableTwoFactor":
      case "disableTwoFactor":
      case "rotateRecoveryCodes":
        security();
        return {
          state: "interactive_proof_required",
          operationId: operation,
          proofUrl: `${this.config.baseURL}/settings/security`,
          actionId: context.actionId ?? null,
        };
      default:
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          `Identity operation ${operation} was not found`,
          404,
        );
    }
  }
  private async getProfile(
    client: PoolClient,
    userId: string,
  ): Promise<unknown> {
    const r = await client.query(
      `SELECT id,name,email,email_verified "emailVerified",created_at "createdAt",updated_at "updatedAt" FROM rootset_control.users WHERE id=$1`,
      [userId],
    );
    if (!r.rows[0]) notFound();
    return r.rows[0];
  }
  private async readPreferences(
    client: PoolClient,
    userId: string,
  ): Promise<Preferences> {
    const r = await client.query(
      `SELECT timezone,locale,date_format "dateFormat",time_format "timeFormat",theme FROM rootset_control.user_preferences WHERE user_id=$1`,
      [userId],
    );
    return r.rows[0] ?? defaultPreferences;
  }
  private checkActionAuthority(
    actor: Actor,
    operation: string,
    input: Record<string, unknown>,
  ): void {
    if (operation === "mutateRows") {
      if (input.repair === undefined)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Operator repair approval requires an explicit repair intent",
        );
      assertAccess(actor, {
        scope: "installation:manage",
        roles: ["admin"],
        personal: true,
      });
      assertAccess(actor, {
        scope: "rows:write",
        personal: true,
        databaseId: input.databaseId as string,
        tableId: input.tableId as string,
        level: "edit",
      });
    } else if (["createPersonalKey", "rotatePersonalKey"].includes(operation))
      assertAccess(actor, { scope: "keys:manage", personal: true });
    else if (["updateMember", "removeMember"].includes(operation))
      assertAccess(actor, {
        scope: "members:manage",
        roles: ["admin"],
        personal: true,
      });
    else if (operation === "deleteDatabase")
      assertAccess(actor, {
        scope: "databases:manage",
        databaseId: input.databaseId as string,
        level: "manage",
      });
    else if (operation === "deleteTable")
      assertAccess(actor, {
        scope: "tables:manage",
        databaseId: input.databaseId as string,
        tableId: input.tableId as string,
        level: "manage",
      });
    else if (
      ["setHistoryRetentionPolicy", "archiveHistory"].includes(operation)
    )
      assertAccess(actor, {
        scope: "schema:manage",
        databaseId: input.databaseId as string,
        tableId: input.tableId as string,
        level: "manage",
        roles: ["admin"],
      });
    else if (operation === "restoreBackup")
      assertAccess(actor, {
        scope: "backups:manage",
        databaseId: input.databaseId as string,
        roles: ["admin"],
      });
    else assertAccess(actor, { scope: "account:security", personal: true });
  }
  private async authoriseRepair(
    actor: Actor,
    input: Record<string, unknown>,
  ): Promise<void> {
    this.checkActionAuthority(actor, "mutateRows", input);
    if (!this.config.authoriseRepair)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "The shared operator repair authority check is unavailable",
        503,
      );
    await this.config.authoriseRepair(actor, input);
  }
  async recordRepairIntent(
    client: PoolClient,
    actor: Actor,
    intent: {
      jobId: string;
      tableId: string;
      reason: string;
      approvalId: string;
      requestId?: string;
    },
  ): Promise<void> {
    const reason = OperatorRepairReasonSchema.parse(intent.reason);
    const job = (
      await client.query(
        "SELECT id,org_id,operation_id,target_id,actor,input FROM rootset_control.jobs WHERE id=$1 AND org_id=$2 FOR UPDATE",
        [IdSchema.parse(intent.jobId), actor.orgId],
      )
    ).rows[0];
    const input = job?.input as Record<string, unknown> | undefined;
    const context = input?.operationContext as
      Record<string, unknown> | undefined;
    const owner = job?.actor as Actor | undefined;
    if (
      !job ||
      job.operation_id !== "mutateRows" ||
      job.target_id !== intent.tableId ||
      !owner ||
      owner.kind !== actor.kind ||
      owner.id !== actor.id ||
      owner.userId !== actor.userId ||
      owner.credentialId !== actor.credentialId ||
      owner.clientId !== actor.clientId ||
      (input?.repair as { reason?: string } | undefined)?.reason !== reason ||
      context?.approvalId !== intent.approvalId
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "Operator repair intent does not match its admitted job",
        403,
      );
    await this.authoriseRepair(
      await this.hydrateActor(actor, true, client),
      input!,
    );
    const approval = (
      await client.query(
        "SELECT id FROM rootset_control.account_actions WHERE id=$1 AND org_id=$2 AND user_id=$3 AND actor_id=$4 AND client_id IS NOT DISTINCT FROM $5 AND operation='mutateRows' AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at>now()",
        [
          IdSchema.parse(intent.approvalId),
          actor.orgId,
          actor.userId,
          actor.id,
          actor.clientId ?? null,
        ],
      )
    ).rows[0];
    if (!approval)
      throw new RootsetError(
        "STEP_UP_REQUIRED",
        "The approved operator repair is unavailable",
        403,
      );
    if ((context?.requestId ?? job.id) !== intent.requestId)
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "Repair intent belongs to a different request",
        409,
      );
  }
  private async completeAction(
    actor: Actor,
    id: string,
    context: ExecutionContext,
  ): Promise<unknown> {
    const r = await withOrg(this.config.pool, actor.orgId, (client) =>
      client.query(
        `SELECT * FROM rootset_control.account_actions WHERE id=$1 AND actor_id=$2 AND org_id=$3 AND user_id=$4 AND client_id IS NOT DISTINCT FROM $5`,
        [id, actor.id, actor.orgId, actor.userId, actor.clientId ?? null],
      ),
    );
    const action = r.rows[0];
    if (!action) notFound();
    if (action.consumed_at)
      return this.actionMetadata(
        action,
        "consumed",
        action.result ?? undefined,
      );
    if (!action.approved_at || new Date(action.expires_at) < new Date())
      throw new RootsetError(
        "STEP_UP_REQUIRED",
        "Approve the action in the browser before completing it",
        403,
      );
    const input = decryptProtected<Record<string, unknown>>(
      action.payload_encrypted,
      this.config,
    );
    this.checkActionAuthority(actor, action.operation, input);
    const external = [
      "deleteDatabase",
      "deleteTable",
      "restoreBackup",
      "setHistoryRetentionPolicy",
      "archiveHistory",
      "mutateRows",
    ].includes(action.operation);
    const result = await withOrg(
      this.config.pool,
      actor.orgId,
      async (client) => {
        if (external) {
          if (!this.externalExecutor)
            throw new RootsetError(
              "CONFIGURATION_INVALID",
              "The shared operation executor is unavailable",
              503,
            );
          const output = await this.externalExecutor(
            action.operation,
            actor,
            input,
            {
              ...context,
              actionId: id,
              approvalClient: client,
              idempotencyKey: `account-action:${id}`,
            },
          );
          await client.query(
            `UPDATE rootset_control.account_actions SET consumed_at=COALESCE(consumed_at,now()),payload_encrypted='',result=$2 WHERE id=$1`,
            [id, JSON.stringify(stripSecrets(output))],
          );
          return output;
        }
        if (keyIssuanceOperations.has(action.operation)) {
          const replay = await this.prepareKeyReceipt(
            client,
            action.operation,
            actor,
            input,
            {
              ...context,
              actionId: id,
              idempotencyKey: context.idempotencyKey ?? `account-action:${id}`,
            },
          );
          if (replay) return replay;
        }
        const locked = await client.query(
          `SELECT consumed_at,result FROM rootset_control.account_actions WHERE id=$1 FOR UPDATE`,
          [id],
        );
        if (locked.rows[0].consumed_at) return locked.rows[0].result;
        const output = await this.executeWithin(
          client,
          action.operation,
          actor,
          input,
          {
            ...context,
            actionId: id,
            approvalClient: client,
            idempotencyKey: context.idempotencyKey ?? `account-action:${id}`,
          },
        );
        if (!(
          output &&
          typeof output === "object" &&
          "state" in output &&
          output.state === "interactive_proof_required"
        ))
          await client.query(
            `UPDATE rootset_control.account_actions SET consumed_at=now(),payload_encrypted='' WHERE id=$1`,
            [id],
          );
        const stored = stripSecrets(output);
        await client.query(
          `UPDATE rootset_control.account_actions SET result=$2 WHERE id=$1`,
          [id, JSON.stringify(stored)],
        );
        return output;
      },
    );
    return this.actionMetadata(
      action,
      result &&
        typeof result === "object" &&
        "state" in result &&
        result.state === "interactive_proof_required"
        ? "approved"
        : "consumed",
      result,
    );
  }
  private async lockUserAuthorities(
    client: PoolClient,
    userIds: string[],
  ): Promise<void> {
    for (const userId of [...new Set(userIds)].sort())
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`rootset:user-authority:${userId}`],
      );
  }
  private async assertLastAdmin(
    client: PoolClient,
    orgId: string,
    userId: string,
  ): Promise<void> {
    const current = (
      await client.query(
        `SELECT role FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2 FOR UPDATE`,
        [orgId, userId],
      )
    ).rows[0];
    if (current?.role !== "admin") return;
    const other = await client.query(
      `SELECT m.id FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.role='admin' AND u.email_verified AND m.user_id<>$2`,
      [orgId, userId],
    );
    if (!other.rowCount)
      throw new RootsetError(
        "LAST_ADMIN",
        "At least one verified Admin must remain",
        409,
      );
  }
  private async mutateMember(
    client: PoolClient,
    operation: string,
    actor: Actor,
    input: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<unknown> {
    assertAccess(actor, {
      scope: "members:manage",
      orgId: input.orgId as string | undefined,
      roles: ["admin"],
    });
    await this.assertSensitive(actor, operation, input, context, client);
    const update = parse(
      z.strictObject({
        id: IdSchema,
        orgId: IdSchema.optional(),
        role: z.enum(["admin", "editor", "viewer"]).optional(),
        name: nameSchema.optional(),
        expectedVersion: z.string().regex(/^[1-9][0-9]*$/),
      }),
      input,
    );
    await client.query(
      `SELECT id FROM rootset_control.organisations WHERE id=$1 FOR UPDATE`,
      [actor.orgId],
    );
    const currentAdmin = (
      await client.query(
        `SELECT m.role,u.email_verified FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2`,
        [actor.orgId, actor.userId],
      )
    ).rows[0];
    if (currentAdmin?.role !== "admin" || !currentAdmin.email_verified)
      throw new RootsetError(
        "ACCESS_DENIED",
        "Current Admin authority is required",
        403,
      );
    const locator = (
      await client.query(
        `SELECT user_id FROM rootset_control.memberships WHERE id=$1 AND org_id=$2`,
        [update.id, actor.orgId],
      )
    ).rows[0];
    if (!locator) notFound();
    await this.lockUserAuthorities(client, [locator.user_id]);
    const target = (
      await client.query(
        `SELECT * FROM rootset_control.memberships WHERE id=$1 AND org_id=$2 FOR UPDATE`,
        [update.id, actor.orgId],
      )
    ).rows[0];
    if (!target) notFound();
    if (String(target.version) !== update.expectedVersion)
      throw new RootsetError(
        "ROW_VERSION_CONFLICT",
        "Membership changed; reload before editing",
        409,
      );
    const removing = operation === "removeMember";
    if (removing || (update.role && update.role !== "admin"))
      await this.assertLastAdmin(client, actor.orgId, target.user_id);
    if (removing) {
      await client.query(
        `DELETE FROM rootset_control.view_preferences WHERE org_id=$1 AND user_id=$2`,
        [actor.orgId, target.user_id],
      );
      await this.revokeAllUserAccess(target.user_id, undefined, client);
      await client.query(
        `DELETE FROM rootset_control.memberships WHERE id=$1 AND org_id=$2`,
        [target.id, actor.orgId],
      );
    } else {
      if (!update.role && !update.name)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "A member name or role is required",
        );
      await client.query(
        `UPDATE rootset_control.memberships SET role=COALESCE($3,role),version=version+1,updated_at=now() WHERE id=$1 AND org_id=$2`,
        [target.id, actor.orgId, update.role ?? null],
      );
      if (update.name)
        await client.query(
          `UPDATE rootset_control.users SET name=$2,updated_at=now() WHERE id=$1`,
          [target.user_id, update.name],
        );
    }
    return removing
      ? { deleted: true }
      : (
          await client.query(
            `SELECT m.id,m.org_id "orgId",m.user_id "userId",u.name,u.email,u.email_verified verified,u.two_factor_enabled "twoFactorEnabled",m.role,m.version::text FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE m.id=$1 AND m.org_id=$2`,
            [target.id, actor.orgId],
          )
        ).rows[0];
  }
  private async inviteMember(
    client: PoolClient,
    actor: Actor,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    assertAccess(actor, {
      scope: "members:manage",
      orgId: input.orgId as string | undefined,
      roles: ["admin"],
      personal: true,
    });
    const data = parse(
      z.strictObject({
        orgId: IdSchema.optional(),
        email: emailSchema,
        role: z.enum(["admin", "editor", "viewer"]),
      }),
      input,
    );
    const id = newId(),
      token = randomBytes(32).toString("base64url"),
      expiresAt = new Date(Date.now() + 7 * 86400000);
    const existing = await client.query(
      `SELECT 1 FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE org_id=$1 AND u.email=$2`,
      [actor.orgId, data.email],
    );
    if (existing.rowCount)
      throw new RootsetError(
        "MEMBERSHIP_EXISTS",
        "This email is already a member",
        409,
      );
    await client.query(
      `INSERT INTO rootset_control.invitations(id,org_id,email,role,inviter_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        actor.orgId,
        data.email,
        data.role,
        actor.userId,
        this.hashSecret(token),
        expiresAt,
      ],
    );
    const organisation = (
      await client.query(
        `SELECT name FROM rootset_control.organisations WHERE id=$1`,
        [actor.orgId],
      )
    ).rows[0];
    await this.emailOutbox.enqueue(client, {
      template: "invitation",
      to: data.email,
      payload: {
        organisationName: organisation.name,
        actionUrl: `${this.config.baseURL}/invitations/${token}`,
        expiresAt: expiresAt.toISOString(),
      },
      dedupeKey: `invitation:${id}`,
      expiresAt,
    });
    return {
      id,
      orgId: actor.orgId,
      email: data.email,
      role: data.role,
      state: "pending",
      expiresAt,
      createdAt: new Date(),
    };
  }
  private async handleInvitation(
    request: Request,
    path: string,
  ): Promise<Response> {
    const token =
      path === "/invitations/accept"
        ? ((await request.clone().json()) as { token?: string }).token
        : path.slice("/invitations/".length);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) notFound();
    const hash = this.hashSecret(token!),
      locator = await this.config.pool.query(
        `SELECT org_id FROM rootset_control.invitation_locator($1)`,
        [hash],
      );
    if (!locator.rows[0]) notFound();
    const orgId = locator.rows[0].org_id as string;
    const invitation = await withOrg(
      this.config.pool,
      orgId,
      async (client) => {
        const r = await client.query(
          `SELECT i.*,o.name organisation_name,m.role inviter_role,u.email_verified inviter_verified FROM rootset_control.invitations i JOIN rootset_control.organisations o ON o.id=i.org_id AND o.singleton LEFT JOIN rootset_control.memberships m ON m.org_id=i.org_id AND m.user_id=i.inviter_id LEFT JOIN rootset_control.users u ON u.id=m.user_id WHERE i.token_hash=$1`,
          [hash],
        );
        return r.rows[0];
      },
    );
    if (
      !invitation ||
      invitation.state === "cancelled" ||
      new Date(invitation.expires_at) < new Date() ||
      !invitation.inviter_verified ||
      !["admin"].includes(invitation.inviter_role)
    )
      throw new RootsetError(
        "INVITATION_UNAVAILABLE",
        "Invitation is unavailable",
        410,
      );
    if (request.method === "GET")
      return Response.json({
        email: invitation.email,
        role: invitation.role,
        organisationName: invitation.organisation_name,
        expiresAt: invitation.expires_at,
        state: invitation.state,
      });
    if (path !== "/invitations/accept" || request.method !== "POST") notFound();
    const session = await this.rawAuth.api.getSession({
      headers: request.headers,
    });
    if (!session) {
      const data = parse(
        z.strictObject({
          token: z.string(),
          name: nameSchema,
          password: passwordSchema,
        }),
        await request.json(),
      );
      const existing = await this.config.pool.query(
        `SELECT id FROM rootset_control.users WHERE email=$1`,
        [invitation.email],
      );
      if (!existing.rowCount)
        await pendingProvision.run({ reason: "invitation" }, () =>
          this.rawAuth.api.signUpEmail({
            body: {
              name: data.name,
              email: invitation.email,
              password: data.password,
            },
          }),
        );
      await this.rawAuth.api.sendVerificationEmail({
        body: {
          email: invitation.email,
          callbackURL: `${this.config.baseURL}/invitations/${token}`,
        },
      });
      return Response.json(
        {
          state: "verification_required",
          message:
            "Verify the invited email, sign in, and accept this invitation",
        },
        { status: 202 },
      );
    }
    if (
      session.user.email.toLowerCase() !== invitation.email ||
      !session.user.emailVerified
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "Sign in with the verified invited email",
        403,
      );
    const result = await withOrg(this.config.pool, orgId, async (client) => {
      await client.query(
        `SELECT id FROM rootset_control.organisations WHERE id=$1 FOR UPDATE`,
        [orgId],
      );
      await this.lockUserAuthorities(client, [session.user.id]);
      const current = await client.query(
        `SELECT * FROM rootset_control.invitations WHERE id=$1 FOR UPDATE`,
        [invitation.id],
      );
      const item = current.rows[0];
      if (item.state === "accepted") {
        if (item.accepted_by !== session.user.id)
          throw new RootsetError(
            "ACCESS_DENIED",
            "Invitation was already accepted",
            403,
          );
        return { state: "accepted", orgId, alreadyAccepted: true };
      }
      const user = (
        await client.query(
          `SELECT email,email_verified FROM rootset_control.users WHERE id=$1 FOR UPDATE`,
          [session.user.id],
        )
      ).rows[0];
      if (!user || !user.email_verified || user.email !== item.email)
        throw new RootsetError(
          "ACCESS_DENIED",
          "The verified invited account is unavailable",
          403,
        );
      const inviter = await client.query(
        `SELECT m.role FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id AND u.email_verified WHERE m.org_id=$1 AND m.user_id=$2`,
        [orgId, item.inviter_id],
      );
      if (
        item.state !== "pending" ||
        new Date(item.expires_at) < new Date() ||
        !["admin"].includes(inviter.rows[0]?.role)
      )
        throw new RootsetError(
          "INVITATION_UNAVAILABLE",
          "Invitation is unavailable",
          410,
        );
      await client.query(
        `INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,user_id) DO NOTHING`,
        [newId(), orgId, session.user.id, item.role],
      );
      await client.query(
        `UPDATE rootset_control.invitations SET state='accepted',accepted_by=$2 WHERE id=$1`,
        [item.id, session.user.id],
      );
      return { state: "accepted", orgId };
    });
    return Response.json(result);
  }
  private async prepareKeyReceipt(
    client: PoolClient,
    operation: string,
    actor: Actor,
    input: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<z.infer<typeof KeyCreatedSchema> | null> {
    await this.lockUserAuthorities(client, [actor.userId!]);
    actor = await this.hydrateActor(actor, true, client);
    this.checkActionAuthority(actor, operation, input);
    if (typeof input.orgId === "string" && input.orgId !== actor.orgId)
      notFound();
    if (!context.idempotencyKey)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Idempotency-Key is required for key creation or rotation",
      );
    const requestDigest = this.requestDigest({
      protocol: "key-receipt:v2",
      operation,
      input,
      actorKind: actor.kind,
      actorId: actor.id,
      orgId: actor.orgId,
      userId: actor.userId ?? null,
      credentialId: actor.credentialId ?? null,
      clientId: actor.clientId ?? null,
      actionId: context.actionId ?? null,
    });
    await client.query(
      `INSERT INTO rootset_control.key_requests(actor_id,org_id,operation,key,digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [actor.id, actor.orgId, operation, context.idempotencyKey, requestDigest],
    );
    const receipt = (
      await client.query(
        `SELECT digest,result FROM rootset_control.key_requests WHERE actor_id=$1 AND org_id=$2 AND operation=$3 AND key=$4 FOR UPDATE`,
        [actor.id, actor.orgId, operation, context.idempotencyKey],
      )
    ).rows[0];
    if (receipt.digest !== requestDigest)
      throw new RootsetError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key belongs to a different request",
        409,
      );
    if (!receipt.result) return null;
    const replay = KeyCreatedSchema.parse(receipt.result);
    for (const id of [
      replay.key.id,
      ...(operation.startsWith("rotate") ? [parse(IdSchema, input.id)] : []),
    ]) {
      if (
        !(
          await client.query(
            `SELECT 1 FROM rootset_control.api_keys WHERE id=$1 AND org_id=$2 AND user_id=$3`,
            [id, actor.orgId, actor.userId],
          )
        ).rowCount
      )
        notFound();
    }
    return { key: replay.key, replayed: true };
  }
  private async createOrRotateKey(
    client: PoolClient,
    operation: string,
    actor: Actor,
    input: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<unknown> {
    assertAccess(actor, { scope: "keys:manage", personal: true });
    if (!context.idempotencyKey)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Idempotency-Key is required for key creation or rotation",
      );
    const data = parse(
      z.strictObject({
        orgId: IdSchema.optional(),
        id: IdSchema.optional(),
        name: nameSchema.optional(),
        expiresAt: z.string().datetime().nullable().optional(),
        overlapSeconds: z.number().int().min(0).max(86400).default(0),
      }),
      input,
    );
    const replay = await this.prepareKeyReceipt(
      client,
      operation,
      actor,
      input,
      context,
    );
    if (replay) return replay;
    let old: Record<string, unknown> | undefined;
    if (operation.startsWith("rotate")) {
      if (!data.id)
        throw new RootsetError("VALIDATION_FAILED", "Key id is required");
      old = (
        await client.query(
          `SELECT * FROM rootset_control.api_keys WHERE id=$1 AND org_id=$2 AND user_id=$3 AND revoked_at IS NULL FOR UPDATE`,
          [data.id, actor.orgId, actor.userId],
        )
      ).rows[0];
      if (!old) notFound();
    }
    const name = data.name ?? old?.name;
    if (!name) throw new RootsetError("VALIDATION_FAILED", "Name is required");
    const expiry =
      data.expiresAt !== undefined
        ? data.expiresAt
        : old
          ? old.expires_at
          : new Date(Date.now() + 90 * 86400000);
    const expiresAt =
      expiry === null ? null : new Date(expiry as string | Date);
    if (expiresAt && expiresAt <= new Date())
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Expiry must be in the future",
      );
    await this.assertSensitive(actor, operation, input, context, client);
    const id = newId(),
      secret = `rst_${id}_${randomBytes(32).toString("base64url")}`;
    const result = await client.query(
      `INSERT INTO rootset_control.api_keys(id,org_id,user_id,creator_user_id,name,secret_hash,prefix,expires_at,rotated_from) VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8) RETURNING ${keyFields}`,
      [
        id,
        actor.orgId,
        actor.userId,
        name,
        this.hashSecret(secret),
        `rst_${id}`,
        expiresAt,
        old?.id ?? null,
      ],
    );
    const metadata = mapKey(result.rows[0]!, actor.orgId);
    if (old)
      await client.query(
        `UPDATE rootset_control.api_keys SET revoked_at=CASE WHEN $2=0 THEN now() ELSE NULL END,expires_at=CASE WHEN $2>0 THEN LEAST(COALESCE(expires_at,'infinity'::timestamptz),now()+($2 * interval '1 second')) ELSE expires_at END WHERE id=$1 AND user_id=$3`,
        [old.id, data.overlapSeconds, actor.userId],
      );
    await client.query(
      `UPDATE rootset_control.key_requests SET result=$5 WHERE actor_id=$1 AND org_id=$2 AND operation=$3 AND key=$4`,
      [
        actor.id,
        actor.orgId,
        operation,
        context.idempotencyKey,
        JSON.stringify({ key: metadata }),
      ],
    );
    return { key: metadata, secret };
  }
  private async revokeKey(
    client: PoolClient,
    actor: Actor,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    assertAccess(actor, { scope: "keys:manage", personal: true });
    const id = parse(IdSchema, input.id);
    if (
      !(
        await client.query(
          `UPDATE rootset_control.api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND org_id=$2 AND user_id=$3 RETURNING id`,
          [id, actor.orgId, actor.userId],
        )
      ).rowCount
    )
      notFound();
    return { deleted: true };
  }
  private async changePassword(
    client: PoolClient,
    actor: Actor,
    input: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<unknown> {
    assertAccess(actor, { scope: "account:security", personal: true });
    const data = parse(
      z.strictObject({
        currentPassword: z.string(),
        newPassword: passwordSchema,
      }),
      input,
    );
    await this.assertSensitive(actor, "changePassword", input, context, client);
    const account = (
      await client.query(
        `SELECT id,password FROM rootset_control.auth_accounts WHERE user_id=$1 AND provider_id='credential' FOR UPDATE`,
        [actor.userId],
      )
    ).rows[0];
    if (
      !account?.password ||
      !(await verifyPassword({
        password: data.currentPassword,
        hash: account.password,
      }))
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "Password verification failed",
        403,
      );
    await client.query(
      `UPDATE rootset_control.auth_accounts SET password=$2,updated_at=now() WHERE id=$1`,
      [account.id, await hashPassword(data.newPassword)],
    );
    await this.revokeAllUserAccess(actor.userId!, undefined, client);
    const user = (
      await client.query(
        `SELECT email,name FROM rootset_control.users WHERE id=$1`,
        [actor.userId],
      )
    ).rows[0];
    await this.emailOutbox.enqueue(client, {
      template: "password-changed",
      to: user.email,
      payload: { name: user.name },
      dedupeKey: `password-change:${actor.userId}:${newId()}`,
    });
    return { changed: true };
  }
  private async beginEmailChange(
    client: PoolClient,
    actor: Actor,
    input: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<unknown> {
    assertAccess(actor, { scope: "account:security", personal: true });
    const data = parse(z.strictObject({ newEmail: emailSchema }), input);
    await this.assertSensitive(actor, "changeEmail", input, context, client);
    const user = (
      await client.query(
        `SELECT email,name FROM rootset_control.users WHERE id=$1 FOR UPDATE`,
        [actor.userId],
      )
    ).rows[0];
    if (user.email === data.newEmail)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "The new email must be different",
      );
    const id = newId(),
      token = randomBytes(32).toString("base64url"),
      expiresAt = new Date(Date.now() + 3600000);
    await client.query(
      `INSERT INTO rootset_control.email_changes(id,user_id,previous_email,new_email,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET id=$1,previous_email=$3,new_email=$4,token_hash=$5,expires_at=$6,created_at=now()`,
      [
        id,
        actor.userId,
        user.email,
        data.newEmail,
        this.hashSecret(token),
        expiresAt,
      ],
    );
    await this.emailOutbox.enqueue(client, {
      template: "email-change-verification",
      to: data.newEmail,
      payload: {
        name: user.name,
        actionUrl: `${this.config.baseURL}/email-change?token=${token}`,
        expiresAt: expiresAt.toISOString(),
      },
      dedupeKey: `email-change:${id}`,
      expiresAt,
    });
    return { state: "verification_required", expiresAt };
  }
  private async pendingEmailChange(request: Request): Promise<Response> {
    if (!["GET", "DELETE"].includes(request.method))
      return Response.json(
        { error: { code: "METHOD_NOT_ALLOWED", message: "Use GET or DELETE" } },
        { status: 405, headers: { Allow: "GET, DELETE" } },
      );
    const actor = await this.resolveActor(request, "browser");
    if (!actor?.userId)
      throw new RootsetError("UNAUTHENTICATED", "Sign in to continue", 401);
    assertAccess(actor, { scope: "account:security", personal: true });
    const result = await withOrg(
      this.config.pool,
      actor.orgId,
      async (client) => {
        if (request.method === "DELETE") {
          const removed = await client.query(
            `DELETE FROM rootset_control.email_changes WHERE user_id=$1 RETURNING id`,
            [actor.userId],
          );
          if (removed.rows[0])
            await client.query(
              `UPDATE rootset_control.email_outbox SET state='failed',expires_at=now(),last_error='Email change cancelled' WHERE dedupe_key=$1 AND state IN ('pending','failed')`,
              [`email-change:${removed.rows[0].id}`],
            );
          return { pending: null };
        }
        const pending = (
          await client.query(
            `SELECT new_email,expires_at FROM rootset_control.email_changes WHERE user_id=$1 AND expires_at>now()`,
            [actor.userId],
          )
        ).rows[0];
        return {
          pending: pending
            ? { email: pending.new_email, expiresAt: pending.expires_at }
            : null,
        };
      },
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  }
  private async confirmEmailChange(request: Request): Promise<Response> {
    const token =
      request.method === "GET"
        ? new URL(request.url).searchParams.get("token")
        : ((await request.json()) as { token?: string }).token;
    if (!token)
      throw new RootsetError("VALIDATION_FAILED", "Token is required");
    const result = await transaction(this.config.pool, async (client) => {
      const result = await client.query(
        `SELECT * FROM rootset_control.email_changes WHERE token_hash=$1 AND expires_at>now() FOR UPDATE`,
        [this.hashSecret(token)],
      );
      const change = result.rows[0];
      if (!change)
        throw new RootsetError(
          "TOKEN_UNAVAILABLE",
          "Email verification has expired or was already used",
          410,
        );
      const user = (
        await client.query(
          `SELECT name,email FROM rootset_control.users WHERE id=$1 FOR UPDATE`,
          [change.user_id],
        )
      ).rows[0];
      if (!user || user.email !== change.previous_email)
        throw new RootsetError(
          "TOKEN_UNAVAILABLE",
          "Email change is unavailable",
          410,
        );
      try {
        await client.query(
          `UPDATE rootset_control.users SET email=$2,email_verified=true,updated_at=now() WHERE id=$1`,
          [change.user_id, change.new_email],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505")
          throw new RootsetError(
            "EMAIL_UNAVAILABLE",
            "The requested email is unavailable",
            409,
          );
        throw error;
      }
      await client.query(
        `DELETE FROM rootset_control.email_changes WHERE id=$1`,
        [change.id],
      );
      await client.query(
        `DELETE FROM rootset_control.sessions WHERE user_id=$1`,
        [change.user_id],
      );
      for (const email of [change.previous_email, change.new_email])
        await this.emailOutbox.enqueue(client, {
          template: "email-changed",
          to: email,
          payload: { name: user.name },
          dedupeKey: `email-notice:${change.id}:${email}`,
        });
      return { userId: change.user_id };
    });
    await this.revokeAllUserAccess(result.userId);
    return Response.json({ changed: true });
  }
  private async reauthenticate(request: Request): Promise<Response> {
    const actor = await this.resolveActor(request, "browser");
    if (!actor?.userId)
      throw new RootsetError("UNAUTHENTICATED", "Sign in to continue", 401);
    const data = parse(
      z.strictObject({ password: z.string(), code: z.string().optional() }),
      await request.json(),
    );
    const account = (
      await this.config.pool.query(
        `SELECT a.password,u.two_factor_enabled FROM rootset_control.auth_accounts a JOIN rootset_control.users u ON u.id=a.user_id WHERE a.user_id=$1 AND a.provider_id='credential'`,
        [actor.userId],
      )
    ).rows[0];
    if (
      !account?.password ||
      !(await verifyPassword({
        password: data.password,
        hash: account.password,
      }))
    )
      throw new RootsetError("ACCESS_DENIED", "Authentication failed", 403);
    if (account.two_factor_enabled) {
      if (!data.code)
        throw new RootsetError(
          "FACTOR_REQUIRED",
          "Enter your authenticator code",
          403,
        );
      const factorRequest = new Request(
        `${this.config.baseURL}/v1/auth/two-factor/verify-totp`,
        {
          method: "POST",
          headers: new Headers(request.headers),
          body: JSON.stringify({ code: data.code }),
        },
      );
      factorRequest.headers.set("content-type", "application/json");
      const response = await this.handleAuth(factorRequest);
      if (!response.ok)
        throw new RootsetError(
          "ACCESS_DENIED",
          "Factor verification failed",
          403,
        );
    }
    const authenticatedAt = Date.now();
    await this.config.pool.query(
      `UPDATE rootset_control.sessions SET authenticated_at=$2 WHERE id=$1 AND user_id=$3`,
      [actor.id, new Date(authenticatedAt), actor.userId],
    );
    return Response.json({ authenticatedAt });
  }
  async recoverUser(
    userId: string,
    options: { reason: string },
  ): Promise<void> {
    parse(IdSchema, userId);
    if (!options.reason.trim())
      throw new RootsetError(
        "VALIDATION_FAILED",
        "A recovery reason is required",
      );
    await transaction(this.config.pool, async (client) => {
      await this.lockUserAuthorities(client, [userId]);
      const user = (
        await client.query(
          `SELECT email,name FROM rootset_control.users WHERE id=$1 FOR UPDATE`,
          [userId],
        )
      ).rows[0];
      if (!user) notFound();
      await client.query(
        `DELETE FROM rootset_control.auth_two_factors WHERE user_id=$1`,
        [userId],
      );
      await client.query(
        `DELETE FROM rootset_control.auth_passkeys WHERE user_id=$1`,
        [userId],
      );
      await client.query(
        `UPDATE rootset_control.users SET two_factor_enabled=false WHERE id=$1`,
        [userId],
      );
      await this.revokeAllUserAccess(userId, undefined, client);
      await this.emailOutbox.enqueue(client, {
        template: "account-recovery",
        to: user.email,
        payload: { name: user.name },
        dedupeKey: `operator-recovery:${userId}:${newId()}`,
      });
    });
  }
  async restoreAdmin(
    orgId: string,
    userId: string,
    options: { reason: string },
  ): Promise<void> {
    parse(IdSchema, orgId);
    parse(IdSchema, userId);
    if (!options.reason.trim())
      throw new RootsetError(
        "VALIDATION_FAILED",
        "A recovery reason is required",
      );
    await withOrg(this.config.pool, orgId, async (client) => {
      const organisation = (
        await client.query(
          `SELECT name FROM rootset_control.organisations WHERE id=$1 FOR UPDATE`,
          [orgId],
        )
      ).rows[0];
      if (!organisation)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Admin recovery requires the installation organisation",
        );
      await this.lockUserAuthorities(client, [userId]);
      const user = (
        await client.query(
          `SELECT email_verified,email,name FROM rootset_control.users WHERE id=$1 FOR UPDATE`,
          [userId],
        )
      ).rows[0];
      if (!user?.email_verified)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Admin recovery requires a verified identity",
        );
      await client.query(
        `INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'admin') ON CONFLICT(org_id,user_id) DO UPDATE SET role='admin',version=memberships.version+1,updated_at=now()`,
        [newId(), orgId, userId],
      );
      await this.emailOutbox.enqueue(client, {
        template: "account-recovery",
        to: user.email,
        payload: {
          name: user.name,
          organisationName: organisation.name,
          details: "Installation Admin membership was restored.",
        },
        dedupeKey: `admin-recovery:${orgId}:${userId}:${newId()}`,
      });
    });
  }
}
export function createIdentityService(config: IdentityConfig): IdentityService {
  return new IdentityService(config);
}
