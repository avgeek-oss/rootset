import { workspaceInput } from "../../../tools/verification/workspace-input";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  newId,
  getOperation,
  type Actor,
  type Role,
  type RowRelationships,
  type RelatedRowFilter,
} from "@rootset/contracts";
import { withOrg } from "@rootset/database";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { createRuntime } from "./runtime";
import { loadConfig } from "./config";

test(
  "relationship reads bind pagination and recheck viewer, credential and membership authority",
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
        "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Relationships')",
        [orgId],
      );
      async function person(role: Role): Promise<Actor> {
        const userId = newId(),
          sessionId = newId();
        await fixture.owner.query(
          "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
          [userId, role, `${userId.toLowerCase()}@example.test`],
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
        viewer = await person("viewer");
      const database = await runtime.storage.createDatabase(admin, {
        name: "Relationship data",
      });
      let parent = await runtime.storage.createTable(admin, database.id, {
        name: "Parents",
        fields: [{ name: "CODE", type: "integer" }],
      });
      const unique = await runtime.storage.createUniqueRule(admin, parent.id, {
        fieldIds: [parent.fields[0]!.id],
        expectedSchemaVersion: parent.schemaVersion,
      });
      parent = await runtime.storage.getTable(admin, parent.id);
      const record = await runtime.storage.createRow(admin, parent.id, {
        CODE: 0,
      });
      const other = await runtime.storage.createRow(admin, parent.id, {
        CODE: 1,
      });
      let source = await runtime.storage.createTable(admin, database.id, {
        name: "Children",
        fields: [
          { name: "ONE", type: "integer" },
          { name: "TWO", type: "integer" },
        ],
      });
      const rules = [];
      for (const field of source.fields) {
        rules.push(
          await runtime.storage.createForeignKey(admin, source.id, {
            fieldIds: [field.id],
            referencedTableId: parent.id,
            referencedRuleId: unique.id,
            expectedSchemaVersion: source.schemaVersion,
            expectedReferencedSchemaVersion: parent.schemaVersion,
          }),
        );
        source = await runtime.storage.getTable(admin, source.id);
      }
      await runtime.storage.createRow(admin, source.id, { ONE: 0, TWO: 0 });
      async function call<T>(
        operation: string,
        input: Record<string, unknown>,
        actor = viewer,
      ): Promise<T> {
        const result = await runtime.core.execute(
          operation,
          actor,
          workspaceInput(operation, actor, {
            orgId,
            ...(operation === "createPersonalKey"
              ? {}
              : { databaseId: database.id }),
            ...input,
          }),
          { surface: "rest", idempotencyKey: newId() },
        );
        return getOperation(operation).outputSchema.parse(result) as T;
      }
      const input = {
        tableId: parent.id,
        rowId: record.id,
        expectedVersion: record.version,
        limit: 1,
      };
      const page = await call<RowRelationships>("getRowRelationships", input);
      assert.equal(page.data.length, 1);
      assert.equal(page.data[0]!.count, 1);
      assert.equal(page.hasMore, true);
      assert(page.nextCursor);
      const next = await call<RowRelationships>("getRowRelationships", {
        ...input,
        cursor: page.nextCursor,
      });
      assert.equal(next.data[0]!.id, rules[1]!.id);
      assert.equal(next.hasMore, false);
      for (const changed of [
        { rowId: other.id },
        { limit: 2 },
        { expectedVersion: "2" },
      ])
        await assert.rejects(
          call("getRowRelationships", {
            ...input,
            ...changed,
            cursor: page.nextCursor,
          }),
          { code: "CURSOR_INVALID" },
        );
      const linked = await call<RelatedRowFilter>("getRelatedRowFilter", {
        tableId: source.id,
        ruleId: rules[0]!.id,
        referencedRowId: record.id,
      });
      assert.deepEqual(linked.filter, [
        { fieldId: source.fields[0]!.id, value: 0 },
      ]);
      await assert.rejects(
        call("getRowRelationships", { ...input, databaseId: newId() }),
        { code: "RESOURCE_NOT_FOUND" },
      );
      const key = await call<{ key: { id: string }; secret: string }>(
        "createPersonalKey",
        {
          name: "Relationship reader",
          access: "read",
          includeAdmin: false,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        admin,
      );
      const credential = await runtime.identity.resolveActor(
        new Request("http://localhost:4310/v1", {
          headers: { authorization: `Bearer ${key.secret}` },
        }),
        "api",
      );
      assert(credential);
      assert.equal(
        (await call<RowRelationships>("getRowRelationships", input, credential))
          .data[0]!.count,
        1,
      );
      await withOrg(fixture.app, orgId, (c) =>
        c.query(
          "UPDATE rootset_control.api_keys SET revoked_at=now() WHERE id=$1",
          [key.key.id],
        ),
      );
      await assert.rejects(call("getRowRelationships", input, credential));
      await fixture.owner.query(
        "DELETE FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, viewer.userId],
      );
      await assert.rejects(
        call("getRowRelationships", input, { ...viewer, role: "admin" }),
      );
      await assert.rejects(
        call(
          "getRelatedRowFilter",
          {
            tableId: source.id,
            ruleId: rules[0]!.id,
            referencedRowId: record.id,
          },
          viewer,
        ),
      );
    } finally {
      await runtime.close();
      await fixture.close();
    }
  },
);
