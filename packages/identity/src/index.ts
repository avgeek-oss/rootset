import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { PasswordPolicy } from "./password-policy.js";
import { executeSavedViews } from "./saved-views.js";
import {
  passwordSecondFactor,
  completePasskeySecondFactor,
} from "./password-second-factor.js";
import { replaceRecoveryCodes, ensureRecoveryCodes } from "./recovery-codes.js";
import {
  enqueueVerificationEmail,
  requestPublicVerificationEmail,
} from "./email-verification.js";
import { passkey } from "@better-auth/passkey";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  ALL_SCOPES,
  keyRole,
  keyScopes,
  teamKeyScopes,
  assertAccess,
  roleAllows,
  type Actor,
  type Role,
} from "@rootset/access";
import {
  AccountNameSchema,
  IdSchema,
  InvitationSchema,
  KeyCreatedSchema,
  PreferencesSchema,
  DateTimeSchema,
  defaultDateTimePreferences,
  dateFormatOptions,
  timeFormatOptions,
  availableTimeZones,
  createDateTimeFormatter,
  RootsetError,
  ViewPreferencesSchema,
  operationMap,
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
import { identityMutationSet, runMutation } from "@rootset/idempotency";
export { identityMutationSet } from "@rootset/idempotency";
import {
  EmailOutbox,
  type EmailConfig,
  type EmailPayload,
  type EmailTemplate,
} from "@rootset/email";

export interface IdentityConfig extends EmailConfig {
  webURL?: string;
  pool: Pool;
  secret: string;
  bootstrapSecret: string;
  keyHashSecret: string;
  oauthResolver?: (request: Request, audience: string) => Promise<Actor | null>;
}
export interface ExecutionContext {
  requestId?: string;
  idempotencyKey?: string;
  jobId?: string;
  surface?: "browser" | "rest" | "api" | "mcp" | "worker";
  client?: PoolClient;
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
const nameSchema = AccountNameSchema;
const emailSchema = z.string().trim().toLowerCase().email().max(320);
const passwordSchema = z.string().min(15).max(1024);
const signOutEverywhereInputSchema = z.strictObject({
  revokeDelegated: z.boolean().optional(),
});
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
const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const notFound = (): never => {
  throw new RootsetError("RESOURCE_NOT_FOUND", "Resource was not found", 404);
};
const keyFields = `scope,access,include_admin,id,name,user_id,creator_user_id,prefix,expires_at,revoked_at,last_used_at,created_at,rotated_from`;
const mapKey = (r: Record<string, unknown>, orgId: string) => ({
  id: r.id,
  orgId,
  name: r.name,
  scope: r.scope,
  access: r.access,
  includeAdmin: r.include_admin,
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
  dateFormat: defaultDateTimePreferences.dateFormat,
  timeFormat: defaultDateTimePreferences.timeFormat,
  theme: "system",
};
const factorRoutes: Record<string, string> = {
  "/passkey/generate-register-options": "registerPasskey",
  "/passkey/verify-registration": "registerPasskey",
  "/passkey/delete-passkey": "removePasskey",
  "/passkey/replace-recovery-codes": "rotateRecoveryCodes",
};
const identityRoutes = new Set([
  "GET /get-session",
  "POST /sign-in/email",
  "POST /sign-out",
  "POST /request-password-reset",
  "POST /reset-password",
  "GET /verify-email",
  "POST /request-verification-email",
  "POST /send-verification-email",
  "POST /reauthenticate",
  "POST /change-password",
  "POST /change-email",
  "POST /sign-out-everywhere",
  "GET /email-change",
  "DELETE /email-change",
  "POST /email-change/inspect",
  "POST /email-change/confirm",
  "GET /passkey/generate-authenticate-options",
  "POST /passkey/verify-authentication",
  "POST /passkey/verify-recovery-code",
  "GET /passkey/generate-register-options",
  "POST /passkey/verify-registration",
  "POST /passkey/delete-passkey",
  "POST /passkey/update-passkey",
  "GET /passkey/list-user-passkeys",
  "POST /passkey/replace-recovery-codes",
]);

export class IdentityService {
  readonly emailOutbox: EmailOutbox;
  private readonly passwords: PasswordPolicy;
  private readonly rawAuth;
  readonly auth;
  private paging?: IdentityPaging;
  setPaging(paging: IdentityPaging): void {
    this.paging = paging;
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
    this.emailOutbox = new EmailOutbox(config.pool, {
      ...config,
      baseURL: config.webURL ?? config.baseURL,
      allowedActionOrigins: [new URL(config.baseURL).origin],
    });
    this.passwords = new PasswordPolicy();
    const database = drizzle(config.pool, { schema: identitySchema });
    this.rawAuth = betterAuth({
      appName: "Rootset",
      baseURL: config.baseURL,
      basePath: "/v1/auth",
      secret: config.secret,
      trustedOrigins: [
        new URL(config.baseURL).origin,
        new URL(config.webURL ?? config.baseURL).origin,
      ],
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
        password: { hash: this.passwords.hash, verify: this.passwords.verify },
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
        sendOnSignIn: false,
        autoSignInAfterVerification: false,
        expiresIn: 3600,
        sendVerificationEmail: async ({ user, url }) =>
          enqueueVerificationEmail(config.pool, this.emailOutbox, {
            userId: user.id,
            email: user.email,
            name: user.name,
            actionUrl: url,
          }),
      },
      databaseHooks: {
        user: {
          create: {
            before: async () => {
              throw new APIError("FORBIDDEN", {
                message: "Use an invitation to create an account",
              });
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
              const verified = await config.pool.query(
                `SELECT 1 FROM rootset_control.users WHERE id=$1 AND email_verified`,
                [session.userId],
              );
              if (!verified.rowCount)
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
          if (ctx.path === "/sign-up/email")
            throw new APIError("FORBIDDEN", {
              message: "Use an invitation to create an account",
            });
        }),
      },
      plugins: [
        passwordSecondFactor(database, config.pool),
        passkey({
          rpID: new URL(config.webURL ?? config.baseURL).hostname,
          rpName: "Rootset",
          origin: new URL(config.webURL ?? config.baseURL).origin,
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
              await completePasskeySecondFactor(
                ctx,
                database,
                config.pool,
                clientData,
              );
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
  private async passwordOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof APIError)
        throw new RootsetError(
          String(error.body?.code ?? error.status),
          error.message,
          error.statusCode,
        );
      throw error;
    }
  }
  private hashPassword(password: string): Promise<string> {
    return this.passwordOperation(() => this.passwords.hash(password));
  }
  private verifyPassword(input: {
    password: string;
    hash: string;
  }): Promise<boolean> {
    return this.passwordOperation(() => this.passwords.verify(input));
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
    const password = await this.hashPassword(input.password),
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
        `INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)`,
        [userId, input.name, input.email],
      );
      const preferences = parse(PreferencesSchema, {
        ...defaultPreferences,
        ...input.preferences,
      });
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
        `UPDATE rootset_control.bootstrap SET org_id=$1,user_id=$2,claimed_at=now(),verified_at=now(),claim_digest=$3 WHERE singleton`,
        [orgId, userId, claimDigest],
      );
      return { orgId, userId };
    });
    return { state: "ready", ...result };
  }
  async refreshActor(actor: Actor, client?: PoolClient): Promise<Actor> {
    return this.hydrateActor(actor, true, client);
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
      if (actor.kind === "team_key") {
        const key = (
          await client.query(
            `SELECT k.access,k.include_admin FROM rootset_control.api_keys k JOIN rootset_control.organisations o ON o.id=k.org_id AND o.singleton WHERE k.id=$1 AND k.org_id=$2 AND k.scope='team' AND k.user_id IS NULL AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())`,
            [actor.credentialId ?? actor.id, actor.orgId],
          )
        ).rows[0];
        if (!key)
          throw new RootsetError(
            "UNAUTHENTICATED",
            "Credential is unavailable",
            401,
          );
        return {
          kind: "team_key",
          id: actor.id,
          credentialId: actor.credentialId ?? actor.id,
          orgId: actor.orgId,
          role: keyRole("admin", key.access, key.include_admin),
          scopes: teamKeyScopes(key.access, key.include_admin),
        };
      }
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
      let grantedScopes: string[] = [...ALL_SCOPES];
      let effectiveRole: Role = membership.role;
      if (actor.kind === "personal_key") {
        const key = (
          await client.query(
            `SELECT access,include_admin FROM rootset_control.api_keys WHERE id=$1 AND org_id=$2 AND user_id=$3 AND scope='personal' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,
            [actor.credentialId ?? actor.id, actor.orgId, actor.userId],
          )
        ).rows[0];
        if (!key)
          throw new RootsetError(
            "UNAUTHENTICATED",
            "Credential is unavailable",
            401,
          );
        effectiveRole = keyRole(membership.role, key.access, key.include_admin);
        grantedScopes = keyScopes(key.access, key.include_admin);
      }
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
        role: effectiveRole,
        scopes: grantedScopes.filter((scope) =>
          roleAllows(effectiveRole, scope),
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
          `SELECT org_id FROM rootset_control.memberships WHERE user_id=$1`,
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
          `SELECT org_id FROM rootset_control.api_keys WHERE id=$1`,
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
        kind: candidate.scope === "team" ? "team_key" : "personal_key",
        id: candidate.id,
        credentialId: candidate.id,
        orgId: candidate.org_id,
        ...(candidate.user_id ? { userId: candidate.user_id } : {}),
        role: "viewer",
        scopes: [],
      });
      await withOrg(this.config.pool, actor.orgId, (client) =>
        client.query(
          `UPDATE rootset_control.api_keys SET last_used_at=now() WHERE id=$1 AND org_id=$2`,
          [candidate.id, actor.orgId],
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
    try {
      if (
        !identityRoutes.has(`${request.method} ${path}`) &&
        !(
          request.method === "GET" &&
          /^\/reset-password\/[A-Za-z0-9_-]+$/.test(path)
        ) &&
        !(
          (request.method === "GET" &&
            /^\/invitations\/[A-Za-z0-9]{26}$/.test(path)) ||
          (request.method === "POST" &&
            (path === "/invitations/accept" ||
              /^\/invitations\/[A-Za-z0-9]{26}\/(?:verify|code|signup|accept)$/.test(
                path,
              )))
        )
      )
        notFound();
      if (
        request.headers.has("authorization") ||
        request.headers.has("x-api-key")
      )
        throw new RootsetError(
          "ACCESS_DENIED",
          "Use a browser session for account settings",
          403,
        );
      if (request.method !== "GET" && path !== "/request-verification-email")
        await this.limitRequest(request, path);
      if (
        !["GET", "HEAD"].includes(request.method) &&
        (request.headers.has("cookie") || request.headers.has("origin")) &&
        request.headers.get("origin") !==
          new URL(this.config.webURL ?? this.config.baseURL).origin
      )
        throw new RootsetError(
          "ACCESS_DENIED",
          "The request origin is invalid",
          403,
        );
      if (path === "/request-verification-email" && request.method === "POST") {
        const { email } = parse(
          z.strictObject({ email: emailSchema }),
          await request.json(),
        );
        return await requestPublicVerificationEmail({
          pool: this.config.pool,
          hash: (value) => this.hashSecret(value),
          email,
          address: request.headers.get("x-rootset-client-address") ?? "unknown",
          send: (address) =>
            this.rawAuth.api.sendVerificationEmail({
              body: {
                email: address,
                callbackURL: `${new URL(this.config.webURL ?? this.config.baseURL).origin}/login`,
              },
            }),
        });
      }
      if (path === "/send-verification-email" && request.method === "POST") {
        const session = await this.rawAuth.api.getSession({
          headers: request.headers,
        });
        if (!session)
          throw new RootsetError("UNAUTHENTICATED", "Sign in to continue", 401);
        const { email } = parse(
          z.strictObject({
            email: emailSchema,
            callbackURL: z.string().optional(),
          }),
          await request.json(),
        );
        if (session.user.email !== email)
          throw new RootsetError(
            "ACCESS_DENIED",
            "Use your signed-in email address",
            403,
          );
        return Response.json(
          await this.rawAuth.api.sendVerificationEmail({
            headers: request.headers,
            body: {
              email,
              callbackURL: `${new URL(this.config.webURL ?? this.config.baseURL).origin}/settings/email-password`,
            },
          }),
        );
      }
      if (
        path.startsWith("/two-factor/") ||
        ["/organisations", "/organisation", "/delete-user"].includes(path)
      )
        notFound();
      if (path.startsWith("/invitations/"))
        return await this.handleInvitation(request, path);
      if (path === "/reauthenticate") return await this.reauthenticate(request);
      if (path === "/email-change")
        return await this.pendingEmailChange(request);
      if (path === "/email-change/inspect")
        return await this.inspectEmailChange(request);
      if (path === "/email-change/confirm")
        return await this.confirmEmailChange(request);
      const actionOperation = factorRoutes[path];
      if (
        ["/passkey/verify-registration", "/passkey/update-passkey"].includes(
          path,
        )
      ) {
        const body = parse(
          z.strictObject({
            response: z.record(z.string(), z.unknown()).optional(),
            id: z.string().optional(),
            name: z.string().trim().min(1).max(120).optional(),
            createSession: z.literal(false).optional(),
          }),
          await request.clone().json(),
        );
        if (path.endsWith("update-passkey") && (!body.id || !body.name))
          throw new RootsetError(
            "VALIDATION_FAILED",
            "Passkey ID and name are required",
          );
      }
      if (
        ["/change-password", "/change-email", "/sign-out-everywhere"].includes(
          path,
        )
      ) {
        const actor = await this.resolveActor(request, "browser");
        if (!actor)
          throw new RootsetError("UNAUTHENTICATED", "Sign in to continue", 401);
        const operation = {
          "/change-password": "changePassword",
          "/change-email": "changeEmail",
          "/sign-out-everywhere": "signOutEverywhere",
        }[path]!;
        return Response.json(
          await this.execute(operation, actor, await request.json(), {
            idempotencyKey: request.headers.get("idempotency-key") ?? newId(),
          }),
        );
      }
      if (actionOperation) {
        const actor = await this.resolveActor(request, "browser");
        if (!actor)
          throw new RootsetError("UNAUTHENTICATED", "Sign in to continue", 401);
        this.requireRecentAuthentication(actor);
      }
      const passkeySession =
        path === "/passkey/verify-authentication"
          ? await this.rawAuth.api.getSession({ headers: request.headers })
          : null;
      let response: Response;
      if (path === "/passkey/replace-recovery-codes") {
        const actor = await this.resolveActor(request, "browser");
        if (!actor?.userId)
          throw new RootsetError("UNAUTHENTICATED", "Sign in to continue", 401);
        const recoveryCodes = await transaction(
          this.config.pool,
          async (client) => {
            await client.query(
              `SELECT id FROM rootset_control.users WHERE id=$1 FOR UPDATE`,
              [actor.userId],
            );
            if (
              !(
                await client.query(
                  `SELECT id FROM rootset_control.auth_passkeys WHERE user_id=$1 FOR UPDATE`,
                  [actor.userId],
                )
              ).rowCount
            )
              throw new RootsetError(
                "ACCESS_DENIED",
                "Add a passkey before generating recovery codes",
                403,
              );
            return replaceRecoveryCodes(client, actor.userId!);
          },
        );
        response = Response.json({ recoveryCodes });
      } else response = await this.rawAuth.handler(request);
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
        [
          "/passkey/verify-registration",
          "/passkey/delete-passkey",
          "/passkey/replace-recovery-codes",
        ].includes(path)
      ) {
        const session = await this.rawAuth.api.getSession({
          headers: request.headers,
        });
        if (session) {
          if (path === "/passkey/verify-registration") {
            const recoveryCodes = await transaction(
              this.config.pool,
              async (client) => {
                await client.query(
                  `SELECT id FROM rootset_control.users WHERE id=$1 FOR UPDATE`,
                  [session.user.id],
                );
                const keys = await client.query(
                  `SELECT id FROM rootset_control.auth_passkeys WHERE user_id=$1 FOR UPDATE`,
                  [session.user.id],
                );
                return keys.rowCount
                  ? ensureRecoveryCodes(client, session.user.id)
                  : [];
              },
            );
            if (recoveryCodes.length)
              response = Response.json(
                {
                  ...((await response.clone().json()) as object),
                  recoveryCodes,
                },
                { status: response.status, headers: response.headers },
              );
          }
          if (path === "/passkey/delete-passkey")
            await this.config.pool.query(
              `DELETE FROM rootset_control.auth_recovery_codes WHERE user_id=$1 AND NOT EXISTS(SELECT 1 FROM rootset_control.auth_passkeys WHERE user_id=$1)`,
              [session.user.id],
            );
          await this.revokeAllUserAccess(session.user.id, session.session.id);
          await this.sendEmail({
            template: "factor-changed",
            to: session.user.email,
            payload: { name: session.user.name },
            dedupeKey: `factor:${session.user.id}:${newId()}`,
          });
        }
      }
      return response;
    } catch (error) {
      const status =
        error instanceof RootsetError
          ? error.status
          : error instanceof APIError
            ? error.statusCode
            : 500;
      return Response.json(
        {
          error: {
            code:
              error instanceof RootsetError
                ? error.code
                : error instanceof APIError
                  ? (error.body?.code ?? error.status)
                  : "INTERNAL_ERROR",
            message:
              error instanceof RootsetError || error instanceof APIError
                ? error.message
                : "Authentication could not be completed",
          },
        },
        { status },
      );
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
  assertDatabaseDeletion(actor: Actor): void {
    if (actor.kind === "session") this.requireRecentAuthentication(actor);
  }
  private assertSensitive(actor: Actor, operation: string): void {
    if (
      ["changePassword", "changeEmail", "signOutEverywhere"].includes(
        operation,
      ) ||
      (actor.kind === "session" &&
        [
          "createPersonalKey",
          "rotatePersonalKey",
          "createTeamKey",
          "rotateTeamKey",
        ].includes(operation))
    )
      this.requireRecentAuthentication(actor);
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
      `DELETE FROM rootset_control.auth_verifications WHERE value=$1 OR CASE WHEN identifier LIKE 'rootset-passkey-factor:%' THEN value::jsonb->>'userId'=$1 ELSE false END`,
      [userId],
    );
    await client.query(
      `UPDATE rootset_control.users SET authentication_version=authentication_version+1 WHERE id=$1`,
      [userId],
    );
    await client.query(
      `SELECT set_config('rootset.org_id',coalesce((SELECT id FROM rootset_control.organisations),''),true)`,
    );
    await client.query(
      `UPDATE rootset_control.api_keys SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query(
      `UPDATE rootset_control.oauth_grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
    await client.query(`SELECT set_config('rootset.org_id',$1,true)`, [
      originalContext,
    ]);
  }
  async execute(
    operationId: string,
    incomingActor: Actor,
    value: unknown,
    context: ExecutionContext = {},
  ): Promise<unknown> {
    const operation = normaliseOperation(operationId),
      actor = await this.hydrateActor(incomingActor, true, context.client),
      input = (value ?? {}) as Record<string, unknown>;
    const normalizedInput = input;
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
        const ranks = { viewer: 1, member: 2, admin: 3 };
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
          });
      }
      if (
        ["updateViewPreferences", "updateForeignKeyDisplayField"].includes(
          operation,
        )
      ) {
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
            { ...context, client },
          );
          const json = JSON.parse(JSON.stringify(output)) as unknown;
          return definition ? definition.outputSchema.parse(json) : json;
        },
      );
      return definition ? definition.outputSchema.parse(result) : result;
    };
    const result = await (context.client
      ? run(context.client)
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
              ...availableTimeZones(),
              ...(selected ? [selected] : []),
            ]),
          ],
          locales: ["en", "en-GB", "en-IN"],
          dateFormats: dateFormatOptions.map((option) => option.id),
          timeFormats: timeFormatOptions.map((option) => option.id),
          themes: ["system", "light", "dark"],
        };
      }
      case "previewPreferences": {
        const data = parse(
            z.strictObject({
              preferences: PreferencesSchema,
              value: DateTimeSchema,
            }),
            input,
          ),
          p = data.preferences;
        return {
          utc: new Date(data.value).toISOString(),
          displayed: createDateTimeFormatter({ ...p, timeZone: p.timezone })(
            data.value,
          ).dateTime!,
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
          `SELECT m.id,m.org_id "orgId",m.user_id "userId",u.name,u.email,u.email_verified verified,EXISTS(SELECT 1 FROM rootset_control.auth_passkeys p WHERE p.user_id=u.id) "twoFactorEnabled",m.role,m.version::text FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE m.org_id=$1`,
          [actor.orgId],
        );
      case "updateMember":
      case "removeMember":
        return this.mutateMember(client, operation, actor, input);
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
          `SELECT ${keyFields} FROM rootset_control.api_keys WHERE org_id=$1 AND user_id=$2 AND scope='personal'`,
          [actor.orgId, actor.userId],
          (row) => mapKey(row, actor.orgId),
        );
      }
      case "listTeamKeys": {
        assertAccess(actor, {
          scope: "team-keys:manage",
          roles: ["admin"],
          personal: true,
        });
        return this.page(
          client,
          actor,
          operation,
          input,
          `SELECT ${keyFields} FROM rootset_control.api_keys WHERE org_id=$1 AND scope='team'`,
          [actor.orgId],
          (row) => mapKey(row, actor.orgId),
        );
      }
      case "createPersonalKey":
      case "rotatePersonalKey":
      case "createTeamKey":
      case "rotateTeamKey":
        return this.createOrRotateKey(client, operation, actor, input, context);
      case "revokePersonalKey":
        return this.revokeKey(client, actor, input);
      case "revokeTeamKey":
        return this.revokeKey(client, actor, input, "team");
      case "getSecurityStatus": {
        security();
        const factor = (
          await client.query(
            `SELECT cardinality(code_hashes) remaining FROM rootset_control.auth_recovery_codes WHERE user_id=$1`,
            [actor.userId],
          )
        ).rows[0];
        return {
          twoFactorEnabled: Boolean(
            (
              await client.query(
                `SELECT 1 FROM rootset_control.auth_passkeys WHERE user_id=$1 LIMIT 1`,
                [actor.userId],
              )
            ).rowCount,
          ),
          recoveryCodesRemaining: factor?.remaining ?? 0,
          passkeys: (
            await client.query(
              `SELECT id,COALESCE(name,'Passkey') name,created_at "createdAt",NULL::timestamptz "lastUsedAt" FROM rootset_control.auth_passkeys WHERE user_id=$1 ORDER BY created_at`,
              [actor.userId],
            )
          ).rows,
        };
      }
      case "listSavedViews":
      case "getSavedView":
      case "createSavedView":
      case "updateSavedView":
      case "deleteSavedView":
        return executeSavedViews(client, operation, actor, input);
      case "getViewPreferences":
      case "updateViewPreferences":
      case "updateForeignKeyDisplayField": {
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
        if (operation === "updateForeignKeyDisplayField") {
          const foreignKeyId = parse(IdSchema, input.foreignKeyId);
          const displayFieldId =
            input.displayFieldId === null
              ? null
              : parse(IdSchema, input.displayFieldId);
          const rule = (
            await client.query(
              "SELECT referenced_table_id FROM rootset_control.foreign_keys WHERE id=$1 AND table_id=$2 AND org_id=$3 AND state='active'",
              [foreignKeyId, tableId, actor.orgId],
            )
          ).rows[0];
          if (!rule) notFound();
          if (
            displayFieldId &&
            !(
              await client.query(
                "SELECT id FROM rootset_control.fields WHERE id=$1 AND table_id=$2 AND org_id=$3 AND state='active' AND definition->>'type'<>'json'",
                [displayFieldId, rule.referenced_table_id, actor.orgId],
              )
            ).rowCount
          )
            throw new RootsetError(
              "VALIDATION_FAILED",
              "Choose a current scalar field from the referenced table",
            );
          const patch = displayFieldId
            ? { [foreignKeyId]: displayFieldId }
            : {};
          const defaults = {
            columnOrder: [],
            columnWidths: {},
            frozenColumns: 0,
            hiddenColumns: [],
            foreignKeyDisplayFields: patch,
          };
          const result = await client.query(
            `INSERT INTO rootset_control.view_preferences(user_id,org_id,table_id,preferences) VALUES($1,$2,$3,$4)
             ON CONFLICT(user_id,table_id) DO UPDATE SET preferences=jsonb_set(view_preferences.preferences,'{foreignKeyDisplayFields}',
               coalesce((SELECT jsonb_object_agg(p.key,p.value) FROM jsonb_each(coalesce(view_preferences.preferences->'foreignKeyDisplayFields','{}'::jsonb)) p
                 JOIN rootset_control.foreign_keys k ON k.id=p.key AND k.table_id=$3 AND k.state='active'
                 WHERE p.key<>$5),'{}'::jsonb)||$6::jsonb),updated_at=now() RETURNING preferences`,
            [
              actor.userId,
              actor.orgId,
              tableId,
              JSON.stringify(defaults),
              foreignKeyId,
              JSON.stringify(patch),
            ],
          );
          return { tableId, preferences: result.rows[0]!.preferences };
        }
        const preferences = parse(ViewPreferencesSchema, input.preferences);
        delete preferences.foreignKeyDisplayFields;
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
        const saved = await client.query(
          `INSERT INTO rootset_control.view_preferences(user_id,org_id,table_id,preferences) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,table_id) DO UPDATE SET preferences=jsonb_set($4::jsonb,'{foreignKeyDisplayFields}',coalesce(view_preferences.preferences->'foreignKeyDisplayFields','{}'::jsonb)),updated_at=now() RETURNING preferences`,
          [actor.userId, actor.orgId, tableId, JSON.stringify(preferences)],
        );
        return { tableId, preferences: saved.rows[0]!.preferences };
      }
      case "changePassword":
        return this.changePassword(client, actor, input);
      case "changeEmail":
        return this.beginEmailChange(client, actor, input);
      case "signOutEverywhere": {
        security();
        const data = parse(signOutEverywhereInputSchema, input);
        this.assertSensitive(actor, operation);
        const delegated = data.revokeDelegated !== false;
        await client.query(
          `DELETE FROM rootset_control.sessions WHERE user_id=$1`,
          [actor.userId],
        );
        if (delegated)
          await this.revokeAllUserAccess(actor.userId!, undefined, client);
        return { revoked: true };
      }
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
    return parse(PreferencesSchema, r.rows[0] ?? defaultPreferences);
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
  ): Promise<unknown> {
    assertAccess(actor, {
      scope: "members:manage",
      orgId: input.orgId as string | undefined,
      roles: ["admin"],
    });
    this.assertSensitive(actor, operation);
    const update = parse(
      z.strictObject({
        id: IdSchema,
        orgId: IdSchema.optional(),
        role: z.enum(["admin", "member", "viewer"]).optional(),
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
            `SELECT m.id,m.org_id "orgId",m.user_id "userId",u.name,u.email,u.email_verified verified,EXISTS(SELECT 1 FROM rootset_control.auth_passkeys p WHERE p.user_id=u.id) "twoFactorEnabled",m.role,m.version::text FROM rootset_control.memberships m JOIN rootset_control.users u ON u.id=m.user_id WHERE m.id=$1 AND m.org_id=$2`,
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
        role: z.enum(["admin", "member", "viewer"]),
      }),
      input,
    );
    const id = newId(),
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
      `INSERT INTO rootset_control.invitations(id,org_id,email,role,inviter_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [id, actor.orgId, data.email, data.role, actor.userId, expiresAt],
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
        actionUrl: `${this.config.webURL ?? this.config.baseURL}/invite/${id}`,
        expiresAt: expiresAt.toISOString(),
      },
      dedupeKey: `invitation:${id}`,
      expiresAt,
    });
    return {
      id,
      inviteUrl: `${this.config.webURL ?? this.config.baseURL}/invite/${id}`,
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
    const id =
      path === "/invitations/accept"
        ? ((await request.clone().json()) as { token?: string }).token
        : path.slice("/invitations/".length).split("/")[0];
    const parsedId = IdSchema.safeParse(id);
    if (!parsedId.success) notFound();
    const locator = await this.config.pool.query(
      `SELECT org_id FROM rootset_control.invitations WHERE id=$1`,
      [id],
    );
    if (!locator.rows[0]) notFound();
    const orgId = locator.rows[0].org_id as string;
    const invitation = await withOrg(
      this.config.pool,
      orgId,
      async (client) => {
        const r = await client.query(
          `SELECT i.*,o.name organisation_name,m.role inviter_role,u.email_verified inviter_verified FROM rootset_control.invitations i JOIN rootset_control.organisations o ON o.id=i.org_id AND o.singleton LEFT JOIN rootset_control.memberships m ON m.org_id=i.org_id AND m.user_id=i.inviter_id LEFT JOIN rootset_control.users u ON u.id=m.user_id WHERE i.id=$1`,
          [id],
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
    if (request.method !== "POST") notFound();
    if (path === `/invitations/${id}/verify`) {
      parse(z.strictObject({}), await request.json());
      return this.beginInvitationVerification(orgId, invitation);
    }
    if (path === `/invitations/${id}/code`)
      return this.verifyInvitationCode(request, orgId, invitation);
    if (path === `/invitations/${id}/signup`)
      return this.completeInvitationSignup(request, orgId, invitation);
    if (!["/invitations/accept", `/invitations/${id}/accept`].includes(path))
      notFound();
    const session = await this.rawAuth.api.getSession({
      headers: request.headers,
    });
    if (!session)
      throw new RootsetError(
        "UNAUTHENTICATED",
        "Sign in with the email address on the invitation",
        401,
      );
    parse(
      path === "/invitations/accept"
        ? z.strictObject({ token: IdSchema })
        : z.strictObject({}),
      await request.json(),
    );
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
  private async lockPendingInvitation(
    client: PoolClient,
    orgId: string,
    id: string,
  ) {
    await client.query(
      "SELECT id FROM rootset_control.organisations WHERE id=$1 FOR UPDATE",
      [orgId],
    );
    const invitation = (
      await client.query<{
        id: string;
        email: string;
        role: Role;
        inviter_id: string;
      }>(
        "SELECT i.id,i.email,i.role,i.inviter_id FROM rootset_control.invitations i JOIN rootset_control.memberships m ON m.org_id=i.org_id AND m.user_id=i.inviter_id AND m.role='admin' JOIN rootset_control.users u ON u.id=m.user_id AND u.email_verified WHERE i.id=$1 AND i.org_id=$2 AND i.state='pending' AND i.expires_at>now() FOR UPDATE OF i",
        [id, orgId],
      )
    ).rows[0];
    if (!invitation)
      throw new RootsetError(
        "INVITATION_UNAVAILABLE",
        "Invitation is unavailable",
        410,
      );
    return invitation;
  }
  private async beginInvitationVerification(
    orgId: string,
    invitation: { id: string; email: string },
  ): Promise<Response> {
    const result = await withOrg(this.config.pool, orgId, async (client) => {
      const current = await this.lockPendingInvitation(
        client,
        orgId,
        invitation.id,
      );
      if (
        (
          await client.query(
            "SELECT id FROM rootset_control.users WHERE email=$1",
            [current.email],
          )
        ).rowCount
      )
        return { existingAccount: true };
      const recent = await client.query<{ created_at: Date }>(
        "SELECT created_at FROM rootset_control.email_outbox WHERE to_address=$1 AND template='invitation-verification' AND created_at>now()-interval '24 hours' ORDER BY created_at DESC LIMIT 5",
        [current.email],
      );
      if (
        recent.rowCount === 5 ||
        (recent.rows[0] &&
          recent.rows[0].created_at.getTime() > Date.now() - 60_000)
      )
        throw new RootsetError(
          "EMAIL_VERIFICATION_RATE_LIMITED",
          "Too many verification requests. Try again later.",
          429,
        );
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const identifier = `rootset-invitation-code:${invitation.id}`;
      await client.query(
        "DELETE FROM rootset_control.auth_verifications WHERE identifier=$1",
        [identifier],
      );
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      await client.query(
        "INSERT INTO rootset_control.auth_verifications(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)",
        [
          newId(),
          identifier,
          JSON.stringify({
            email: current.email,
            codeHash: this.hashSecret(`${invitation.id}:${code}`),
            attempts: 0,
          }),
          expiresAt,
        ],
      );
      await this.emailOutbox.enqueue(client, {
        template: "invitation-verification",
        to: current.email,
        payload: {
          details: `Your verification code is ${code}.`,
          expiresAt: expiresAt.toISOString(),
        },
        dedupeKey: `invitation-verification:${invitation.id}:${newId()}`,
        expiresAt,
      });
      return { existingAccount: false };
    });
    return Response.json(result);
  }
  private async verifyInvitationCode(
    request: Request,
    orgId: string,
    invitation: { id: string; email: string },
  ): Promise<Response> {
    const input = parse(
      z.strictObject({
        name: z.string().trim().min(1).max(120),
        code: z.string().regex(/^\d{6}$/),
      }),
      await request.json(),
    );
    const setupToken = randomBytes(32).toString("base64url");
    const verified = await withOrg(this.config.pool, orgId, async (client) => {
      const current = await this.lockPendingInvitation(
        client,
        orgId,
        invitation.id,
      );
      const row = (
        await client.query<{ id: string; value: string }>(
          "SELECT id,value FROM rootset_control.auth_verifications WHERE identifier=$1 AND expires_at>now() FOR UPDATE",
          [`rootset-invitation-code:${invitation.id}`],
        )
      ).rows[0];
      if (!row) return false;
      const code = JSON.parse(row.value) as {
        email: string;
        codeHash: string;
        attempts: number;
      };
      if (code.email !== current.email || code.attempts >= 5) return false;
      if (
        !safeEqual(
          code.codeHash,
          this.hashSecret(`${invitation.id}:${input.code}`),
        )
      ) {
        await client.query(
          "UPDATE rootset_control.auth_verifications SET value=$2 WHERE id=$1",
          [row.id, JSON.stringify({ ...code, attempts: code.attempts + 1 })],
        );
        return false;
      }
      await client.query(
        "DELETE FROM rootset_control.auth_verifications WHERE id=$1",
        [row.id],
      );
      await client.query(
        "INSERT INTO rootset_control.auth_verifications(id,identifier,value,expires_at) VALUES($1,$2,$3,$4)",
        [
          newId(),
          `rootset-invitation-password:${this.hashSecret(setupToken)}`,
          JSON.stringify({
            invitationId: invitation.id,
            email: current.email,
            name: input.name,
          }),
          new Date(Date.now() + 10 * 60_000),
        ],
      );
      return true;
    });
    if (!verified)
      throw new RootsetError(
        "VERIFICATION_CODE_INVALID",
        "Verification code is invalid or expired",
        400,
      );
    return Response.json({ setupToken });
  }
  private async completeInvitationSignup(
    request: Request,
    orgId: string,
    invitation: { id: string; email: string },
  ): Promise<Response> {
    const input = parse(
      z.strictObject({
        setupToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        password: passwordSchema,
      }),
      await request.json(),
    );
    const identifier = `rootset-invitation-password:${this.hashSecret(input.setupToken)}`;
    if (
      !(
        await this.config.pool.query(
          "SELECT 1 FROM rootset_control.auth_verifications WHERE identifier=$1 AND expires_at>now()",
          [identifier],
        )
      ).rowCount
    )
      throw new RootsetError(
        "VERIFICATION_CODE_INVALID",
        "Verification code is invalid or expired",
        400,
      );
    const password = await this.hashPassword(input.password);
    await withOrg(this.config.pool, orgId, async (client) => {
      const current = await this.lockPendingInvitation(
        client,
        orgId,
        invitation.id,
      );
      const row = (
        await client.query<{ value: string }>(
          "DELETE FROM rootset_control.auth_verifications WHERE identifier=$1 AND expires_at>now() RETURNING value",
          [identifier],
        )
      ).rows[0];
      if (!row)
        throw new RootsetError(
          "VERIFICATION_CODE_INVALID",
          "Verification code is invalid or expired",
          400,
        );
      const proof = JSON.parse(row.value) as {
        invitationId: string;
        email: string;
        name: string;
      };
      if (proof.invitationId !== invitation.id || proof.email !== current.email)
        throw new RootsetError(
          "VERIFICATION_CODE_INVALID",
          "Verification code is invalid or expired",
          400,
        );
      if (
        (
          await client.query(
            "SELECT 1 FROM rootset_control.users WHERE email=$1",
            [current.email],
          )
        ).rowCount
      )
        throw new RootsetError(
          "ACCOUNT_EXISTS",
          "This email already has an account. Sign in to accept the invitation",
          409,
        );
      const userId = newId();
      await client.query(
        "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
        [userId, proof.name, current.email],
      );
      await client.query(
        "INSERT INTO rootset_control.auth_accounts(id,user_id,account_id,provider_id,password) VALUES($1,$2,$4,'credential',$3)",
        [newId(), userId, password, userId],
      );
      await client.query(
        "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,$4)",
        [newId(), orgId, userId, current.role],
      );
      await client.query(
        "UPDATE rootset_control.invitations SET state='accepted',accepted_by=$2 WHERE id=$1",
        [invitation.id, userId],
      );
      await client.query(
        "UPDATE rootset_control.email_outbox SET state='failed',last_error='INVITATION_COMPLETED' WHERE dedupe_key=$1 AND state='pending'",
        [`invitation:${invitation.id}`],
      );
    });
    return this.rawAuth.api.signInEmail({
      body: { email: invitation.email, password: input.password },
      headers: request.headers,
      asResponse: true,
    });
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
    assertAccess(actor, {
      scope: operation.endsWith("TeamKey") ? "team-keys:manage" : "keys:manage",
      personal: true,
      ...(operation.endsWith("TeamKey") ? { roles: ["admin" as const] } : {}),
    });
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
            `SELECT 1 FROM rootset_control.api_keys WHERE id=$1 AND org_id=$2 AND scope=$4 AND ($4='team' OR user_id=$3)`,
            [
              id,
              actor.orgId,
              actor.userId,
              operation.endsWith("TeamKey") ? "team" : "personal",
            ],
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
    await this.lockUserAuthorities(client, [actor.userId!]);
    actor = await this.hydrateActor(actor, true, client);
    const scope = operation.endsWith("TeamKey") ? "team" : "personal";
    assertAccess(actor, {
      scope: scope === "team" ? "team-keys:manage" : "keys:manage",
      ...(scope === "team" ? { roles: ["admin" as const] } : {}),
      personal: true,
    });
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
        access: z.enum(["read", "edit"]).optional(),
        includeAdmin: z.boolean().optional(),
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
          `SELECT * FROM rootset_control.api_keys WHERE id=$1 AND org_id=$2 AND scope=$4 AND ($4='team' OR user_id=$3) AND revoked_at IS NULL FOR UPDATE`,
          [data.id, actor.orgId, actor.userId, scope],
        )
      ).rows[0];
      if (!old) notFound();
    }
    const name = data.name ?? old?.name;
    if (!name) throw new RootsetError("VALIDATION_FAILED", "Name is required");
    if (
      !old &&
      (data.access === undefined ||
        data.includeAdmin === undefined ||
        data.expiresAt === undefined)
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Permissions and expiry are required",
      );
    const access = data.access ?? (old?.access as "read" | "edit");
    const includeAdmin = data.includeAdmin ?? (old?.include_admin as boolean);
    if (includeAdmin && access !== "edit")
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Administrative keys require edit access",
      );
    const requestedRole = includeAdmin
      ? "admin"
      : access === "edit"
        ? "member"
        : "viewer";
    if (
      keyRole(actor.role, access, includeAdmin) !== requestedRole ||
      (actor.kind === "personal_key" &&
        keyScopes(access, includeAdmin).some(
          (scope) =>
            roleAllows(requestedRole, scope) && !actor.scopes.includes(scope),
        ))
    )
      throw new RootsetError(
        "FORBIDDEN",
        "These API key permissions exceed your role",
        403,
      );
    const expiry =
      data.expiresAt !== undefined ? data.expiresAt : old?.expires_at;
    if (expiry === null && actor.role !== "admin")
      throw new RootsetError(
        "FORBIDDEN",
        "Only administrators can create keys that never expire",
        403,
      );
    const expiresAt =
      expiry === null ? null : new Date(expiry as string | Date);
    if (expiresAt && expiresAt <= new Date())
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Expiry must be in the future",
      );
    this.assertSensitive(actor, operation);
    const id = newId(),
      secret = `rst_${id}_${randomBytes(32).toString("base64url")}`;
    const result = await client.query(
      `INSERT INTO rootset_control.api_keys(id,org_id,user_id,creator_user_id,name,secret_hash,prefix,expires_at,rotated_from,access,include_admin,scope) VALUES($1,$2,$3,$11,$4,$5,$6,$7,$8,$9,$10,$12) RETURNING ${keyFields}`,
      [
        id,
        actor.orgId,
        scope === "team" ? null : actor.userId,
        name,
        this.hashSecret(secret),
        `rst_${id}`,
        expiresAt,
        old?.id ?? null,
        access,
        includeAdmin,
        actor.userId,
        scope,
      ],
    );
    const metadata = mapKey(result.rows[0]!, actor.orgId);
    if (old)
      await client.query(
        `UPDATE rootset_control.api_keys SET revoked_at=CASE WHEN $2=0 THEN now() ELSE NULL END,expires_at=CASE WHEN $2>0 THEN LEAST(COALESCE(expires_at,'infinity'::timestamptz),now()+($2 * interval '1 second')) ELSE expires_at END WHERE id=$1 AND org_id=$3`,
        [old.id, data.overlapSeconds, actor.orgId],
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
    scope: "personal" | "team" = "personal",
  ): Promise<unknown> {
    assertAccess(actor, {
      scope: scope === "team" ? "team-keys:manage" : "keys:manage",
      ...(scope === "team" ? { roles: ["admin" as const] } : {}),
      personal: true,
    });
    const id = parse(IdSchema, input.id);
    if (
      !(
        await client.query(
          `UPDATE rootset_control.api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND org_id=$2 AND scope=$4 AND ($4='team' OR user_id=$3) RETURNING id`,
          [id, actor.orgId, actor.userId, scope],
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
  ): Promise<unknown> {
    assertAccess(actor, { scope: "account:security", personal: true });
    const data = parse(
      z.strictObject({
        currentPassword: z.string().max(1024).optional(),
        newPassword: passwordSchema,
      }),
      input,
    );
    this.assertSensitive(actor, "changePassword");
    const account = (
      await client.query(
        `SELECT id,password,EXISTS(SELECT 1 FROM rootset_control.auth_passkeys WHERE user_id=$1) has_passkey FROM rootset_control.auth_accounts WHERE user_id=$1 AND provider_id='credential' FOR UPDATE`,
        [actor.userId],
      )
    ).rows[0];
    if (
      !account?.password ||
      (!account.has_passkey &&
        (!data.currentPassword ||
          !(await this.verifyPassword({
            password: data.currentPassword,
            hash: account.password,
          }))))
    )
      throw new RootsetError(
        "ACCESS_DENIED",
        "Password verification failed",
        403,
      );
    await client.query(
      `UPDATE rootset_control.auth_accounts SET password=$2,updated_at=now() WHERE id=$1`,
      [account.id, await this.hashPassword(data.newPassword)],
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
  ): Promise<unknown> {
    assertAccess(actor, { scope: "account:security", personal: true });
    const data = parse(z.strictObject({ newEmail: emailSchema }), input);
    this.assertSensitive(actor, "changeEmail");
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
        actionUrl: `${this.config.webURL ?? this.config.baseURL}/email-change#${token}`,
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
  private emailChangeToken(value: unknown): string {
    return parse(
      z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
      value,
    ).token;
  }
  private async inspectEmailChange(request: Request): Promise<Response> {
    const token = this.emailChangeToken(await request.json());
    const result = await this.config.pool.query(
      "SELECT 1 FROM rootset_control.email_changes e JOIN rootset_control.users u ON u.id=e.user_id AND u.email=e.previous_email WHERE e.token_hash=$1 AND e.expires_at>now()",
      [this.hashSecret(token)],
    );
    if (!result.rowCount)
      throw new RootsetError(
        "TOKEN_UNAVAILABLE",
        "Email verification has expired or was already used",
        410,
      );
    return Response.json(
      { status: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  private async confirmEmailChange(request: Request): Promise<Response> {
    const token = this.emailChangeToken(await request.json());
    await transaction(this.config.pool, async (client) => {
      const locator = (
        await client.query(
          "SELECT user_id FROM rootset_control.email_changes WHERE token_hash=$1 AND expires_at>now()",
          [this.hashSecret(token)],
        )
      ).rows[0];
      if (!locator)
        throw new RootsetError(
          "TOKEN_UNAVAILABLE",
          "Email verification has expired or was already used",
          410,
        );
      await this.lockUserAuthorities(client, [locator.user_id]);
      const user = (
        await client.query(
          "SELECT name,email FROM rootset_control.users WHERE id=$1 FOR UPDATE",
          [locator.user_id],
        )
      ).rows[0];
      const change = (
        await client.query(
          "SELECT * FROM rootset_control.email_changes WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE",
          [this.hashSecret(token), locator.user_id],
        )
      ).rows[0];
      if (!change || !user || user.email !== change.previous_email)
        throw new RootsetError(
          "TOKEN_UNAVAILABLE",
          "Email change is unavailable",
          410,
        );
      try {
        await client.query(
          "UPDATE rootset_control.users SET email=$2,email_verified=true,updated_at=now() WHERE id=$1",
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
        "DELETE FROM rootset_control.email_changes WHERE id=$1",
        [change.id],
      );
      await this.revokeAllUserAccess(change.user_id, undefined, client);
      for (const email of [change.previous_email, change.new_email])
        await this.emailOutbox.enqueue(client, {
          template: "email-changed",
          to: email,
          payload: { name: user.name },
          dedupeKey: `email-notice:${change.id}:${email}`,
        });
    });
    return Response.json(
      { changed: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  private async reauthenticate(request: Request): Promise<Response> {
    const actor = await this.resolveActor(request, "browser");
    if (!actor?.userId)
      throw new RootsetError("UNAUTHENTICATED", "Sign in to continue", 401);
    const data = parse(
      z.strictObject({ password: z.string().min(1).max(1024) }),
      await request.json(),
    );
    const account = (
      await this.config.pool.query(
        `SELECT a.password,EXISTS(SELECT 1 FROM rootset_control.auth_passkeys p WHERE p.user_id=a.user_id) has_passkey FROM rootset_control.auth_accounts a WHERE a.user_id=$1 AND a.provider_id='credential'`,
        [actor.userId],
      )
    ).rows[0];
    if (
      !account?.password ||
      !(await this.verifyPassword({
        password: data.password,
        hash: account.password,
      }))
    )
      throw new RootsetError("ACCESS_DENIED", "Authentication failed", 403);
    if (account.has_passkey)
      throw new RootsetError(
        "STEP_UP_REQUIRED",
        "Verify with a passkey to continue",
        403,
      );
    const authenticatedAt = Date.now();
    const refreshed = await this.config.pool.query(
      `UPDATE rootset_control.sessions SET authenticated_at=$2 WHERE id=$1 AND user_id=$3 AND expires_at>now() AND NOT EXISTS(SELECT 1 FROM rootset_control.auth_passkeys WHERE user_id=$3) RETURNING id`,
      [actor.id, new Date(authenticatedAt), actor.userId],
    );
    if (!refreshed.rowCount)
      throw new RootsetError(
        "STEP_UP_REQUIRED",
        "Verify with a passkey to continue",
        403,
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
        `DELETE FROM rootset_control.auth_recovery_codes WHERE user_id=$1`,
        [userId],
      );
      await client.query(
        `DELETE FROM rootset_control.auth_passkeys WHERE user_id=$1`,
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
