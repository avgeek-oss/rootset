import { createPool, withOrg } from "@rootset/database";
import { scopeNames, JsonValueSchema, RootsetError } from "@rootset/contracts";
import { assertAccess } from "@rootset/access";
import { OperationalObserver } from "@rootset/observability";
import { IdentityService } from "@rootset/identity";
import { TableStorage } from "@rootset/table-storage";
import { JobsService } from "@rootset/jobs";
import { OAuthService, type OAuthConfig } from "@rootset/oauth";
import { RootsetCore } from "./index.js";
import { loadConfig, type Config } from "./config.js";
import { MetadataPaging } from "./paging.js";
import { ReadinessService } from "./readiness.js";

export async function createRuntime(
  baseline: Config = loadConfig(),
  options: { oauthClients?: OAuthConfig["clients"] } = {},
) {
  const pool = createPool(baseline.databaseURL, 10, "api");
  const admissionPool = createPool(baseline.databaseURL, 2, "admission");
  const ddlPool = pool;
  const identityPool = createPool(baseline.databaseURL, 4, "identity");
  try {
    const role = (
      await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0]!;
    if (role.rolsuper || role.rolbypassrls)
      throw new RootsetError(
        "CONFIGURATION_INVALID",
        "Use an ordinary PostgreSQL database owner without superuser or BYPASSRLS privileges",
        500,
      );
    const config = baseline;
    const paging = new MetadataPaging(config.cursorSecret);
    const identity: IdentityService = new IdentityService({
      ...config,
      pool: identityPool,
      smtp: {
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        from: config.smtp.from,
        user: config.smtp.auth?.user,
        password: config.smtp.auth?.pass,
      },
      oauthResolver: (request, audience) =>
        oauth.resolveActor(request, audience === "mcp" ? "mcp" : "api"),
    });
    const observer = new OperationalObserver({
      operatorPool: identityPool,
      pools: {
        api: pool,
        admission: admissionPool,
        identity: identityPool,
      },
    });
    const storage = new TableStorage({
      pool,
      ddlPool,
      cursorSecret: config.cursorSecret,
    });
    const readiness = new ReadinessService(
      identityPool,
      config,
      identity.emailOutbox,
      observer,
    );
    const jobs: JobsService = new JobsService({
      pool,
      ddlPool,
      storage,
      config: {
        metadataPaging: paging,
        idempotencySecret: config.keyHashSecret,
        authoriseHistoryPolicy: async (actor, target) => {
          const current = await identity.refreshPolicyActor(actor);
          await storage.getTable(current, target.tableId);
          for (const scope of ["history:read", "schema:manage"])
            assertAccess(current, {
              scope,
              orgId: current.orgId,
              roles: ["admin"],
            });
          return current;
        },
        artifacts: {
          ...config.artifacts,
          forcePathStyle: true,
          encryptionKey: config.encryptionKey,
        },
        baseURL: config.baseURL,
        outbox: identity.emailOutbox,
        reconcileOperation: (job) =>
          withOrg(pool, job.org_id, async (client) => {
            const row = (
              await client.query<{ result: unknown }>(
                "SELECT result FROM rootset_control.operation_outcomes WHERE job_id=$1 AND org_id=$2 AND operation_id=$3 AND job_input_digest=$4",
                [job.id, job.org_id, job.operation_id, job.input_digest],
              )
            ).rows[0];
            return row ? JsonValueSchema.parse(row.result) : undefined;
          }),
        executeOperation: async (actor, id, input, context) =>
          JsonValueSchema.parse(
            await core.executeWorker(id, actor, input, {
              ...context,
              surface: "worker",
            }),
          ),
      },
      authorise: async (actor, id, target) =>
        core.authorise(actor, id, { ...target }),
    });
    const oauth: OAuthService = new OAuthService(identityPool, {
      baseURL: config.baseURL,
      webURL: config.webURL,
      scopes: scopeNames,
      clients: options.oauthClients,
      resolveSession: (request) => identity.resolveActor(request, "browser"),
      refreshActor: (actor) => identity.refreshActor(actor).catch(() => null),
    });
    const core: RootsetCore = new RootsetCore({
      pool,
      identityPool,
      storage,
      identity,
      jobs,
      config,
      paging,
    });
    identity.setPaging(core.paging);
    return {
      pool,
      admissionPool,
      ddlPool,
      identityPool,
      core,
      storage,
      identity,
      jobs,
      oauth,
      config,
      observer,
      getReadiness: () => readiness.status(),
      close: async () => {
        await Promise.all([
          pool.end(),
          admissionPool.end(),
          identityPool.end(),
        ]);
      },
    };
  } catch (error) {
    await Promise.all([pool.end(), admissionPool.end(), identityPool.end()]);
    throw error;
  }
}
