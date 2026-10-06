import assert from "node:assert/strict";
import test from "node:test";
import {
  getOperation,
  newId,
  scopeNames,
  type Actor,
} from "@rootset/contracts";
import { isolatedDatabase } from "../../../tools/verification/isolated-database.js";
import { createRuntime } from "./runtime.js";
import { loadConfig } from "./config.js";

test("actual core field order, schema preview, uniqueness removal, statistics, count jobs and mutation inspection preserve data and current access", async () => {
  const db = await isolatedDatabase();
  const runtime = await createRuntime({
    ...loadConfig(),
    databaseURL: db.app.options.connectionString!,
    ddlDatabaseURL: db.ddl.options.connectionString!,
    identityDatabaseURL: db.identity.options.connectionString!,
  });
  try {
    const orgId = newId();
    await db.owner.query(
      "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Core operation fixture')",
      [orgId],
    );
    const makeActor = async (role: "admin" | "viewer"): Promise<Actor> => {
      const userId = newId(),
        sessionId = newId();
      await db.owner.query(
        "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
        [userId, role, `${userId.toLowerCase()}@core.example.test`],
      );
      await db.owner.query(
        "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,$4)",
        [newId(), orgId, userId, role],
      );
      await db.owner.query(
        "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at,authenticated_at) VALUES($1,$2,$3,now()+interval '1 day',now())",
        [sessionId, userId, newId()],
      );
      return {
        kind: "session",
        id: sessionId,
        userId,
        orgId,
        role,
        scopes: [...scopeNames],
        authenticatedAt: Date.now(),
      };
    };
    const owner = await makeActor("admin"),
      viewer = await makeActor("viewer");
    const call = async (
      id: string,
      input: Record<string, unknown>,
      actor = owner,
    ) => {
      const result = await runtime.core.execute(id, actor, input, {
        surface: "browser",
        idempotencyKey: newId(),
        requestId: newId(),
      });
      return getOperation(id).outputSchema.parse(result) as Record<
        string,
        unknown
      >;
    };
    const database = await call("createDatabase", { orgId, name: "Lifecycle" });
    const schema = await call("createTable", {
      orgId,
      databaseId: database.id,
      name: "Codes",
      fields: [
        { type: "text", name: "CODE", charLimit: 20 },
        { type: "integer", name: "COUNT" },
      ],
    });
    const tableId = (schema.table as { id: string }).id;
    const target = { orgId, databaseId: database.id, tableId };
    const fields = (await call("listFields", target, viewer)).data as Array<{
      id: string;
      name: string;
    }>;
    assert.deepEqual(
      fields.map((field) => field.name),
      ["CODE", "COUNT"],
    );
    const created = await call("createRow", {
      ...target,
      expectedSchemaVersion: 1,
      values: { CODE: "long-code", COUNT: 2 },
    });
    const row = created.row as { id: string; version: string };
    const mutation = (
      await db.owner.query(
        "SELECT id FROM rootset_control.mutations WHERE table_id=$1 AND outcome IS NOT NULL ORDER BY committed_at DESC LIMIT 1",
        [tableId],
      )
    ).rows[0];
    assert(mutation);
    const inspected = await call("getMutation", { orgId, id: mutation.id });
    assert.equal(inspected.mutationId, mutation.id);
    assert.equal(JSON.stringify(inspected).includes(row.id as string), true);
    assert.equal(JSON.stringify(inspected).includes("idempotency_key"), false);
    const preview = await call("previewSchemaChange", {
      ...target,
      expectedSchemaVersion: 1,
      change: {
        kind: "update_field",
        fieldId: fields[0]!.id,
        changes: { charLimit: 3 },
      },
    });
    assert.equal(preview.valid, false);
    assert.equal(
      (preview.conflicts as Array<{ rowId: string }>)[0]!.rowId,
      row.id,
    );
    assert.equal(
      (await runtime.storage.getTable(owner, tableId)).schemaVersion,
      1,
    );
    const reordered = await call("reorderFields", {
      ...target,
      expectedSchemaVersion: 1,
      fieldIds: [fields[1]!.id, fields[0]!.id],
    });
    assert.deepEqual(
      (reordered.fields as Array<{ name: string }>).map((field) => field.name),
      ["COUNT", "CODE"],
    );
    const persisted = await call(
      "getRow",
      { ...target, rowId: row.id },
      viewer,
    );
    assert.deepEqual(persisted.values, { CODE: "long-code", COUNT: 2 });
    assert.equal(persisted.version, row.version);
    const rule = await runtime.storage.createUniqueRule(owner, tableId, {
      fieldIds: [fields[0]!.id],
      expectedSchemaVersion: 2,
      idempotencyKey: newId(),
    });
    await assert.rejects(
      call("createRow", {
        ...target,
        expectedSchemaVersion: 3,
        values: { CODE: "long-code", COUNT: 4 },
      }),
      (error: unknown) =>
        (error as { code: string }).code === "UNIQUE_CONFLICT",
    );
    await call("deleteUniqueRule", {
      ...target,
      id: rule.id,
      expectedSchemaVersion: 3,
    });
    await call("createRow", {
      ...target,
      expectedSchemaVersion: 4,
      values: { CODE: "long-code", COUNT: 4 },
    });
    assert.equal(
      (await runtime.storage.listUniqueRules(owner, tableId)).length,
      0,
    );
    const statistics = await call("getTableStatistics", target, viewer);
    assert.equal(statistics.liveRows, 2);
    assert.equal(statistics.rowCountKind, "live");
    assert.equal(statistics.historyEvents, 4);
    assert((statistics.storageBytes as number) > 0);
    const live = await call("countRows", target, viewer);
    assert.equal(live.count, 2);
    assert.equal(live.kind, "live");
    const exact = await call(
      "countRows",
      {
        ...target,
        exact: true,
        query: { where: { field: "COUNT", op: "gte", value: 4 } },
      },
      viewer,
    );
    assert.equal(exact.state, "queued");
    await runtime.jobs.runOnce(orgId);
    const completed = await call("getJob", { orgId, id: exact.jobId }, viewer);
    assert.equal(completed.state, "succeeded");
    assert.equal((completed.result as { count: number }).count, 1);
    assert.equal((completed.result as { kind: string }).kind, "exact");
    await assert.rejects(
      call(
        "reorderFields",
        {
          ...target,
          expectedSchemaVersion: 4,
          fieldIds: fields.map((field) => field.id),
        },
        viewer,
      ),
      (error: unknown) =>
        ["FORBIDDEN", "INSUFFICIENT_SCOPE", "ACCESS_DENIED"].includes(
          (error as { code: string }).code,
        ),
    );
    await db.owner.query(
      "DELETE FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
      [orgId, owner.userId],
    );
    await assert.rejects(
      call("getMutation", { orgId, id: mutation.id }),
      (error: unknown) =>
        (error as { code: string }).code === "UNAUTHENTICATED",
    );
    assert.equal(
      (await runtime.storage.getRow(viewer, tableId, row.id as string)).version,
      row.version,
    );
  } finally {
    await runtime.close();
    await db.close();
  }
});
