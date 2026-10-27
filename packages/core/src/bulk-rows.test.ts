import { workspaceInput } from "../../../tools/verification/workspace-input";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyseNumberLexeme,
  getOperation,
  newId,
  type Actor,
  type BulkRowsPreview,
  type BulkRowsResult,
  type Row,
  type Role,
  type TableSchemaResult,
} from "@rootset/contracts";
import { withOrg } from "@rootset/database";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { createRuntime } from "./runtime";
import { loadConfig } from "./config";

test(
  "bulk actions recheck live authority, roll back cancellation and replay concurrent requests without duplicating",
  { skip: !process.env.ROOTSET_TEST_DATABASE_URL },
  async () => {
    const fixture = await isolatedDatabase();
    const runtime = await createRuntime({
      ...loadConfig(),
      databaseURL: fixture.app.options.connectionString!,
    });
    try {
      const orgId = newId();
      await fixture.owner.query(
        "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Bulk authority')",
        [orgId],
      );
      async function person(role: Role): Promise<Actor> {
        const userId = newId(),
          sessionId = newId();
        await fixture.owner.query(
          "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
          [userId, role, userId.toLowerCase() + "@example.test"],
        );
        await fixture.owner.query(
          "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,$4)",
          [newId(), orgId, userId, role],
        );
        await fixture.owner.query(
          "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at,authenticated_at) VALUES($1,$2,$3,now()+interval '1 day',now())",
          [sessionId, userId, newId()],
        );
        return {
          kind: "session",
          id: sessionId,
          userId,
          orgId,
          role,
          scopes: [],
          membershipVersion: 1,
        };
      }
      const admin = await person("admin"),
        member = await person("member"),
        viewer = await person("viewer");
      async function call<T>(
        id: string,
        input: Record<string, unknown>,
        actor = member,
        key = newId(),
      ) {
        const result = await runtime.core.execute(
          id,
          actor,
          workspaceInput(id, actor, input),
          {
            surface: "browser",
            idempotencyKey: key,
          },
        );
        return getOperation(id).outputSchema.parse(result) as T;
      }
      const database = await call<{ id: string }>(
        "createDatabase",
        { orgId, name: "Bulk" },
        admin,
      );
      const schema = await call<TableSchemaResult>("createTable", {
        orgId,
        databaseId: database.id,
        name: "Records",
        fields: [
          {
            name: "RECORD_ID",
            type: "integer",
            required: true,
            autoIncrement: true,
          },
          { name: "NAME", type: "text", charLimit: 80 },
          { name: "COUNT", type: "integer" },
        ],
      });
      const target = {
        orgId,
        databaseId: database.id,
        tableId: schema.table.id,
        expectedSchemaVersion: schema.table.schemaVersion,
      };
      const source = (
        await call<{ row: Row }>("createRow", {
          ...target,
          values: { NAME: "source", COUNT: 0 },
        })
      ).row;
      const input = {
        ...target,
        rows: [{ rowId: source.id, expectedVersion: source.version }],
        action: { type: "duplicate" },
      };
      for (const id of ["previewBulkRows", "bulkRows"])
        await assert.rejects(
          call(id, input, { ...viewer, scopes: ["*"], role: "admin" }),
          { code: "FORBIDDEN" },
        );
      const preview = await call<BulkRowsPreview>("previewBulkRows", input);
      assert.equal(preview.valid, 1);
      assert.equal(
        (await runtime.storage.getTable(member, schema.table.id)).rowCount,
        1,
      );
      await assert.rejects(
        call("previewBulkRows", {
          ...input,
          expectedSchemaVersion: target.expectedSchemaVersion + 1,
        }),
        { code: "SCHEMA_VERSION_CONFLICT" },
      );
      const patch = { ...input, action: { type: "set", values: { COUNT: 1 } } };
      await assert.rejects(
        runtime.core.execute(
          "previewBulkRows",
          member,
          workspaceInput("previewBulkRows", member, patch),
          {
            surface: "rest",
            numericLexemes: [
              analyseNumberLexeme("1.0000000000000001", [
                "action",
                "values",
                "COUNT",
              ]),
            ],
          },
        ),
        { code: "VALIDATION_FAILED" },
      );
      const key = newId();
      const [first, second] = await Promise.all([
        call<BulkRowsResult>("bulkRows", input, member, key),
        call<BulkRowsResult>("bulkRows", input, member, key),
      ]);
      assert.deepEqual(first, second);
      assert.equal(first.createdIds.length, 1);
      assert.equal(
        (await runtime.storage.getTable(member, schema.table.id)).rowCount,
        2,
      );
      const updated = (
        await call<{ row: Row }>("updateRow", {
          ...target,
          rowId: source.id,
          expectedVersion: source.version,
          values: { COUNT: 5 },
        })
      ).row;
      assert.deepEqual(await call("bulkRows", input, member, key), first);
      assert.equal(
        (await call<BulkRowsPreview>("previewBulkRows", input)).issues[0]!.code,
        "ROW_VERSION_CONFLICT",
      );
      const current = {
        ...input,
        rows: [{ rowId: updated.id, expectedVersion: updated.version }],
      };
      const cancelledKey = newId();
      await assert.rejects(
        runtime.core.execute(
          "bulkRows",
          member,
          workspaceInput("bulkRows", member, current),
          {
            surface: "browser",
            idempotencyKey: cancelledKey,
            signal: AbortSignal.abort(),
          },
        ),
        { code: "REQUEST_TIMEOUT" },
      );
      assert.equal(
        (await runtime.storage.getTable(member, schema.table.id)).rowCount,
        2,
      );
      const retried = await call<BulkRowsResult>(
        "bulkRows",
        current,
        member,
        cancelledKey,
      );
      assert.equal(retried.createdIds.length, 1);
      assert.equal(
        (await runtime.storage.getTable(member, schema.table.id)).rowCount,
        3,
      );
      await assert.rejects(
        runtime.core.execute(
          "bulkRows",
          member,
          workspaceInput("bulkRows", member, current),
          {
            surface: "browser",
            idempotencyKey: newId(),
            beforePublish: async () => {
              await fixture.owner.query(
                "UPDATE rootset_control.memberships SET role='viewer' WHERE org_id=$1 AND user_id=$2",
                [orgId, member.userId],
              );
            },
          },
        ),
        { code: "FORBIDDEN" },
      );
      assert.equal(
        (await runtime.storage.getTable(admin, schema.table.id)).rowCount,
        3,
      );
      await assert.rejects(call("bulkRows", input, member, key), {
        code: "FORBIDDEN",
      });
      await fixture.owner.query(
        "UPDATE rootset_control.memberships SET role='member' WHERE org_id=$1 AND user_id=$2",
        [orgId, member.userId],
      );
      const created = await call<{ key: { id: string }; secret: string }>(
        "createPersonalKey",
        {
          orgId,
          name: "Bulk key",
          access: "edit",
          includeAdmin: false,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      );
      const credential = (await runtime.identity.resolveActor(
        new Request("http://localhost:4310/v1", {
          headers: { authorization: `Bearer ${created.secret}` },
        }),
        "api",
      ))!;
      assert(credential);
      const keyResult = await call<BulkRowsResult>(
        "bulkRows",
        current,
        credential,
        newId(),
      );
      assert.equal(keyResult.createdIds.length, 1);
      const revokedKey = newId();
      await assert.rejects(
        runtime.core.execute(
          "bulkRows",
          credential,
          workspaceInput("bulkRows", credential, current),
          {
            surface: "rest",
            idempotencyKey: revokedKey,
            beforePublish: async () => {
              const changed = await withOrg(fixture.owner, orgId, (c) =>
                c.query(
                  "UPDATE rootset_control.api_keys SET revoked_at=now() WHERE id=$1",
                  [created.key.id],
                ),
              );
              assert.equal(changed.rowCount, 1);
            },
          },
        ),
        { code: "UNAUTHENTICATED" },
      );
      assert.equal(
        (await runtime.storage.getTable(admin, schema.table.id)).rowCount,
        4,
      );
      assert.equal(
        (
          await runtime.storage.queryRows(admin, schema.table.id, {
            orderBy: [{ field: "RECORD_ID", direction: "asc" }],
          })
        ).data.at(-1)!.values.RECORD_ID,
        4,
      );
      await assert.rejects(call("previewBulkRows", current, credential), {
        code: "UNAUTHENTICATED",
      });
    } finally {
      await runtime.close();
      await fixture.close();
    }
  },
);
