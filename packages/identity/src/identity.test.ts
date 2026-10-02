import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Pool, withOrg, migrate } from "@rootset/database";
import {
  AccountActionSchema,
  DatabaseSchema,
  BackupPolicySchema,
  ContextSchema,
  KeyCreatedSchema,
  ProfileSchema,
  ViewPreferencesResultSchema,
  analyseNumberLexeme,
  canonicalJson,
  operationMap,
  newId,
  type Actor,
} from "@rootset/contracts";
import {
  EmailOutbox,
  decryptProtected,
  type EmailPayload,
} from "@rootset/email";
import { createIdentityService, type IdentityService } from "./index";
import { MetadataPaging } from "../../core/src/paging";
import { createRuntime } from "../../core/src/runtime";
import { loadConfig } from "../../core/src/config";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";

try {
  process.loadEnvFile(
    fileURLToPath(new URL("../../../.env.test", import.meta.url)),
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const ownerURL = process.env.ROOTSET_TEST_DATABASE_URL;
const identityURL =
  process.env.ROOTSET_TEST_IDENTITY_DATABASE_URL ??
  process.env.ROOTSET_IDENTITY_DATABASE_URL;
const baseURL = "http://localhost:6300";
function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
function request(path: string, body?: unknown, cookie?: string): Request {
  return new Request(`${baseURL}/v1/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: baseURL,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function latestVerification(
  service: IdentityService,
  pool: Pool,
  email: string,
): Promise<void> {
  const row = (
    await pool.query(
      `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='account-verification' ORDER BY created_at DESC LIMIT 1`,
      [email],
    )
  ).rows[0];
  assert.ok(row, "A persisted verification email is required");
  const payload = decryptProtected<EmailPayload>(
    row.payload_encrypted,
    service.config,
  );
  assert.ok(payload.actionUrl);
  const result = await service.auth.handler(new Request(payload.actionUrl!));
  assert.ok(
    result.status === 200 || result.status === 302,
    "Email verification completes",
  );
}
async function login(
  service: IdentityService,
  email: string,
  password: string,
): Promise<{
  response: Response;
  body: Record<string, unknown>;
  cookie: string;
}> {
  const response = await service.auth.handler(
    request("/sign-in/email", { email, password }),
  );
  return {
    response,
    body: (await response.clone().json()) as Record<string, unknown>,
    cookie: cookies(response),
  };
}
function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/, ""))
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = Buffer.from(
    bits.match(/.{8}/g)!.map((value) => parseInt(value, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac("sha1", bytes).update(counter).digest();
  const offset = hash[hash.length - 1]! & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}

test(
  "KEY-05 KEY-06 approved named issuance and rotation serialize exact retries before consuming approval and revalidate current authority",
  { skip: !ownerURL || !identityURL, timeout: 60000 },
  async () => {
    const fixture = await isolatedDatabase();
    const config = {
      pool: fixture.identity,
      baseURL,
      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKeys: { test: randomBytes(32).toString("base64") },
      activeEncryptionKeyId: "test",
    };
    const service = createIdentityService(config),
      email = `key-receipts-${newId().toLowerCase()}@example.test`,
      password = randomBytes(32).toString("base64url");
    const execute = (operation: string, actor: Actor, input: unknown) =>
      service.execute(operation, actor, input, { idempotencyKey: newId() });
    const errorCode = (code: string) => (error: unknown) =>
      (error as { code: string }).code === code;
    try {
      await service.claimSetup({
        bootstrapSecret: config.bootstrapSecret,
        name: "Key receipt Owner",
        email,
        password,
        organisationName: "Disposable key receipt fixture",
      });
      await latestVerification(service, fixture.identity, email);
      const session = await login(service, email, password);
      assert.equal(session.response.status, 200);
      const owner = (await service.resolveActor(
        request("/get-session", undefined, session.cookie),
        "browser",
      ))!;
      const createInitiator = async () => {
        const issued = KeyCreatedSchema.parse(
          await execute("createPersonalKey", owner, {
            orgId: owner.orgId,
            name: "Actual scoped receipt initiator",
            scopes: ["keys:manage", "rows:read"],
            targets: [],
            unrestricted: true,
          }),
        );
        return {
          issued,
          actor: (await service.resolveActor(
            new Request(`${baseURL}/v1/me`, {
              headers: { authorization: `Bearer ${issued.secret}` },
            }),
            "api",
          ))!,
        };
      };
      const initiator = await createInitiator();
      const named = (
        actor: Actor,
        operation: string,
        input: Record<string, unknown>,
        context: { actionId: string; idempotencyKey: string },
        effect?: () => void,
      ) =>
        service.withOperationApproval(
          actor,
          operation,
          input,
          context,
          (client) => {
            effect?.();
            return service.execute(operation, actor, input, {
              ...context,
              approvalClient: client,
            });
          },
        );
      let retained:
        | {
            operation: string;
            input: Record<string, unknown>;
            context: { actionId: string; idempotencyKey: string };
          }
        | undefined;
      for (const kind of ["Personal", "Team"]) {
        let originalId = "";
        for (const verb of ["create", "rotate"]) {
          const operation = `${verb}${kind}Key`,
            input: Record<string, unknown> =
              verb === "create"
                ? {
                    orgId: owner.orgId,
                    name: `${kind} key receipt`,
                    scopes: ["rows:read"],
                    targets: [],
                    unrestricted: true,
                  }
                : {
                    ...(kind === "Team" ? { orgId: owner.orgId } : {}),
                    id: originalId,
                    overlapSeconds: 0,
                  };
          const action = AccountActionSchema.parse(
            await execute("beginAccountAction", initiator.actor, {
              orgId: owner.orgId,
              type: verb === "create" ? "create_key" : "rotate_key",
              operationId: operation,
              input,
            }),
          );
          await service.approveAction(action.id, owner);
          const context = { actionId: action.id, idempotencyKey: newId() },
            before = Number(
              (
                await fixture.owner.query(
                  "SELECT count(*) FROM rootset_control.api_keys",
                )
              ).rows[0].count,
            );
          let effects = 0;
          const results = (
            await Promise.all([
              named(
                initiator.actor,
                operation,
                input,
                context,
                () => effects++,
              ),
              named(
                initiator.actor,
                operation,
                input,
                context,
                () => effects++,
              ),
            ])
          ).map((result) => KeyCreatedSchema.parse(result));
          const [first, second] = results;
          assert.ok(first && second);
          assert.equal(
            effects,
            1,
            "Only one request reaches credential issuance",
          );
          assert.equal(results.filter((result) => result.secret).length, 1);
          assert.equal(first.key.id, second.key.id);
          assert.equal(
            Number(
              (
                await fixture.owner.query(
                  "SELECT count(*) FROM rootset_control.api_keys",
                )
              ).rows[0].count,
            ),
            before + 1,
          );
          const replay = KeyCreatedSchema.parse(
            await named(initiator.actor, operation, input, context),
          );
          assert.equal(replay.key.id, first.key.id);
          assert.equal(replay.secret, undefined);
          const consumed = AccountActionSchema.parse(
            await execute("getAccountAction", initiator.actor, {
              id: action.id,
            }),
          );
          assert.equal(consumed.state, "consumed");
          assert.equal(
            KeyCreatedSchema.parse(consumed.result).secret,
            undefined,
          );
          const changedInput =
            verb === "create"
              ? { ...input, name: "Changed name" }
              : { ...input, overlapSeconds: 1 };
          await assert.rejects(
            () => named(initiator.actor, operation, changedInput, context),
            errorCode("IDEMPOTENCY_CONFLICT"),
          );
          await assert.rejects(
            () =>
              named(initiator.actor, operation, input, {
                ...context,
                idempotencyKey: newId(),
              }),
            errorCode("STEP_UP_REQUIRED"),
          );
          await assert.rejects(
            () =>
              named(initiator.actor, operation, input, {
                ...context,
                actionId: newId(),
              }),
            errorCode("IDEMPOTENCY_CONFLICT"),
          );
          const receipt = (
            await fixture.owner.query(
              "SELECT digest,result FROM rootset_control.key_requests WHERE actor_id=$1 AND operation=$2 AND key=$3",
              [initiator.actor.id, operation, context.idempotencyKey],
            )
          ).rows[0];
          assert.match(receipt.digest, /^[a-f0-9]{64}$/);
          assert.equal(receipt.result.secret, undefined);
          assert.ok(
            !JSON.stringify(receipt).includes(
              results.find((result) => result.secret)!.secret!,
            ),
          );
          if (verb === "create") originalId = first.key.id;
          retained = { operation, input, context };
        }
      }
      assert.ok(retained);
      const mixedInput = {
          orgId: owner.orgId,
          name: "Named route and action completion share a receipt",
          scopes: ["rows:read"],
          targets: [],
          unrestricted: true,
        },
        mixedAction = AccountActionSchema.parse(
          await execute("beginAccountAction", initiator.actor, {
            orgId: owner.orgId,
            type: "create_key",
            operationId: "createPersonalKey",
            input: mixedInput,
          }),
        );
      await service.approveAction(mixedAction.id, owner);
      const mixedContext = {
          actionId: mixedAction.id,
          idempotencyKey: newId(),
        },
        mixedBefore = Number(
          (
            await fixture.owner.query(
              "SELECT count(*) FROM rootset_control.api_keys",
            )
          ).rows[0].count,
        ),
        mixedResults = await Promise.all([
          named(initiator.actor, "createPersonalKey", mixedInput, mixedContext),
          service.execute(
            "completeAccountAction",
            initiator.actor,
            { id: mixedAction.id },
            { idempotencyKey: mixedContext.idempotencyKey },
          ),
        ]),
        namedResult = KeyCreatedSchema.parse(mixedResults[0]),
        completedResult = KeyCreatedSchema.parse(
          AccountActionSchema.parse(mixedResults[1]).result,
        );
      assert.equal(namedResult.key.id, completedResult.key.id);
      assert.equal(
        [namedResult, completedResult].filter((result) => result.secret).length,
        1,
      );
      assert.equal(
        Number(
          (
            await fixture.owner.query(
              "SELECT count(*) FROM rootset_control.api_keys",
            )
          ).rows[0].count,
        ),
        mixedBefore + 1,
        "Named and completion paths commit one credential without inverse locks",
      );
      const retry = () =>
        named(
          initiator.actor,
          retained!.operation,
          retained!.input,
          retained!.context,
        );
      await fixture.owner.query(
        "UPDATE rootset_control.api_keys SET scopes='[\"keys:manage\"]' WHERE id=$1",
        [initiator.issued.key.id],
      );
      await assert.rejects(retry, errorCode("DELEGATION_EXCEEDS_AUTHORITY"));
      await fixture.owner.query(
        'UPDATE rootset_control.api_keys SET scopes=\'["keys:manage","rows:read"]\',unrestricted=false WHERE id=$1',
        [initiator.issued.key.id],
      );
      await assert.rejects(retry, errorCode("DELEGATION_EXCEEDS_AUTHORITY"));
      await fixture.owner.query(
        "UPDATE rootset_control.api_keys SET unrestricted=true WHERE id=$1",
        [initiator.issued.key.id],
      );
      const other = await createInitiator(),
        receiptsBefore = (
          await fixture.owner.query(
            "SELECT count(*) FROM rootset_control.key_requests",
          )
        ).rows[0].count;
      await assert.rejects(
        () =>
          named(
            other.actor,
            retained!.operation,
            retained!.input,
            retained!.context,
          ),
        errorCode("STEP_UP_REQUIRED"),
      );
      assert.equal(
        (
          await fixture.owner.query(
            "SELECT count(*) FROM rootset_control.key_requests",
          )
        ).rows[0].count,
        receiptsBefore,
        "Unauthorized first-use receipt placeholder rolls back",
      );
      const databaseId = newId(),
        tableId = newId();
      await fixture.owner.query(
        "INSERT INTO rootset_control.databases(id,org_id,name,schema_name) VALUES($1,$2,'Receipt target fixture',$3)",
        [databaseId, owner.orgId, `rsd_${databaseId.toLowerCase()}`],
      );
      await fixture.owner.query(
        "INSERT INTO rootset_control.tables(id,database_id,org_id,name,physical_name) VALUES($1,$2,$3,'Receipt table fixture',$4)",
        [tableId, databaseId, owner.orgId, `rst_${tableId.toLowerCase()}`],
      );
      const targetInput = {
          orgId: owner.orgId,
          name: "Scoped receipt",
          scopes: ["rows:read"],
          targets: [{ databaseId, tableId, level: "read" }],
          unrestricted: false,
        },
        targetAction = AccountActionSchema.parse(
          await execute("beginAccountAction", initiator.actor, {
            orgId: owner.orgId,
            type: "create_key",
            operationId: "createPersonalKey",
            input: targetInput,
          }),
        );
      await service.approveAction(targetAction.id, owner);
      const targetContext = {
        actionId: targetAction.id,
        idempotencyKey: newId(),
      };
      KeyCreatedSchema.parse(
        await named(
          initiator.actor,
          "createPersonalKey",
          targetInput,
          targetContext,
        ),
      );
      await fixture.owner.query(
        "UPDATE rootset_control.databases SET state='deleting' WHERE id=$1",
        [databaseId],
      );
      await assert.rejects(
        () =>
          named(
            initiator.actor,
            "createPersonalKey",
            targetInput,
            targetContext,
          ),
        errorCode("RESOURCE_NOT_FOUND"),
      );
      await fixture.owner.query(
        "UPDATE rootset_control.databases SET state='active' WHERE id=$1",
        [databaseId],
      );
      const orgId = newId();
      await fixture.owner.query(
        "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Foreign target fixture')",
        [orgId],
      );
      await fixture.owner.query(
        "UPDATE rootset_control.tables SET org_id=$2 WHERE id=$1",
        [tableId, orgId],
      );
      await assert.rejects(
        () =>
          named(
            initiator.actor,
            "createPersonalKey",
            targetInput,
            targetContext,
          ),
        errorCode("RESOURCE_NOT_FOUND"),
      );
      await fixture.owner.query(
        "UPDATE rootset_control.tables SET org_id=$2 WHERE id=$1",
        [tableId, owner.orgId],
      );
      await fixture.owner.query(
        "UPDATE rootset_control.key_requests SET digest=repeat('0',64) WHERE actor_id=$1 AND operation=$2 AND key=$3",
        [
          initiator.actor.id,
          retained.operation,
          retained.context.idempotencyKey,
        ],
      );
      await assert.rejects(retry, errorCode("IDEMPOTENCY_CONFLICT"));
      await execute("revokePersonalKey", owner, {
        id: initiator.issued.key.id,
      });
      await assert.rejects(retry, errorCode("UNAUTHENTICATED"));
    } finally {
      await fixture.close();
    }
  },
);

test(
  "AUTH-07 API09 external completion and named Core policy requests share receipt-first locking and revalidate resource authority",
  { skip: !ownerURL || !identityURL, timeout: 60000 },
  async () => {
    const fixture = await isolatedDatabase();
    const runtime = await createRuntime({
      ...loadConfig(),
      baseURL,
      databaseURL: fixture.app.options.connectionString!,
      ddlDatabaseURL: fixture.ddl.options.connectionString!,
      identityDatabaseURL: fixture.identity.options.connectionString!,
    });
    try {
      const service = runtime.identity,
        email = `external-receipt-${newId().toLowerCase()}@example.test`,
        password = randomBytes(32).toString("base64url");
      await service.claimSetup({
        bootstrapSecret: service.config.bootstrapSecret,
        name: "External receipt Owner",
        email,
        password,
        organisationName: "Disposable external receipt fixture",
      });
      await latestVerification(service, fixture.identity, email);
      const signedIn = await login(service, email, password);
      assert.equal(signedIn.response.status, 200);
      const owner = (await service.resolveActor(
        request("/get-session", undefined, signedIn.cookie),
        "browser",
      ))!;
      const execute = (
        operation: string,
        actor: Actor,
        input: unknown,
        context: Parameters<typeof runtime.core.execute>[3] = {},
      ) =>
        runtime.core.execute(operation, actor, input, {
          surface: "browser",
          idempotencyKey: newId(),
          ...context,
        });
      const database = DatabaseSchema.parse(
        await execute("createDatabase", owner, {
          orgId: owner.orgId,
          name: "Receipt-first policy",
        }),
      );
      const issued = KeyCreatedSchema.parse(
        await execute("createPersonalKey", owner, {
          orgId: owner.orgId,
          name: "Actual scoped policy initiator",
          scopes: ["backups:manage", "databases:read"],
          targets: [{ databaseId: database.id, level: "manage" }],
          unrestricted: false,
        }),
      );
      const actor = (await service.resolveActor(
        new Request(`${baseURL}/v1/me`, {
          headers: { authorization: `Bearer ${issued.secret}` },
        }),
        "api",
      ))!;
      const input = {
        orgId: owner.orgId,
        databaseId: database.id,
        enabled: false,
        cron: "0 2 * * *",
        timezone: "UTC",
        retentionDays: 7,
        retentionCount: 7,
        maxRuntimeSeconds: 3600,
        encryption: true,
        destination: "installation",
        notifications: false,
      };
      const begin = async () =>
        AccountActionSchema.parse(
          await execute("beginAccountAction", actor, {
            orgId: owner.orgId,
            type: "set_backup_policy",
            operationId: "setBackupPolicy",
            input,
          }),
        );
      const action = await begin();
      await service.approveAction(action.id, owner);
      const context = {
        surface: "rest" as const,
        actionId: action.id,
        idempotencyKey: `account-action:${action.id}`,
      };
      let notifyNamed!: () => void, notifyCompletion!: () => void;
      const namedHeld = new Promise<void>((resolve) => {
          notifyNamed = resolve;
        }),
        completionDispatched = new Promise<void>((resolve) => {
          notifyCompletion = resolve;
        });
      const privateIdentity = service as unknown as {
          requireApprovedAction: (...args: unknown[]) => Promise<unknown>;
          externalExecutor: (...args: unknown[]) => Promise<unknown>;
        },
        privateJobs = runtime.jobs as unknown as {
          setPolicy: (...args: unknown[]) => Promise<unknown>;
        };
      const approve = privateIdentity.requireApprovedAction.bind(service),
        external = privateIdentity.externalExecutor.bind(service),
        setPolicy = privateJobs.setPolicy.bind(runtime.jobs);
      let paused = false,
        policyEffects = 0;
      // Schedule the two real dispatch paths while the named request holds its receipt.
      privateIdentity.requireApprovedAction = async (...args) => {
        if (args[4] === true && !paused) {
          paused = true;
          notifyNamed();
          await Promise.race([
            completionDispatched,
            new Promise<never>((_, reject) => {
              const timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Completion did not dispatch before its action lock",
                    ),
                  ),
                5000,
              );
              timer.unref();
            }),
          ]);
        }
        return approve(...args);
      };
      privateIdentity.externalExecutor = async (...args) => {
        notifyCompletion();
        return external(...args);
      };
      privateJobs.setPolicy = async (...args) => {
        policyEffects++;
        return setPolicy(...args);
      };
      const named = runtime.core.execute(
        "setBackupPolicy",
        actor,
        input,
        context,
      );
      await namedHeld;
      const completed = runtime.core.execute(
        "completeAccountAction",
        actor,
        { id: action.id },
        { surface: "mcp", idempotencyKey: context.idempotencyKey },
      );
      const results = await Promise.all([named, completed]);
      privateIdentity.requireApprovedAction = approve;
      privateIdentity.externalExecutor = external;
      privateJobs.setPolicy = setPolicy;
      const policy = BackupPolicySchema.parse(results[0]),
        completion = AccountActionSchema.parse(results[1]);
      assert.equal(completion.state, "consumed");
      assert.deepEqual(BackupPolicySchema.parse(completion.result), policy);
      assert.equal(
        policyEffects,
        1,
        "Concurrent named and completion paths perform one actual policy write",
      );
      assert.equal(
        (
          await fixture.owner.query(
            "SELECT count(*) FROM rootset_control.backup_policies WHERE database_id=$1",
            [database.id],
          )
        ).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await fixture.owner.query(
            "SELECT count(*) FROM rootset_control.control_mutation_replays WHERE operation_id='setBackupPolicy' AND org_id=$1 AND outcome IS NOT NULL",
            [owner.orgId],
          )
        ).rows[0].count,
        "1",
      );
      const persisted = (
        await fixture.owner.query(
          "SELECT consumed_at,payload_encrypted,result FROM rootset_control.account_actions WHERE id=$1",
          [action.id],
        )
      ).rows[0];
      assert.ok(persisted.consumed_at);
      assert.equal(persisted.payload_encrypted, "");
      assert.deepEqual(BackupPolicySchema.parse(persisted.result), policy);
      const transaction = (
        await fixture.owner.query(
          "SELECT xmin::text transaction FROM rootset_control.backup_policies WHERE database_id=$1",
          [database.id],
        )
      ).rows[0].transaction;
      assert.deepEqual(
        await runtime.core.execute("setBackupPolicy", actor, input, context),
        policy,
      );
      assert.equal(
        (
          await fixture.owner.query(
            "SELECT xmin::text transaction FROM rootset_control.backup_policies WHERE database_id=$1",
            [database.id],
          )
        ).rows[0].transaction,
        transaction,
      );
      const narrowedAction = await begin();
      await service.approveAction(narrowedAction.id, owner);
      await fixture.owner.query(
        "UPDATE rootset_control.api_keys SET targets=$2 WHERE id=$1",
        [
          issued.key.id,
          JSON.stringify([{ databaseId: database.id, level: "read" }]),
        ],
      );
      await assert.rejects(
        () => runtime.core.execute("setBackupPolicy", actor, input, context),
        (error) => (error as { code: string }).code === "RESOURCE_NOT_FOUND",
      );
      await assert.rejects(
        () =>
          runtime.core.execute(
            "completeAccountAction",
            actor,
            { id: narrowedAction.id },
            { surface: "mcp", idempotencyKey: newId() },
          ),
        (error) => (error as { code: string }).code === "RESOURCE_NOT_FOUND",
      );
      assert.equal(
        (
          await fixture.owner.query(
            "SELECT xmin::text transaction FROM rootset_control.backup_policies WHERE database_id=$1",
            [database.id],
          )
        ).rows[0].transaction,
        transaction,
      );
      assert.equal(
        AccountActionSchema.parse(
          await execute("getAccountAction", actor, { id: narrowedAction.id }),
        ).state,
        "approved",
      );
    } finally {
      await runtime.close();
      await fixture.close();
    }
  },
);

test(
  "AUTH-07 AUTH-08 UI-shaped sign-out approvals preserve or revoke delegated authority with an immutable boolean",
  { skip: !ownerURL || !identityURL },
  async () => {
    const fixture = await isolatedDatabase();
    const config = {
      pool: fixture.identity,
      baseURL,
      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKeys: { test: randomBytes(32).toString("base64") },
      activeEncryptionKeyId: "test",
    };
    const service = createIdentityService(config);
    const email = `signout-${newId().toLowerCase()}@example.test`;
    const password = randomBytes(32).toString("base64url");
    const execute = (id: string, actor: Actor, input: unknown) =>
      service.execute(id, actor, input, { idempotencyKey: newId() });
    const freshSession = async () => {
      const session = await login(service, email, password);
      assert.equal(session.response.status, 200);
      return (await service.resolveActor(
        request("/get-session", undefined, session.cookie),
        "browser",
      ))!;
    };
    try {
      await service.claimSetup({
        bootstrapSecret: config.bootstrapSecret,
        name: "Sign-out approval fixture",
        email,
        password,
        organisationName: "Disposable sign-out approval fixture",
      });
      await latestVerification(service, fixture.identity, email);
      const actor = await freshSession();
      const key = KeyCreatedSchema.parse(
        await execute("createPersonalKey", actor, {
          orgId: actor.orgId,
          name: "Sign-out delegated key",
          scopes: ["rows:read"],
          targets: [],
          unrestricted: true,
        }),
      );
      assert.ok(key.secret);
      const bearer = () =>
        service.resolveActor(
          new Request(`${baseURL}/v1/me`, {
            headers: { authorization: `Bearer ${key.secret}` },
          }),
          "api",
        );
      // Token issuance is exercised by the HTTP/MCP suite; this grant checks persisted revocation state.
      const grantId = newId();
      await fixture.owner.query(
        `INSERT INTO rootset_control.oauth_grants(id,org_id,user_id,client_id,scopes,targets,actor,resource) VALUES($1,$2,$3,'signout-fixture-client',ARRAY['rows:read'],'[]',$4,$5)`,
        [
          grantId,
          actor.orgId,
          actor.userId,
          JSON.stringify({
            ...actor,
            kind: "oauth",
            id: grantId,
            credentialId: grantId,
            clientId: "signout-fixture-client",
          }),
          `${baseURL}/mcp`,
        ],
      );
      await assert.rejects(
        () =>
          execute("beginAccountAction", actor, {
            type: "sign_out_everywhere",
            operationId: "signOutEverywhere",
            input: { revokeDelegated: "false" },
          }),
        (error) => (error as { code: string }).code === "VALIDATION_FAILED",
      );
      const preserve = AccountActionSchema.parse(
        await execute("beginAccountAction", actor, {
          type: "sign_out_everywhere",
          operationId: "signOutEverywhere",
          input: { revokeDelegated: false },
        }),
      );
      await service.approveAction(preserve.id, actor);
      await assert.rejects(
        () =>
          service.execute(
            "signOutEverywhere",
            actor,
            { revokeDelegated: true },
            { actionId: preserve.id, idempotencyKey: newId() },
          ),
        (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
      );
      assert.ok(await service.refreshActor(actor));
      assert.equal(
        (
          await fixture.owner.query(
            `SELECT consumed_at FROM rootset_control.account_actions WHERE id=$1`,
            [preserve.id],
          )
        ).rows[0].consumed_at,
        null,
      );
      const preserved = AccountActionSchema.parse(
        await execute("completeAccountAction", actor, { id: preserve.id }),
      );
      assert.deepEqual(preserved.result, { revoked: true });
      await assert.rejects(() => service.refreshActor(actor));
      assert.ok(await bearer());
      assert.equal(
        (
          await fixture.owner.query(
            `SELECT revoked_at FROM rootset_control.oauth_grants WHERE id=$1`,
            [grantId],
          )
        ).rows[0].revoked_at,
        null,
      );
      const renewed = await freshSession();
      const secondSession = await freshSession();
      const revoke = AccountActionSchema.parse(
        await execute("beginAccountAction", renewed, {
          type: "sign_out_everywhere",
          operationId: "signOutEverywhere",
          input: { revokeDelegated: true },
        }),
      );
      await service.approveAction(revoke.id, renewed);
      const revoked = AccountActionSchema.parse(
        await execute("completeAccountAction", renewed, { id: revoke.id }),
      );
      assert.deepEqual(revoked.result, { revoked: true });
      await assert.rejects(() => service.refreshActor(renewed));
      await assert.rejects(() => service.refreshActor(secondSession));
      assert.equal(await bearer(), null);
      assert.equal(
        (
          await fixture.owner.query(
            `SELECT count(*) FROM rootset_control.sessions WHERE user_id=$1`,
            [actor.userId],
          )
        ).rows[0].count,
        "0",
      );
      assert.ok(
        (
          await fixture.owner.query(
            `SELECT revoked_at FROM rootset_control.oauth_grants WHERE id=$1`,
            [grantId],
          )
        ).rows[0].revoked_at,
      );
    } finally {
      await fixture.close();
    }
  },
);

test(
  "AUTH-07 legacy password digests are erased and pending approvals expire while verified ownership survives",
  { skip: !ownerURL || !identityURL },
  async () => {
    const fixture = await isolatedDatabase();
    const config = {
      pool: fixture.identity,
      baseURL,
      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKeys: { test: randomBytes(32).toString("base64") },
      activeEncryptionKeyId: "test",
    };
    const service = createIdentityService(config);
    const input = {
      bootstrapSecret: config.bootstrapSecret,
      name: "Digest fixture",
      email: "digest-owner@example.test",
      password: "Bound digest verification password",
      organisationName: "Digest verification",
    };
    try {
      await service.claimSetup(input);
      const bootstrap = (
        await fixture.owner.query("SELECT * FROM rootset_control.bootstrap")
      ).rows[0];
      const legacyDigest = createHash("sha256")
        .update(
          canonicalJson({
            name: input.name,
            email: input.email,
            password: input.password,
            organisationName: input.organisationName,
          }),
        )
        .digest("hex");
      assert.notEqual(bootstrap.claim_digest, legacyDigest);
      await latestVerification(service, fixture.identity, input.email);
      const session = await login(service, input.email, input.password);
      assert.ok(session.response.ok);
      const actor = (await service.resolveActor(
        request("/get-session", undefined, session.cookie),
        "browser",
      ))!;
      const pending = newId(),
        consumed = newId();
      await fixture.owner.query(
        "UPDATE rootset_control.bootstrap SET claim_digest=$1",
        [legacyDigest],
      );
      await fixture.owner.query(
        "INSERT INTO rootset_control.account_actions(id,user_id,org_id,actor_id,operation,payload_encrypted,digest,expires_at,consumed_at,result) VALUES($1,$3,$4,$5,'changePassword','legacy-protected-payload',$6,now()+interval '10 minutes',NULL,NULL),($2,$3,$4,$5,'changePassword','','legacy-consumed-digest',now()+interval '10 minutes',now(),'{\"changed\":true}')",
        [pending, consumed, actor.userId, actor.orgId, actor.id, legacyDigest],
      );
      const migrationURL = new URL(
        "../../database/migrations/036_bound_digest_protocol.sql",
        import.meta.url,
      );
      let sql: string;
      try {
        sql = await readFile(migrationURL, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        sql = await readFile(new URL(`${migrationURL.href}.tmp`), "utf8");
      }
      await fixture.owner.query(sql);
      const rows = (
        await fixture.owner.query(
          "SELECT digest,payload_encrypted,result FROM rootset_control.account_actions ORDER BY id",
        )
      ).rows;
      assert.ok(
        rows.every((row) => row.digest === "" && row.payload_encrypted === ""),
      );
      assert.deepEqual(
        (
          (await service.execute("getAccountAction", actor, {
            id: consumed,
          })) as { result: unknown }
        ).result,
        { changed: true },
      );
      const expired = AccountActionSchema.parse(
        await service.execute("getAccountAction", actor, { id: pending }),
      );
      assert.equal(expired.state, "expired");
      assert.equal(
        (expired.result as { reason: string }).reason,
        "approval_protocol_updated",
      );
      await assert.rejects(() => service.approveAction(pending, actor));
      await assert.rejects(() =>
        service.execute("completeAccountAction", actor, { id: pending }),
      );
      assert.deepEqual(await service.setupStatus(), {
        claimed: true,
        verified: true,
      });
      assert.equal(
        (
          await fixture.owner.query(
            "SELECT claim_digest FROM rootset_control.bootstrap",
          )
        ).rows[0].claim_digest,
        null,
      );
      await assert.rejects(
        () => service.claimSetup(input),
        (error) => (error as { code: string }).code === "SETUP_ALREADY_CLAIMED",
      );
    } finally {
      await fixture.close();
    }
  },
);

test(
  "ACC/AUTH/KEY real PostgreSQL identity, invitation, MFA, revocation and immutable approvals",
  { skip: !ownerURL || !identityURL, timeout: 120000 },
  async (t) => {
    const databaseName = `rootset_identity_${randomBytes(6).toString("hex")}`;
    const admin = new Pool({ connectionString: ownerURL });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const ownerAddress = new URL(ownerURL!),
      identityAddress = new URL(identityURL!);
    ownerAddress.pathname = `/${databaseName}`;
    identityAddress.pathname = `/${databaseName}`;
    const owner = new Pool({ connectionString: ownerAddress.href });
    const pool = new Pool({ connectionString: identityAddress.href, max: 12 });
    try {
      await migrate(owner);
      const config = {
        pool,
        baseURL,
        secret: randomBytes(32).toString("hex"),
        bootstrapSecret: randomBytes(32).toString("hex"),
        keyHashSecret: randomBytes(32).toString("hex"),
        encryptionKeys: { v1: randomBytes(32).toString("base64") },
        activeEncryptionKeyId: "v1",
      };
      const service = createIdentityService(config);
      const execute = (
        operationId: string,
        current: Actor,
        value: unknown,
        context: Parameters<IdentityService["execute"]>[3] = {},
      ) =>
        service.execute(operationId, current, value, {
          idempotencyKey: newId(),
          ...context,
        });
      service.setPaging(new MetadataPaging(randomBytes(32).toString("hex")));
      let password = "Rootset verification password 2026";
      const viewerPassword = password;
      let email = "owner@example.test";
      let actor: Actor;
      let cookie = "";
      let orgId = "";
      await t.test(
        "ACC-01 concurrent setup creates one pending owner and retries reconcile",
        async () => {
          const input = {
            bootstrapSecret: config.bootstrapSecret,
            name: "Rootset Owner",
            email,
            password,
            organisationName: "Identity verification",
          };
          const attempts = await Promise.allSettled([
            service.claimSetup(input),
            service.claimSetup(input),
          ]);
          assert.equal(
            attempts.filter((r) => r.status === "fulfilled").length,
            2,
            JSON.stringify(
              attempts
                .filter((r) => r.status === "rejected")
                .map((r) =>
                  r.status === "rejected"
                    ? {
                        code: (r.reason as { code?: string }).code,
                        message: (r.reason as Error).message,
                      }
                    : null,
                ),
            ),
          );
          const claimed = (
            await owner.query(
              `SELECT org_id,user_id,claim_digest FROM rootset_control.bootstrap`,
            )
          ).rows[0];
          orgId = claimed.org_id;
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.organisations`,
              )
            ).rows[0].count,
            "1",
          );
          assert.deepEqual(await service.setupStatus(), {
            claimed: true,
            verified: false,
          });
          const refused = await login(service, email, password);
          assert.equal(refused.response.ok, false);
          await latestVerification(service, pool, email);
          assert.deepEqual(await service.setupStatus(), {
            claimed: true,
            verified: true,
          });
          const session = await login(service, email, password);
          assert.ok(session.response.ok);
          cookie = session.cookie;
          actor = (await service.resolveActor(
            request("/get-session", undefined, cookie),
            "browser",
          ))!;
          assert.equal(actor.role, "owner");
          ContextSchema.parse(await execute("getContext", actor, {}));
          ProfileSchema.parse(await execute("getProfile", actor, {}));
          await assert.rejects(() =>
            service.claimSetup({ ...input, email: "new@example.test" }),
          );
        },
      );
      await t.test(
        "API09 identity mutation retries dedupe invitations/actions, reject changed input and recheck live sessions",
        async () => {
          await assert.rejects(
            () =>
              service.execute("updateProfile", actor, {
                name: "Missing replay key",
              }),
            (error) => (error as { code: string }).code === "VALIDATION_FAILED",
          );
          const invitation = {
            orgId,
            email: "replay-invitation@example.test",
            role: "viewer",
          };
          const invitationContext = { idempotencyKey: newId() };
          const outcomes = await Promise.all(
            Array.from({ length: 4 }, () =>
              execute("inviteMember", actor, invitation, invitationContext),
            ),
          );
          for (const outcome of outcomes)
            assert.deepEqual(outcome, outcomes[0]);
          await assert.rejects(
            () =>
              execute(
                "inviteMember",
                actor,
                { ...invitation, email: "changed-replay@example.test" },
                invitationContext,
              ),
            (error) =>
              (error as { code: string }).code === "IDEMPOTENCY_CONFLICT",
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM rootset_control.invitations WHERE email=$1",
                [invitation.email],
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM rootset_control.email_outbox WHERE to_address=$1 AND template='invitation'",
                [invitation.email],
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM rootset_control.account_audit WHERE operation='inviteMember' AND target_id=$1",
                [(outcomes[0] as { id: string }).id],
              )
            ).rows[0].count,
            1,
          );
          const actionContext = { idempotencyKey: newId() },
            actionInput = {
              operationId: "changePassword",
              type: "change_password",
              input: {
                currentPassword: password,
                newPassword: "Replay private password 2026",
              },
            };
          const actions = await Promise.all([
            execute("beginAccountAction", actor, actionInput, actionContext),
            execute("beginAccountAction", actor, actionInput, actionContext),
          ]);
          assert.deepEqual(actions[0], actions[1]);
          AccountActionSchema.parse(actions[0]);
          const privateReceipts = (
            await owner.query(
              "SELECT input_digest,outcome FROM rootset_control.control_mutation_replays WHERE operation_id='beginAccountAction'",
            )
          ).rows;
          assert.equal(
            JSON.stringify(privateReceipts).includes(
              actionInput.input.currentPassword,
            ),
            false,
          );
          assert.equal(
            JSON.stringify(privateReceipts).includes(
              actionInput.input.newPassword,
            ),
            false,
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM rootset_control.account_actions WHERE id=$1",
                [(actions[0] as { id: string }).id],
              )
            ).rows[0].count,
            1,
          );
          const anotherSession = await login(service, email, password);
          assert.ok(anotherSession.response.ok);
          const sessionActor = (await service.resolveActor(
            request("/get-session", undefined, anotherSession.cookie),
            "browser",
          ))!;
          const currentInput = {
              ...invitation,
              email: "revoked-replay@example.test",
            },
            currentContext = { idempotencyKey: newId() };
          await execute(
            "inviteMember",
            sessionActor,
            currentInput,
            currentContext,
          );
          await execute("revokeSession", actor, { id: sessionActor.id });
          await assert.rejects(() =>
            execute("inviteMember", sessionActor, currentInput, currentContext),
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM rootset_control.invitations WHERE email=$1",
                [currentInput.email],
              )
            ).rows[0].count,
            1,
          );
          let queued = 0;
          await service.withOperationApproval(
            actor,
            "restoreBackup",
            { mode: "new" },
            { idempotencyKey: newId() },
            async () => {
              queued++;
              return {};
            },
          );
          assert.equal(queued, 1);
          await assert.rejects(() =>
            service.withOperationApproval(
              {
                ...actor,
                kind: "oauth",
                id: newId(),
                credentialId: newId(),
                clientId: "missing-grant",
              },
              "restoreBackup",
              { mode: "replace" },
              {},
              async () => ({}),
            ),
          );
        },
      );
      await t.test(
        "ACC API09 preference, organisation and invitation handlers persist validated output and replay without another audit",
        async () => {
          const checked = async <T>(
            operation: string,
            value: Record<string, unknown> = {},
            context: Parameters<IdentityService["execute"]>[3] = {},
          ) =>
            operationMap[operation]!.outputSchema.parse(
              await execute(operation, actor, value, context),
            ) as T;
          const preferences = await checked<{
            timezone: string;
            theme: string;
            locale: string;
            dateFormat: string;
            timeFormat: string;
          }>("getPreferences");
          assert.equal(preferences.timezone, "UTC");
          const context = { idempotencyKey: newId() };
          const updated = await checked<typeof preferences>(
            "updatePreferences",
            { timezone: "Asia/Kolkata", theme: "dark" },
            context,
          );
          assert.equal(updated.timezone, "Asia/Kolkata");
          assert.equal(updated.theme, "dark");
          assert.deepEqual(
            await checked(
              "updatePreferences",
              { theme: "dark", timezone: "Asia/Kolkata" },
              context,
            ),
            updated,
          );
          assert.deepEqual(await checked("getPreferences"), updated);
          const options = await checked<{
            timezones: string[];
            themes: string[];
          }>("getPreferenceOptions");
          assert.ok(options.timezones.includes(updated.timezone));
          assert.ok(options.themes.includes(updated.theme));
          const preview = await checked<{
            utc: string;
            timezone: string;
            displayed: string;
          }>("previewPreferences", {
            preferences: updated,
            value: "2026-01-01T00:00:00.000Z",
          });
          assert.equal(preview.utc, "2026-01-01T00:00:00.000Z");
          assert.equal(preview.timezone, updated.timezone);
          assert.ok(preview.displayed.includes("5:30"));
          await assert.rejects(() =>
            checked("updatePreferences", { timezone: "Imaginary/Zone" }),
          );
          const organisations = await checked<{ data: Array<{ id: string }> }>(
            "listOrganisations",
          );
          assert.ok(organisations.data.some((item) => item.id === orgId));
          const organisation = await checked<{
            id: string;
            name: string;
            description: string;
          }>("getOrganisation", { orgId });
          assert.equal(organisation.id, orgId);
          const organisationContext = { idempotencyKey: newId() };
          const renamed = await checked<typeof organisation>(
            "updateOrganisation",
            {
              orgId,
              name: organisation.name,
              description: "Account handler verification",
            },
            organisationContext,
          );
          assert.equal(renamed.description, "Account handler verification");
          assert.deepEqual(
            await checked(
              "updateOrganisation",
              { orgId, description: renamed.description, name: renamed.name },
              organisationContext,
            ),
            renamed,
          );
          const cleared = await checked<typeof organisation>(
            "updateOrganisation",
            { orgId, name: organisation.name, description: null },
          );
          assert.equal(cleared.description, "");
          await assert.rejects(() =>
            checked("getOrganisation", { orgId: newId() }),
          );
          const invite = await checked<{ id: string }>("inviteMember", {
            orgId,
            email: "cancelled-handler@example.test",
            role: "viewer",
          });
          const cancelContext = { idempotencyKey: newId() };
          assert.deepEqual(
            await checked(
              "cancelInvitation",
              { orgId, id: invite.id },
              cancelContext,
            ),
            { deleted: true },
          );
          assert.deepEqual(
            await checked(
              "cancelInvitation",
              { orgId, id: invite.id },
              cancelContext,
            ),
            { deleted: true },
          );
          assert.equal(
            (
              await owner.query(
                "SELECT state FROM rootset_control.invitations WHERE id=$1",
                [invite.id],
              )
            ).rows[0].state,
            "cancelled",
          );
          assert.equal(
            (
              await owner.query(
                "SELECT count(*)::int AS count FROM rootset_control.account_audit WHERE operation='cancelInvitation' AND target_id=$1",
                [invite.id],
              )
            ).rows[0].count,
            1,
          );
          const grants = await checked<{
            data: Array<{ membershipId: string; unrestricted: boolean }>;
          }>("getGrants", { orgId });
          const membership = (
            await owner.query(
              "SELECT id FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
              [orgId, actor.userId],
            )
          ).rows[0];
          assert.ok(
            grants.data.some(
              (item) =>
                item.membershipId === membership.id && item.unrestricted,
            ),
          );
          const audit = await checked<{
            data: Array<{ operationId: string; actorId: string }>;
          }>("queryOrganisationAudit", {
            orgId,
            operationId: "cancelInvitation",
            actorId: actor.id,
          });
          assert.equal(audit.data.length, 1);
          assert.equal(audit.data[0]!.operationId, "cancelInvitation");
          assert.equal(audit.data[0]!.actorId, actor.id);
          await checked("updatePreferences", preferences);
        },
      );
      await t.test(
        "AUTH KEY-04 own sessions/connections and approved key rotations enforce ownership, revocation and one-time disclosure",
        async () => {
          const checked = async <T>(
            operation: string,
            value: Record<string, unknown> = {},
            context: Parameters<IdentityService["execute"]>[3] = {},
          ) =>
            operationMap[operation]!.outputSchema.parse(
              await execute(operation, actor, value, context),
            ) as T;
          const sessions = await checked<{
            data: Array<{ id: string; current: boolean }>;
          }>("listSessions");
          assert.ok(
            sessions.data.some((item) => item.id === actor.id && item.current),
          );
          const ownGrant = newId(),
            otherGrant = newId(),
            otherUser = newId();
          await owner.query(
            "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Other connection owner','other-connection@example.test',true)",
            [otherUser],
          );
          await owner.query(
            "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'viewer')",
            [newId(), orgId, otherUser],
          );
          for (const [id, userId] of [
            [ownGrant, actor.userId!],
            [otherGrant, otherUser],
          ])
            await owner.query(
              "INSERT INTO rootset_control.oauth_grants(id,client_id,user_id,org_id,resource,scopes,targets,actor) VALUES($1,'connection-handler',$2,$3,$4,ARRAY['org:read'],'[]',$5)",
              [
                id,
                userId,
                orgId,
                `${baseURL}/mcp`,
                JSON.stringify({ ...actor, userId }),
              ],
            );
          const connections = await checked<{
            data: Array<{ id: string; revokedAt: string | null }>;
          }>("listConnections");
          assert.ok(
            connections.data.some(
              (item) => item.id === ownGrant && !item.revokedAt,
            ),
          );
          assert.equal(
            connections.data.some((item) => item.id === otherGrant),
            false,
          );
          await assert.rejects(() =>
            checked("revokeConnection", { id: otherGrant }),
          );
          const revokeContext = { idempotencyKey: newId() };
          assert.deepEqual(
            await checked("revokeConnection", { id: ownGrant }, revokeContext),
            { deleted: true },
          );
          assert.deepEqual(
            await checked("revokeConnection", { id: ownGrant }, revokeContext),
            { deleted: true },
          );
          assert.ok(
            (await checked<typeof connections>("listConnections")).data.find(
              (item) => item.id === ownGrant,
            )?.revokedAt,
          );
          await assert.rejects(() =>
            service.refreshActor({
              ...actor,
              kind: "oauth",
              id: ownGrant,
              credentialId: ownGrant,
              clientId: "connection-handler",
            }),
          );
          const personal = KeyCreatedSchema.parse(
            await checked("createPersonalKey", {
              orgId,
              name: "Rotation handler personal",
              scopes: ["org:read"],
              targets: [],
              unrestricted: true,
            }),
          );
          const rotateContext = { idempotencyKey: newId() };
          const rotated = KeyCreatedSchema.parse(
            await checked(
              "rotatePersonalKey",
              { id: personal.key.id, overlapSeconds: 0 },
              rotateContext,
            ),
          );
          assert.ok(rotated.secret);
          assert.notEqual(rotated.key.id, personal.key.id);
          const personalReplay = KeyCreatedSchema.parse(
            await checked(
              "rotatePersonalKey",
              { id: personal.key.id, overlapSeconds: 0 },
              rotateContext,
            ),
          );
          assert.equal(personalReplay.secret, undefined);
          assert.equal(personalReplay.key.id, rotated.key.id);
          assert.equal(
            await service.resolveActor(
              new Request(`${baseURL}/v1/me`, {
                headers: { authorization: `Bearer ${personal.secret}` },
              }),
              "api",
            ),
            null,
          );
          assert.ok(
            await service.resolveActor(
              new Request(`${baseURL}/v1/me`, {
                headers: { authorization: `Bearer ${rotated.secret}` },
              }),
              "api",
            ),
          );
          const personalKeys = await checked<{ data: Array<{ id: string }> }>(
            "listPersonalKeys",
          );
          assert.ok(
            personalKeys.data.some((item) => item.id === rotated.key.id),
          );
          const team = KeyCreatedSchema.parse(
            await checked("createTeamKey", {
              orgId,
              name: "Rotation handler team",
              scopes: ["org:read"],
              targets: [],
              unrestricted: true,
            }),
          );
          const action = AccountActionSchema.parse(
            await checked("beginAccountAction", {
              orgId,
              type: "rotate_key",
              operationId: "rotateTeamKey",
              input: { orgId, id: team.key.id, overlapSeconds: 0 },
            }),
          );
          assert.equal(
            AccountActionSchema.parse(
              await checked("getAccountAction", { id: action.id }),
            ).state,
            "pending",
          );
          await service.approveAction(action.id, actor);
          const completed = AccountActionSchema.parse(
            await checked("completeAccountAction", { id: action.id }),
          );
          const rotatedTeam = KeyCreatedSchema.parse(completed.result);
          assert.ok(rotatedTeam.secret);
          const consumed = AccountActionSchema.parse(
            await checked("getAccountAction", { id: action.id }),
          );
          assert.equal(consumed.state, "consumed");
          assert.equal(
            KeyCreatedSchema.parse(consumed.result).secret,
            undefined,
          );
          const teamKeys = await checked<{ data: Array<{ id: string }> }>(
            "listTeamKeys",
            { orgId },
          );
          assert.ok(
            teamKeys.data.some((item) => item.id === rotatedTeam.key.id),
          );
          assert.equal(
            await service.resolveActor(
              new Request(`${baseURL}/v1/me`, {
                headers: { authorization: `Bearer ${team.secret}` },
              }),
              "api",
            ),
            null,
          );
          const teamActor = (await service.resolveActor(
            new Request(`${baseURL}/v1/me`, {
              headers: { authorization: `Bearer ${rotatedTeam.secret}` },
            }),
            "api",
          ))!;
          assert.ok(teamActor);
          await assert.rejects(() => execute("listConnections", teamActor, {}));
          await assert.rejects(() =>
            execute("listPersonalKeys", teamActor, {}),
          );
          await assert.rejects(() =>
            execute("getAccountAction", teamActor, { id: action.id }),
          );
          const security = await checked<{
            twoFactorEnabled: boolean;
            passkeys: unknown[];
          }>("getSecurityStatus");
          assert.equal(security.twoFactorEnabled, false);
          assert.deepEqual(security.passkeys, []);
          await assert.rejects(() =>
            checked("listTeamKeys", { orgId: newId() }),
          );
          await checked("revokePersonalKey", { id: rotated.key.id });
          await checked("revokeTeamKey", { orgId, id: rotatedTeam.key.id });
          await owner.query(
            "DELETE FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
            [orgId, otherUser],
          );
        },
      );
      await t.test(
        "KEY-01 KEY-06 key secrets display once with safe metadata idempotency",
        async () => {
          const input = {
            orgId,
            name: "Read integration",
            scopes: ["org:read", "rows:read"],
            targets: [],
            unrestricted: true,
          };
          const context = { idempotencyKey: newId() };
          const created = KeyCreatedSchema.parse(
            await execute("createPersonalKey", actor, input, context),
          );
          assert.ok(created.secret);
          assert.equal(created.secret!.slice(31).length, 43);
          const stored = (
            await owner.query(
              `SELECT secret_hash FROM rootset_control.api_keys WHERE id=$1`,
              [created.key.id],
            )
          ).rows[0];
          assert.notEqual(stored.secret_hash, created.secret);
          const replay = KeyCreatedSchema.parse(
            await execute("createPersonalKey", actor, input, context),
          );
          assert.equal(replay.secret, undefined);
          assert.equal(replay.key.id, created.key.id);
          await assert.rejects(
            () =>
              execute(
                "createPersonalKey",
                actor,
                { ...input, name: "Changed input" },
                context,
              ),
            (error) =>
              (error as { code: string }).code === "IDEMPOTENCY_CONFLICT",
          );
          const keyActor = await service.resolveActor(
            new Request(`${baseURL}/v1/me`, {
              headers: { authorization: `Bearer ${created.secret}` },
            }),
            "api",
          );
          assert.ok(keyActor);
          assert.equal(keyActor!.kind, "personal_key");
          assert.deepEqual(
            await service.withOperationApproval(
              keyActor!,
              "restoreBackup",
              { mode: "new" },
              { idempotencyKey: newId() },
              async () => ({ admitted: true }),
            ),
            { admitted: true },
          );
          await assert.rejects(
            () =>
              service.withOperationApproval(
                keyActor!,
                "restoreBackup",
                { mode: "replace" },
                { idempotencyKey: newId() },
                async () => ({ admitted: true }),
              ),
            (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
          );
          await execute("revokePersonalKey", actor, {
            id: created.key.id,
          });
          assert.equal(
            await service.resolveActor(
              new Request(`${baseURL}/v1/me`, {
                headers: { authorization: `Bearer ${created.secret}` },
              }),
              "api",
            ),
            null,
          );
        },
      );
      await t.test(
        "AUTH-07 action is immutable, client-bound, one-use and replay metadata only",
        async () => {
          const input = {
            name: "Approved key",
            scopes: ["org:read"],
            targets: [],
          };
          const begun = AccountActionSchema.parse(
            await execute("beginAccountAction", actor, {
              type: "create_key",
              operationId: "createPersonalKey",
              input,
            }),
          );
          assert.equal(begun.state, "pending");
          await assert.rejects(() =>
            execute("completeAccountAction", actor, { id: begun.id }),
          );
          AccountActionSchema.parse(
            await service.approveAction(begun.id, actor),
          );
          await assert.rejects(() =>
            execute(
              "createPersonalKey",
              actor,
              { ...input, name: "Tampered" },
              { idempotencyKey: newId(), actionId: begun.id },
            ),
          );
          const completed = AccountActionSchema.parse(
            await execute("completeAccountAction", actor, {
              id: begun.id,
            }),
          );
          assert.equal(completed.state, "consumed");
          assert.ok((completed.result as { secret?: string }).secret);
          const replay = AccountActionSchema.parse(
            await execute("completeAccountAction", actor, {
              id: begun.id,
            }),
          );
          assert.equal(
            (replay.result as { secret?: string }).secret,
            undefined,
          );
          const db = (
            await owner.query(
              `SELECT payload_encrypted FROM rootset_control.account_actions WHERE id=$1`,
              [begun.id],
            )
          ).rows[0];
          assert.equal(db.payload_encrypted.includes("Approved key"), false);
        },
      );
      await t.test(
        "AUTH-07 scoped actors cannot borrow browser authority; external approval locks and commits once",
        async () => {
          const read = KeyCreatedSchema.parse(
            await execute(
              "createPersonalKey",
              actor,
              {
                name: "Rows only",
                scopes: ["rows:read"],
                targets: [],
                unrestricted: true,
              },
              { idempotencyKey: newId() },
            ),
          );
          const limited = (await service.resolveActor(
            new Request(`${baseURL}/v1/me`, {
              headers: { authorization: `Bearer ${read.secret}` },
            }),
            "api",
          ))!;
          const limitedContext = ContextSchema.parse(
            await execute("getContext", limited, {}),
          );
          assert.equal(limitedContext.profile, null);
          assert.equal(limitedContext.preferences, null);
          await assert.rejects(
            () =>
              execute("beginAccountAction", limited, {
                operationId: "createTeamKey",
                input: {
                  name: "Privilege escalation",
                  scopes: ["keys:manage"],
                  targets: [],
                },
              }),
            (error) =>
              (error as { code: string }).code === "INSUFFICIENT_SCOPE",
          );
          const delegated = KeyCreatedSchema.parse(
            await execute(
              "createPersonalKey",
              actor,
              {
                name: "Approved backup manager",
                scopes: ["backups:manage"],
                targets: [],
                unrestricted: true,
              },
              { idempotencyKey: newId() },
            ),
          );
          const initiator = (await service.resolveActor(
            new Request(`${baseURL}/v1/me`, {
              headers: { authorization: `Bearer ${delegated.secret}` },
            }),
            "api",
          ))!;
          const input = {
            orgId,
            databaseId: newId(),
            enabled: false,
            cron: "0 0 * * *",
            timezone: "UTC",
            destination: "installation",
            retentionDays: 30,
            retentionCount: 10,
            encryption: true,
            maxRuntimeSeconds: 3600,
            notifications: true,
          };
          const action = AccountActionSchema.parse(
            await execute("beginAccountAction", initiator, {
              operationId: "setBackupPolicy",
              input,
            }),
          );
          await service.approveAction(action.id, actor);
          await assert.rejects(
            () =>
              service.withOperationApproval(
                { ...initiator, clientId: "another-client" },
                "setBackupPolicy",
                input,
                { actionId: action.id, idempotencyKey: newId() },
                async () => ({ changed: true }),
              ),
            (error) => (error as { code: string }).code === "STEP_UP_REQUIRED",
          );
          await assert.rejects(() =>
            service.withOperationApproval(
              initiator,
              "setBackupPolicy",
              input,
              { actionId: action.id, idempotencyKey: newId() },
              async (client) => {
                await client.query(
                  `UPDATE rootset_control.organisations SET description='Rolled back approval' WHERE id=$1`,
                  [orgId],
                );
                throw new Error("Transaction rollback probe");
              },
            ),
          );
          assert.equal(
            (
              await owner.query(
                `SELECT description FROM rootset_control.organisations WHERE id=$1`,
                [orgId],
              )
            ).rows[0].description,
            "",
          );
          assert.equal(
            (
              await owner.query(
                `SELECT consumed_at FROM rootset_control.account_actions WHERE id=$1`,
                [action.id],
              )
            ).rows[0].consumed_at,
            null,
          );
          let writes = 0;
          const attempts = await Promise.allSettled(
            [1, 2].map(() =>
              service.withOperationApproval(
                initiator,
                "setBackupPolicy",
                input,
                { actionId: action.id, idempotencyKey: newId() },
                async (client) => {
                  writes++;
                  await client.query(
                    `UPDATE rootset_control.organisations SET description='Committed approval' WHERE id=$1`,
                    [orgId],
                  );
                  return {
                    changed: true,
                    nested: { secret: "Write-only test secret" },
                  };
                },
              ),
            ),
          );
          assert.equal(
            attempts.filter((r) => r.status === "fulfilled").length,
            1,
            JSON.stringify(
              attempts.map((r) =>
                r.status === "rejected"
                  ? {
                      code: (r.reason as { code?: string }).code,
                      message: (r.reason as Error).message,
                    }
                  : { ok: true },
              ),
            ),
          );
          assert.equal(writes, 1);
          const concurrentAction = AccountActionSchema.parse(
            await execute("beginAccountAction", initiator, {
              operationId: "setBackupPolicy",
              input,
            }),
          );
          await service.approveAction(concurrentAction.id, actor);
          const sameContext = {
            actionId: concurrentAction.id,
            idempotencyKey: newId(),
          };
          let concurrentWrites = 0;
          const matching = await Promise.all(
            [1, 2].map(() =>
              service.withOperationApproval(
                initiator,
                "setBackupPolicy",
                input,
                sameContext,
                async (client) => {
                  concurrentWrites++;
                  await client.query(
                    "UPDATE rootset_control.organisations SET description='Committed approval' WHERE id=$1",
                    [orgId],
                  );
                  await new Promise((resolve) => setTimeout(resolve, 30));
                  return { changed: true };
                },
              ),
            ),
          );
          assert.equal(concurrentWrites, 1);
          assert.deepEqual(matching, [{ changed: true }, { changed: true }]);
          await assert.rejects(
            () =>
              service.withOperationApproval(
                initiator,
                "setBackupPolicy",
                { ...input, cron: "15 0 * * *" },
                sameContext,
                async () => ({}),
              ),
            (error) =>
              (error as { code: string }).code === "IDEMPOTENCY_CONFLICT",
          );
          const persisted = (
            await owner.query(
              `SELECT result FROM rootset_control.account_actions WHERE id=$1`,
              [action.id],
            )
          ).rows[0].result;
          assert.equal(
            JSON.stringify(persisted).includes("Write-only test secret"),
            false,
          );
          assert.deepEqual(persisted, { changed: true, nested: {} });
          const replay = AccountActionSchema.parse(
            await execute("completeAccountAction", initiator, {
              id: action.id,
            }),
          );
          assert.equal(replay.state, "consumed");
          assert.equal(
            JSON.stringify(replay).includes("Write-only test secret"),
            false,
          );
          await execute("revokePersonalKey", actor, {
            id: delegated.key.id,
          });
          await execute("revokePersonalKey", actor, {
            id: read.key.id,
          });
        },
      );
      let viewerActor: Actor;
      let viewerCookie = "";
      let viewerUserId = "";
      await t.test(
        "ACC-06 invitations enforce verified email, role and one-use membership",
        async () => {
          const email = "viewer@example.test";
          const invite = (await execute("inviteMember", actor, {
            orgId,
            email,
            role: "viewer",
          })) as { id: string };
          assert.ok(invite.id);
          const outbox = (
            await owner.query(
              `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='invitation' ORDER BY created_at DESC LIMIT 1`,
              [email],
            )
          ).rows[0];
          const payload = decryptProtected<EmailPayload>(
            outbox.payload_encrypted,
            config,
          );
          const token = new URL(payload.actionUrl!).pathname.split("/").at(-1)!;
          const signup = await service.auth.handler(
            request("/invitations/accept", { token, name: "Viewer", password }),
          );
          assert.equal(signup.status, 202);
          await latestVerification(service, pool, email);
          const session = await login(service, email, password);
          assert.ok(session.response.ok);
          viewerCookie = session.cookie;
          const accepted = await service.auth.handler(
            request("/invitations/accept", { token }, viewerCookie),
          );
          assert.ok(accepted.ok);
          const replay = await service.auth.handler(
            request("/invitations/accept", { token }, viewerCookie),
          );
          assert.ok(replay.ok);
          viewerActor = (await service.resolveActor(
            request("/get-session", undefined, viewerCookie),
            "browser",
          ))!;
          assert.equal(viewerActor.role, "viewer");
          viewerUserId = viewerActor.userId!;
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.memberships WHERE user_id=$1 AND org_id=$2`,
                [viewerUserId, orgId],
              )
            ).rows[0].count,
            "1",
          );
          await assert.rejects(() =>
            execute("inviteMember", viewerActor, {
              orgId,
              email: "another@example.test",
              role: "admin",
            }),
          );
          await assert.rejects(() =>
            execute("inviteMember", actor, {
              orgId,
              email: "owner-escalation@example.test",
              role: "owner",
            }),
          );
          const wrong = await service.auth.handler(
            request("/invitations/accept", { token }, cookie),
          );
          assert.equal(wrong.status, 403);
        },
      );
      await t.test(
        "ACC-02 multi-organisation selection uses current persisted session and rejects foreign choices",
        async () => {
          const second = newId();
          await owner.query(
            `INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Session switch fixture')`,
            [second],
          );
          await owner.query(
            `INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,'owner')`,
            [newId(), second, actor.userId],
          );
          const list = await service.auth.handler(
            request("/organisations", undefined, cookie),
          );
          assert.ok(list.ok);
          assert.equal(
            ((await list.json()) as { data: unknown[] }).data.length,
            2,
          );
          const select = await service.auth.handler(
            request("/organisation", { orgId: second }, cookie),
          );
          assert.ok(select.ok);
          assert.equal(
            (await service.resolveActor(
              request("/get-session", undefined, cookie),
              "browser",
            ))!.orgId,
            second,
          );
          const foreign = await service.auth.handler(
            request("/organisation", { orgId: newId() }, cookie),
          );
          assert.equal(foreign.status, 404);
          assert.equal(
            (await service.resolveActor(
              request("/get-session", undefined, cookie),
              "browser",
            ))!.orgId,
            second,
          );
          await service.auth.handler(
            request("/organisation", { orgId }, cookie),
          );
          assert.equal(
            (await service.resolveActor(
              request("/get-session", undefined, cookie),
              "browser",
            ))!.orgId,
            orgId,
          );
          await owner.query(
            `DELETE FROM rootset_control.memberships WHERE org_id=$1`,
            [second],
          );
          await owner.query(
            `DELETE FROM rootset_control.organisations WHERE id=$1`,
            [second],
          );
        },
      );
      await t.test(
        "ACC-09 persistent per-user view preferences validate current resource access and fields",
        async () => {
          const databaseId = newId(),
            tableId = newId(),
            fieldId = newId();
          await owner.query(
            `INSERT INTO rootset_control.databases(id,org_id,name,schema_name) VALUES($1,$2,'View preferences fixture',$3)`,
            [databaseId, orgId, `rsd_${databaseId.toLowerCase()}`],
          );
          await owner.query(
            `INSERT INTO rootset_control.tables(id,database_id,org_id,name,physical_name) VALUES($1,$2,$3,'Preference table',$4)`,
            [tableId, databaseId, orgId, `rst_${tableId.toLowerCase()}`],
          );
          await owner.query(
            `INSERT INTO rootset_control.fields(id,table_id,org_id,api_key,label,definition,position) VALUES($1,$2,$3,'Name','Name',$4,0)`,
            [
              fieldId,
              tableId,
              orgId,
              JSON.stringify({
                id: fieldId,
                apiKey: "Name",
                label: "Name",
                type: "text",
                required: false,
                charLimit: 255,
              }),
            ],
          );
          const original = ViewPreferencesResultSchema.parse(
            await execute("getViewPreferences", viewerActor, {
              tableId,
            }),
          );
          assert.deepEqual(original.preferences.columnOrder, []);
          const preferences = {
            columnOrder: [fieldId],
            columnWidths: { [fieldId]: 220 },
            hiddenColumns: [],
            frozenColumns: 1,
          };
          ViewPreferencesResultSchema.parse(
            await execute("updateViewPreferences", viewerActor, {
              tableId,
              preferences,
            }),
          );
          assert.deepEqual(
            ViewPreferencesResultSchema.parse(
              await execute("getViewPreferences", viewerActor, {
                tableId,
              }),
            ).preferences,
            preferences,
          );
          assert.deepEqual(
            ViewPreferencesResultSchema.parse(
              await execute("getViewPreferences", actor, { tableId }),
            ).preferences.columnOrder,
            [],
          );
          await assert.rejects(() =>
            execute("updateViewPreferences", viewerActor, {
              tableId,
              preferences: { ...preferences, hiddenColumns: [newId()] },
            }),
          );
          const member = (
            await owner.query(
              `SELECT id,version FROM rootset_control.memberships WHERE user_id=$1 AND org_id=$2`,
              [viewerUserId, orgId],
            )
          ).rows[0];
          await execute("updateGrants", actor, {
            orgId,
            grants: [
              {
                membershipId: member.id,
                unrestricted: false,
                targets: [],
                version: Number(member.version),
              },
            ],
          });
          await assert.rejects(
            () => execute("getViewPreferences", viewerActor, { tableId }),
            (error) =>
              (error as { code: string }).code === "RESOURCE_NOT_FOUND",
          );
          const current = (
            await owner.query(
              `SELECT version FROM rootset_control.memberships WHERE id=$1`,
              [member.id],
            )
          ).rows[0];
          await execute("updateGrants", actor, {
            orgId,
            grants: [
              {
                membershipId: member.id,
                unrestricted: true,
                targets: [],
                version: Number(current.version),
              },
            ],
          });
          const targetKey = KeyCreatedSchema.parse(
            await execute(
              "createPersonalKey",
              actor,
              {
                orgId,
                name: "Narrow credential delegator",
                scopes: ["keys:manage", "rows:read"],
                targets: [{ databaseId, tableId, level: "read" }],
                unrestricted: false,
              },
              { idempotencyKey: newId() },
            ),
          );
          const credential = (await service.resolveActor(
            new Request(`${baseURL}/v1/me`, {
              headers: { authorization: `Bearer ${targetKey.secret}` },
            }),
            "api",
          ))!;
          await assert.rejects(
            () =>
              execute(
                "createPersonalKey",
                credential,
                {
                  orgId,
                  name: "Organisation wildcard attempt",
                  scopes: ["rows:read"],
                  targets: [{ level: "read" }],
                },
                { idempotencyKey: newId() },
              ),
            (error) =>
              (error as { code: string }).code ===
              "DELEGATION_EXCEEDS_AUTHORITY",
          );
          await assert.rejects(
            () =>
              execute(
                "createPersonalKey",
                actor,
                {
                  name: "Foreign target",
                  scopes: ["rows:read"],
                  targets: [{ databaseId: newId(), level: "read" }],
                },
                { idempotencyKey: newId() },
              ),
            (error) =>
              (error as { code: string }).code === "RESOURCE_NOT_FOUND",
          );
        },
      );
      await t.test(
        "ACC-08 verified email change handles uniqueness, one-use tokens, and session revocation",
        async () => {
          const name = "N".repeat(255);
          assert.equal(
            ProfileSchema.parse(await execute("updateProfile", actor, { name }))
              .name,
            name,
          );
          await execute("changeEmail", actor, {
            newEmail: "viewer@example.test",
          });
          let change = (
            await owner.query(
              `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template='email-change-verification' ORDER BY created_at DESC LIMIT 1`,
            )
          ).rows[0];
          let payload = decryptProtected<EmailPayload>(
            change.payload_encrypted,
            config,
          );
          const conflict = await service.auth.handler(
            request(
              "/email-change/confirm",
              { token: new URL(payload.actionUrl!).searchParams.get("token") },
              cookie,
            ),
          );
          assert.equal(conflict.status, 409);
          assert.equal(
            ProfileSchema.parse(await execute("getProfile", actor, {})).email,
            email,
          );
          const nextEmail = "verified-owner@example.test";
          await execute("changeEmail", actor, { newEmail: nextEmail });
          change = (
            await owner.query(
              `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template='email-change-verification' ORDER BY created_at DESC LIMIT 1`,
            )
          ).rows[0];
          payload = decryptProtected<EmailPayload>(
            change.payload_encrypted,
            config,
          );
          const token = new URL(payload.actionUrl!).searchParams.get("token");
          const confirmed = await service.auth.handler(
            request("/email-change/confirm", { token }, cookie),
          );
          assert.ok(confirmed.ok);
          await assert.rejects(
            () => service.refreshActor(actor),
            (error) => (error as { code: string }).code === "UNAUTHENTICATED",
          );
          const replay = await service.auth.handler(
            request("/email-change/confirm", { token }),
          );
          assert.equal(replay.status, 410);
          email = nextEmail;
          const session = await login(service, email, password);
          assert.ok(session.response.ok);
          cookie = session.cookie;
          actor = (await service.resolveActor(
            request("/get-session", undefined, cookie),
            "browser",
          ))!;
          assert.equal(
            ProfileSchema.parse(await execute("getProfile", actor, {})).email,
            email,
          );
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.email_outbox WHERE template='email-changed'`,
              )
            ).rows[0].count,
            "2",
          );
        },
      );
      await t.test(
        "ACC-03 metadata pages enforce cursor request and principal binding",
        async () => {
          const first = (await execute("listMembers", actor, {
            orgId,
            limit: 1,
          })) as {
            data: Array<{ id: string }>;
            hasMore: boolean;
            nextCursor: string;
          };
          assert.equal(first.data.length, 1);
          assert.equal(first.hasMore, true);
          assert.ok(first.nextCursor);
          const second = (await execute("listMembers", actor, {
            orgId,
            limit: 1,
            cursor: first.nextCursor,
          })) as { data: Array<{ id: string }>; hasMore: boolean };
          assert.equal(second.data.length, 1);
          assert.equal(second.hasMore, false);
          assert.notEqual(first.data[0]!.id, second.data[0]!.id);
          await assert.rejects(
            () =>
              execute("listMembers", actor, {
                orgId,
                limit: 2,
                cursor: first.nextCursor,
              }),
            (error) => (error as { code: string }).code === "CURSOR_INVALID",
          );
          await assert.rejects(
            () =>
              execute("listInvitations", actor, {
                orgId,
                limit: 1,
                cursor: first.nextCursor,
              }),
            (error) => (error as { code: string }).code === "CURSOR_INVALID",
          );
          const key = KeyCreatedSchema.parse(
            await execute(
              "createPersonalKey",
              actor,
              {
                name: "Metadata actor",
                scopes: ["members:read"],
                targets: [],
                unrestricted: true,
              },
              { idempotencyKey: newId() },
            ),
          );
          const principal = (await service.resolveActor(
            new Request(`${baseURL}/v1/me`, {
              headers: { authorization: `Bearer ${key.secret}` },
            }),
            "api",
          ))!;
          await assert.rejects(
            () =>
              execute("listMembers", principal, {
                orgId,
                limit: 1,
                cursor: first.nextCursor,
              }),
            (error) => (error as { code: string }).code === "CURSOR_INVALID",
          );
        },
      );
      await t.test(
        "ACC-05 last verified Owner cannot be demoted or removed",
        async () => {
          await assert.rejects(
            () =>
              service.finishDeletion(
                actor,
                "account",
                { confirmation: "DELETE" },
                { surface: "worker" },
              ),
            (error) => (error as { code: string }).code === "LAST_OWNER",
          );
          const member = (
            await owner.query(
              `SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2`,
              [orgId, actor.userId],
            )
          ).rows[0];
          const attempts = await Promise.allSettled([
            execute("updateMember", actor, {
              orgId,
              id: member.id,
              role: "viewer",
              expectedVersion: String(member.version),
            }),
            execute("removeMember", actor, {
              orgId,
              id: member.id,
              expectedVersion: String(member.version),
            }),
          ]);
          assert.equal(
            attempts.every((r) => r.status === "rejected"),
            true,
          );
          assert.equal(
            (
              await owner.query(
                `SELECT role FROM rootset_control.memberships WHERE id=$1`,
                [member.id],
              )
            ).rows[0].role,
            "owner",
          );
        },
      );
      await t.test(
        "AUTH-08 scheduled policy authority outlives logout while manual session authority is revoked",
        async () => {
          const session = await login(service, email, password);
          assert.ok(session.response.ok);
          const principal = (await service.resolveActor(
            request("/get-session", undefined, session.cookie),
            "browser",
          ))!;
          await execute("revokeSession", actor, { id: principal.id });
          await assert.rejects(
            () => service.refreshActor(principal),
            (error) => (error as { code: string }).code === "UNAUTHENTICATED",
          );
          const policyActor = await service.refreshPolicyActor(principal);
          assert.equal(policyActor.userId, actor.userId);
          assert.equal(policyActor.role, "owner");
          assert.ok(policyActor.scopes.includes("backups:manage"));
        },
      );
      await t.test(
        "AUTH-03 AUTH-04 TOTP confirms enrollment and recovery code races are single-use",
        async () => {
          const action = AccountActionSchema.parse(
            await execute("beginAccountAction", actor, {
              type: "enable_totp",
              operationId: "enableTwoFactor",
              input: {},
              orgId,
            }),
          );
          assert.equal(action.state, "pending");
          assert.equal(action.type, "enable_totp");
          const enable = await service.auth.handler(
            request("/two-factor/enable", { password }, cookie),
          );
          assert.ok(enable.ok);
          const data = (await enable.json()) as {
            totpURI: string;
            backupCodes: string[];
          };
          assert.ok(data.totpURI);
          assert.ok(data.backupCodes.length);
          assert.equal(
            (
              await owner.query(
                `SELECT two_factor_enabled FROM rootset_control.users WHERE id=$1`,
                [actor.userId],
              )
            ).rows[0].two_factor_enabled,
            false,
          );
          const code = totp(new URL(data.totpURI).searchParams.get("secret")!);
          const confirm = await service.auth.handler(
            request("/two-factor/verify-totp", { code }, cookie),
          );
          assert.ok(confirm.ok);
          const reused = await service.auth.handler(
            request("/two-factor/verify-totp", { code }, cookie),
          );
          assert.equal(reused.ok, false);
          const factor = (
            await owner.query(
              `SELECT backup_codes FROM rootset_control.auth_two_factors WHERE user_id=$1`,
              [actor.userId],
            )
          ).rows[0];
          assert.equal(
            factor.backup_codes.includes(data.backupCodes[0]),
            false,
          );
          assert.ok(factor.backup_codes.includes("hmac:"));
          const [a, b] = await Promise.all([
            login(service, email, password),
            login(service, email, password),
          ]);
          assert.equal(a.body.twoFactorRedirect, true);
          assert.equal(b.body.twoFactorRedirect, true);
          assert.equal(
            await service.resolveActor(
              request("/get-session", undefined, a.cookie),
              "browser",
            ),
            null,
          );
          const results = await Promise.all([
            service.auth.handler(
              request(
                "/two-factor/verify-backup-code",
                { code: data.backupCodes[0] },
                a.cookie,
              ),
            ),
            service.auth.handler(
              request(
                "/two-factor/verify-backup-code",
                { code: data.backupCodes[0] },
                b.cookie,
              ),
            ),
          ]);
          assert.equal(results.filter((r) => r.ok).length, 1);
        },
      );
      await t.test(
        "AUTH-01 AUTH-04 password reset changes credential while preserving enabled MFA",
        async () => {
          const reset = await service.auth.handler(
            request("/request-password-reset", {
              email,
              redirectTo: `${baseURL}/reset-password`,
            }),
          );
          assert.ok(reset.ok);
          const row = (
            await owner.query(
              `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='password-reset' ORDER BY created_at DESC LIMIT 1`,
              [email],
            )
          ).rows[0];
          const payload = decryptProtected<EmailPayload>(
            row.payload_encrypted,
            config,
          );
          const token = new URL(payload.actionUrl!).pathname.split("/").at(-1);
          const nextPassword = "Changed Rootset password after verified reset";
          const changed = await service.auth.handler(
            request("/reset-password", { token, newPassword: nextPassword }),
          );
          assert.ok(changed.ok);
          password = nextPassword;
          assert.equal(
            (
              await owner.query(
                `SELECT two_factor_enabled FROM rootset_control.users WHERE id=$1`,
                [actor.userId],
              )
            ).rows[0].two_factor_enabled,
            true,
          );
          await assert.rejects(
            () => service.refreshActor(actor),
            (error) => (error as { code: string }).code === "UNAUTHENTICATED",
          );
          const loginPending = await login(service, email, password);
          assert.equal(loginPending.body.twoFactorRedirect, true);
          assert.equal(
            await service.resolveActor(
              request("/get-session", undefined, loginPending.cookie),
              "browser",
            ),
            null,
          );
        },
      );
      await t.test(
        "AUTH-10 operator recovery revokes factors and credentials with an audited reason",
        async () => {
          const originalSession = actor.id;
          await assert.rejects(() =>
            service.recoverUser(actor.userId!, { reason: "" }),
          );
          await service.recoverUser(actor.userId!, {
            reason: "Fixture recovery ceremony",
          });
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.auth_two_factors WHERE user_id=$1`,
                [actor.userId],
              )
            ).rows[0].count,
            "0",
          );
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.sessions WHERE id=$1`,
                [originalSession],
              )
            ).rows[0].count,
            "0",
          );
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.api_keys WHERE owner_user_id=$1 AND revoked_at IS NULL`,
                [actor.userId],
              )
            ).rows[0].count,
            "0",
          );
          const session = await login(service, email, password);
          assert.ok(session.response.ok);
          cookie = session.cookie;
          actor = (await service.resolveActor(
            request("/get-session", undefined, cookie),
            "browser",
          ))!;
          assert.equal(actor.operator, false);
          assert.equal(actor.role, "owner");
          await service.bindOperator(actor.userId!, {
            reason: "Fixture explicit installation operator binding",
          });
          assert.equal((await service.refreshActor(actor)).operator, true);
          await assert.rejects(
            () =>
              execute(
                "beginAccountAction",
                actor,
                {
                  operationId: "updateInstallationConfiguration",
                  input: {
                    smtp: {
                      host: "localhost",
                      port: 587,
                      secure: true,
                      from: "rootset@example.test",
                    },
                  },
                },
                {
                  numericLexemes: [
                    analyseNumberLexeme("587.000000000000000001", [
                      "input",
                      "smtp",
                      "port",
                    ]),
                  ],
                },
              ),
            (error) => (error as { code: string }).code === "VALIDATION_FAILED",
          );
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.email_outbox WHERE to_address=$1 AND template='account-recovery'`,
                [email],
              )
            ).rows[0].count,
            "1",
          );
        },
      );
      await t.test(
        "ACC-07 current membership disablement blocks an existing session immediately",
        async () => {
          const row = (
            await owner.query(
              `SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2`,
              [orgId, viewerUserId],
            )
          ).rows[0];
          await execute("updateMember", actor, {
            orgId,
            id: row.id,
            state: "disabled",
            expectedVersion: String(row.version),
          });
          await assert.rejects(() => service.refreshActor(viewerActor));
          await assert.rejects(() => service.refreshPolicyActor(viewerActor));
          const result = await service
            .resolveActor(
              request("/get-session", undefined, viewerCookie),
              "browser",
            )
            .catch(() => null);
          assert.equal(result, null);
        },
      );
      await t.test(
        "KEY-02 KEY-03 current personal authority and organisation-owned team keys survive creator departure",
        async () => {
          let member = (
            await owner.query(
              `SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2`,
              [orgId, viewerUserId],
            )
          ).rows[0];
          await execute("updateMember", actor, {
            orgId,
            id: member.id,
            state: "active",
            expectedVersion: String(member.version),
          });
          const viewerLogin = await login(
            service,
            "viewer@example.test",
            viewerPassword,
          );
          viewerActor = (await service.resolveActor(
            request("/get-session", undefined, viewerLogin.cookie),
            "browser",
          ))!;
          const created = KeyCreatedSchema.parse(
            await execute(
              "createTeamKey",
              actor,
              {
                orgId,
                name: "Team reader",
                scopes: ["org:read", "rows:read"],
                targets: [],
                unrestricted: true,
              },
              { idempotencyKey: newId() },
            ),
          );
          await execute("transferOwnership", actor, {
            orgId,
            userId: viewerUserId,
          });
          assert.equal((await service.refreshActor(actor)).role, "admin");
          assert.equal((await service.refreshActor(viewerActor)).role, "owner");
          member = (
            await owner.query(
              `SELECT id,version FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2`,
              [orgId, actor.userId],
            )
          ).rows[0];
          await execute("removeMember", viewerActor, {
            orgId,
            id: member.id,
            expectedVersion: String(member.version),
          });
          await assert.rejects(() => service.refreshActor(actor));
          const team = await service.resolveActor(
            new Request(`${baseURL}/v1/me`, {
              headers: { authorization: `Bearer ${created.secret}` },
            }),
            "api",
          );
          assert.ok(team);
          assert.equal(team!.kind, "team_key");
          assert.equal(team!.userId, undefined);
          assert.equal(team!.operator, false);
          await assert.rejects(() => execute("getProfile", team!, {}));
        },
      );
      await t.test(
        "ACC-10 account deletion finalizer commits tombstone, audit and durable outcome atomically",
        async () => {
          await assert.rejects(
            () =>
              service.finishDeletion(
                actor,
                "account",
                { confirmation: "DELETE" },
                { surface: "browser" },
              ),
            (error) => (error as { code: string }).code === "ACCESS_DENIED",
          );
          await assert.rejects(() =>
            service.finishDeletion(
              actor,
              "account",
              { confirmation: "DELETE" },
              { surface: "worker" },
              async (client) => {
                assert.equal(
                  (
                    await client.query(
                      `SELECT current_setting('rootset.org_id') value`,
                    )
                  ).rows[0].value,
                  orgId,
                );
                throw new Error("Durable outcome rollback probe");
              },
            ),
          );
          assert.equal(
            (
              await owner.query(
                `SELECT disabled FROM rootset_control.users WHERE id=$1`,
                [actor.userId],
              )
            ).rows[0].disabled,
            false,
          );
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.auth_accounts WHERE user_id=$1`,
                [actor.userId],
              )
            ).rows[0].count,
            "1",
          );
          let journalCommits = 0;
          const recovery = service
            .restoreOwner(orgId, actor.userId!, {
              reason: "Concurrent deletion recovery fixture",
            })
            .then(
              () => ({ ok: true }),
              () => ({ ok: false }),
            );
          const result = await service.finishDeletion(
            actor,
            "account",
            { confirmation: "DELETE" },
            { surface: "worker" },
            async (client, outcome) => {
              assert.equal(
                (
                  await client.query(
                    `SELECT current_setting('rootset.org_id') value`,
                  )
                ).rows[0].value,
                orgId,
              );
              assert.equal(outcome.deleted, true);
              journalCommits++;
            },
          );
          assert.equal((result as { deleted: boolean }).deleted, true);
          assert.equal(journalCommits, 1);
          await recovery;
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.memberships WHERE user_id=$1`,
                [actor.userId],
              )
            ).rows[0].count,
            "0",
          );
          const deleted = (
            await owner.query(
              `SELECT name,email,disabled FROM rootset_control.users WHERE id=$1`,
              [actor.userId],
            )
          ).rows[0];
          assert.equal(deleted.disabled, true);
          assert.equal(deleted.name, "Deleted account");
          assert.ok(deleted.email.endsWith("@deleted.rootset.invalid"));
          assert.equal(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.auth_accounts WHERE user_id=$1`,
                [actor.userId],
              )
            ).rows[0].count,
            "0",
          );
          assert.ok(
            (
              await owner.query(
                `SELECT count(*) FROM rootset_control.account_audit WHERE operation='deleteAccount' AND user_id=$1`,
                [actor.userId],
              )
            ).rows[0].count !== "0",
          );
          const replay = await service.finishDeletion(
            actor,
            "account",
            { confirmation: "DELETE" },
            { surface: "worker" },
          );
          assert.equal((replay as { deleted: boolean }).deleted, true);
        },
      );
      await t.test(
        "AUTH-13 SMTP outage retries persistent encrypted outbox and event dedupe survives worker restart",
        async () => {
          const eventId = newId();
          const denied = new EmailOutbox(pool, {
            ...config,
            smtp: { host: "127.0.0.1", port: 1, from: "rootset@example.test" },
          });
          const original = await denied.enqueue(pool, {
            template: "account-recovery",
            to: "delivery@example.test",
            payload: { name: "Delivery Test" },
            dedupeKey: eventId,
          });
          const same = await denied.enqueue(pool, {
            template: "account-recovery",
            to: "delivery@example.test",
            payload: { name: "Delivery Test" },
            dedupeKey: eventId,
          });
          assert.equal(original, same);
          await owner.query(
            `UPDATE rootset_control.email_outbox SET next_attempt_at=now()+interval '1 day' WHERE id<>$1`,
            [original],
          );
          assert.equal(await denied.deliverNext(), true);
          const failed = (
            await owner.query(
              `SELECT state,attempts,last_error,payload_encrypted FROM rootset_control.email_outbox WHERE id=$1`,
              [original],
            )
          ).rows[0];
          assert.equal(failed.state, "pending");
          assert.equal(failed.attempts, 1);
          assert.equal(failed.last_error, "SMTP delivery failed");
          assert.ok(failed.payload_encrypted);
          const smtpHost = process.env.ROOTSET_SMTP_HOST;
          const smtpPort = Number(process.env.ROOTSET_SMTP_PORT);
          const smtpFrom = process.env.ROOTSET_EMAIL_FROM;
          assert.ok(smtpHost, "The mail fixture needs a configured SMTP host");
          assert.ok(
            Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort <= 65535,
            "The mail fixture needs a configured SMTP port",
          );
          assert.ok(smtpFrom, "The mail fixture needs a configured sender");
          const restarted = new EmailOutbox(pool, {
            ...config,
            smtp: {
              host: smtpHost,
              port: smtpPort,
              secure: process.env.ROOTSET_SMTP_SECURE === "true",
              from: smtpFrom,
              user: process.env.ROOTSET_SMTP_USER,
              password: process.env.ROOTSET_SMTP_PASSWORD,
            },
          });
          await owner.query(
            `UPDATE rootset_control.email_outbox SET next_attempt_at=now() WHERE id=$1`,
            [original],
          );
          assert.equal(await restarted.deliverNext(), true);
          const sent = (
            await owner.query(
              `SELECT state,attempts,payload_encrypted,provider_id FROM rootset_control.email_outbox WHERE id=$1`,
              [original],
            )
          ).rows[0];
          assert.equal(sent.state, "sent");
          assert.equal(sent.attempts, 2);
          assert.equal(sent.payload_encrypted, "");
          assert.ok(sent.provider_id);
          const later = await restarted.enqueue(pool, {
            template: "account-recovery",
            to: "delivery@example.test",
            payload: { name: "Delivery Test" },
            dedupeKey: newId(),
          });
          assert.notEqual(later, original);
        },
      );
      await t.test(
        "ACC-11 account audit redacts secrets and records credential actor context",
        async () => {
          const rows = (
            await owner.query(
              `SELECT operation,actor_kind,actor_id,outcome FROM rootset_control.account_audit WHERE org_id=$1`,
              [orgId],
            )
          ).rows;
          assert.ok(rows.length > 5);
          assert.ok(rows.some((r) => r.operation === "createPersonalKey"));
          assert.equal(JSON.stringify(rows).includes(password), false);
          assert.equal(JSON.stringify(rows).includes("rst_"), false);
          await withOrg(pool, newId(), async (client) => {
            assert.equal(
              (
                await client.query(
                  `SELECT id FROM rootset_control.memberships WHERE org_id=$1`,
                  [orgId],
                )
              ).rowCount,
              0,
            );
          });
        },
      );
    } finally {
      await pool.end();
      await owner.end();
      await admin.query(`DROP DATABASE ${databaseName}`);
      await admin.end();
    }
  },
);
