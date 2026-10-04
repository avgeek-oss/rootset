import { createPool, withOrg } from "@rootset/database";
import { scopeNames, newId, JsonValueSchema } from "@rootset/contracts";
import { assertAccess } from "@rootset/access";
import { CapacityService } from "@rootset/capacity";
import { OperationalObserver } from "@rootset/observability";
import { IdentityService } from "@rootset/identity";
import { TableStorage } from "@rootset/table-storage";
import { JobsService } from "@rootset/jobs";
import { OAuthService, type OAuthConfig } from "@rootset/oauth";
import { RootsetCore } from "./index.js";
import { loadConfig, type Config } from "./config.js";
import { MetadataPaging } from "./paging.js";
import { createBackupNotifications } from "./backup-notifications.js";
import {
  InstallationService,
  resolveInstallationConfig,
} from "./installation.js";

export async function createRuntime(
  baseline: Config = loadConfig(),
  options: { oauthClients?: OAuthConfig["clients"] } = {},
) {
  const pool = createPool(baseline.databaseURL, 10, "api"),
    admissionPool = createPool(baseline.databaseURL, 2, "admission"),
    ddlPool = createPool(baseline.ddlDatabaseURL, 5, "ddl"),
    identityPool = createPool(baseline.identityDatabaseURL, 10, "identity");
  try {
    const resolved = await resolveInstallationConfig(identityPool, baseline),
      config = resolved.config;
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
      authoriseRepair: (actor, input) =>
        core.authorise(actor, "mutateRows", input),
      enqueueDeletion: (actor, kind, input, context) =>
        jobs.enqueueOperation(
          actor,
          kind === "account" ? "deleteAccount" : "deleteOrganisation",
          input,
          {
            idempotencyKey:
              context.idempotencyKey ??
              (typeof input.approvalId === "string"
                ? `delete:${input.approvalId}`
                : `delete:${newId()}`),
            requestId: context.requestId,
            source:
              context.surface === "api" ? "rest" : (context.surface ?? "rest"),
            approvalId: context.actionId,
            stepUpApproved: true,
            client: context.approvalClient,
          },
        ),
    });
    const capacity = new CapacityService(identityPool);
    const observer = new OperationalObserver({
      operatorPool: identityPool,
      pools: {
        api: pool,
        admission: admissionPool,
        ddl: ddlPool,
        identity: identityPool,
      },
    });
    const storage = new TableStorage({
      pool,
      ddlPool,
      cursorSecret: config.cursorSecret,
      capacity,
    });
    const installation = new InstallationService(
      identityPool,
      config,
      resolved.revision,
      identity.emailOutbox,
      capacity,
      observer,
    );
    const jobs: JobsService = new JobsService({
      pool,
      ddlPool,
      storage,
      config: {
        ...createBackupNotifications(
          identityPool,
          identity.emailOutbox,
          config.baseURL,
        ),
        metadataPaging: paging,
        idempotencySecret: config.keyHashSecret,
        recordRepairIntent: (client, actor, intent) =>
          identity.recordRepairIntent(client, actor, intent),
        authorisePolicy: async (actor, target) => {
          const current = await identity.refreshPolicyActor(actor);
          await storage.getDatabase(current, target.databaseId);
          assertAccess(current, {
            scope: "backups:manage",
            orgId: current.orgId,
            databaseId: target.databaseId,
            level: "manage",
            roles: ["owner", "admin"],
          });
          return current;
        },
        authoriseHistoryPolicy: async (actor, target) => {
          const current = await identity.refreshPolicyActor(actor);
          const table = await storage.getTable(current, target.tableId);
          for (const scope of ["history:read", "schema:manage"])
            assertAccess(current, {
              scope,
              orgId: current.orgId,
              ...target,
              databaseId: table.databaseId,
              level: scope === "schema:manage" ? "manage" : "read",
              roles: ["owner", "admin"],
            });
          return current;
        },
        artifacts: {
          ...config.artifacts,
          uploadBaseURL: config.baseURL,
          forcePathStyle: true,
          encryptionKeys: config.encryptionKeys,
          activeKeyId: config.activeEncryptionKeyId,
        },
        baseURL: config.baseURL,
        workerConcurrency: config.workerConcurrency,
        organisationIds: async () =>
          (
            await ddlPool.query<{ org_id: string }>(
              "SELECT id AS org_id FROM rootset_control.maintenance_org_directory()",
            )
          ).rows.map((r) => r.org_id),
        outbox: identity.emailOutbox,
        deletionRetention: () => installation.deletionRetention(),
        deletionMetadata: (orgId) =>
          withOrg(
            ddlPool,
            orgId,
            async (client) =>
              (
                await client.query<{
                  metadata: { organisationDeletedAt: string | null };
                }>("SELECT rootset_control.deletion_metadata($1) AS metadata", [
                  orgId,
                ])
              ).rows[0]!.metadata,
          ),
        purgeAccountAudit: (orgId, before, suppliedClient) => {
          const purge = async (
            client: import("@rootset/database").PoolClient,
          ) =>
            Number(
              (
                await client.query<{ count: string }>(
                  "SELECT rootset_control.purge_retained_account_audit($1,$2::timestamptz)::text AS count",
                  [orgId, before],
                )
              ).rows[0]!.count,
            );
          return suppliedClient
            ? purge(suppliedClient)
            : withOrg(ddlPool, orgId, purge);
        },
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
              actionId: context.approvalId,
            }),
          ),
      },
      authorise: async (actor, id, target) =>
        core.authorise(actor, id, { ...target }),
    });
    const oauth: OAuthService = new OAuthService(identityPool, {
      baseURL: config.baseURL,
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
      installation,
      config,
      paging,
    });
    identity.setPaging(core.paging);
    identity.setExecutor((id, actor, input, context) =>
      core.execute(id, actor, input, {
        ...context,
        surface: context.surface === "api" ? "rest" : context.surface,
      }),
    );
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
      installation,
      observer,
      getAdmissionLimits: () => installation.admissionLimits(),
      getReadiness: () => installation.status(),
      close: async () => {
        await Promise.all([
          pool.end(),
          admissionPool.end(),
          ddlPool.end(),
          identityPool.end(),
        ]);
      },
    };
  } catch (error) {
    await Promise.all([
      pool.end(),
      admissionPool.end(),
      ddlPool.end(),
      identityPool.end(),
    ]);
    throw error;
  }
}
