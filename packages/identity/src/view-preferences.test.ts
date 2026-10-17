import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  newId,
  type ForeignKey,
  type ViewPreferences,
} from "@rootset/contracts";
import { createIdentityService } from "./index";
import { TableStorage } from "../../table-storage/src/index";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";

test(
  "personal foreign-key labels update atomically, preserve layout saves and validate target fields",
  { skip: !process.env.ROOTSET_TEST_DATABASE_URL },
  async () => {
    const fixture = await isolatedDatabase();
    const baseURL = "http://localhost:6300";
    const config = {
      pool: fixture.identity,
      baseURL,
      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKey: randomBytes(32).toString("base64"),
    };
    const service = createIdentityService(config);
    const storage = new TableStorage({
      pool: fixture.app,
      ddlPool: fixture.ddl,
      cursorSecret: randomBytes(32).toString("hex"),
    });
    const email = `${newId().toLowerCase()}@example.test`,
      password = randomBytes(32).toString("base64url");
    try {
      await service.claimSetup({
        bootstrapSecret: config.bootstrapSecret,
        name: "Picker fixture",
        email,
        password,
        organisationName: "Picker preferences",
      });
      const response = await service.auth.handler(
        new Request(`${baseURL}/v1/auth/sign-in/email`, {
          method: "POST",
          headers: { origin: baseURL, "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        }),
      );
      assert.equal(response.status, 200);
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const actor = (await service.resolveActor(
        new Request(`${baseURL}/v1/auth/get-session`, { headers: { cookie } }),
        "browser",
      ))!;
      const execute = (id: string, input: Record<string, unknown>) =>
        service.execute(id, actor, input, {
          idempotencyKey: newId(),
        }) as Promise<{ preferences: ViewPreferences }>;
      const database = await storage.createDatabase(actor, {
        name: "Picker data",
      });
      let parent = await storage.createTable(actor, database.id, {
        name: "Parents",
        fields: [
          { name: "KEY_ID", type: "integer", required: true },
          { name: "NAME", type: "text" },
          { name: "PAYLOAD", type: "json" },
        ],
      });
      const unique = await storage.createUniqueRule(actor, parent.id, {
        fieldIds: [parent.fields[0]!.id],
        expectedSchemaVersion: parent.schemaVersion,
        idempotencyKey: newId(),
      });
      parent = await storage.getTable(actor, parent.id);
      let child = await storage.createTable(actor, database.id, {
        name: "Children",
        fields: [
          { name: "PARENT_A", type: "integer" },
          { name: "PARENT_B", type: "integer" },
        ],
      });
      const links: ForeignKey[] = [];
      for (const field of child.fields) {
        const link = await storage.createForeignKey(actor, child.id, {
          fieldIds: [field.id],
          referencedTableId: parent.id,
          referencedRuleId: unique.id,
          expectedSchemaVersion: child.schemaVersion,
          expectedReferencedSchemaVersion: parent.schemaVersion,
          idempotencyKey: newId(),
        });
        links.push(link);
        child = await storage.getTable(actor, child.id);
      }
      const layout = {
        columnOrder: child.fields.map((field) => field.id),
        columnWidths: { [child.fields[0]!.id]: 184 },
        hiddenColumns: [],
        frozenColumns: 0,
      };
      await execute("updateViewPreferences", {
        tableId: child.id,
        preferences: layout,
      });
      await Promise.all(
        links.map((link) =>
          execute("updateForeignKeyDisplayField", {
            tableId: child.id,
            foreignKeyId: link.id,
            displayFieldId: parent.fields[1]!.id,
          }),
        ),
      );
      const expected = Object.fromEntries(
        links.map((link) => [link.id, parent.fields[1]!.id]),
      );
      const read = await execute("getViewPreferences", { tableId: child.id });
      assert.deepEqual(read.preferences, {
        ...layout,
        foreignKeyDisplayFields: expected,
      });
      const resized = await execute("updateViewPreferences", {
        tableId: child.id,
        preferences: {
          ...layout,
          columnWidths: { [child.fields[0]!.id]: 220 },
          foreignKeyDisplayFields: {},
        },
      });
      assert.deepEqual(resized.preferences.foreignKeyDisplayFields, expected);
      assert.equal(resized.preferences.columnWidths[child.fields[0]!.id], 220);
      for (const displayFieldId of [
        parent.fields[2]!.id,
        child.fields[0]!.id,
        newId(),
      ])
        await assert.rejects(
          () =>
            execute("updateForeignKeyDisplayField", {
              tableId: child.id,
              foreignKeyId: links[0]!.id,
              displayFieldId,
            }),
          (error) => (error as { code: string }).code === "VALIDATION_FAILED",
        );
      const cleared = await execute("updateForeignKeyDisplayField", {
        tableId: child.id,
        foreignKeyId: links[0]!.id,
        displayFieldId: null,
      });
      assert.deepEqual(cleared.preferences.foreignKeyDisplayFields, {
        [links[1]!.id]: parent.fields[1]!.id,
      });
      await assert.rejects(() =>
        execute("updateForeignKeyDisplayField", {
          tableId: parent.id,
          foreignKeyId: links[1]!.id,
          displayFieldId: parent.fields[1]!.id,
        }),
      );
    } finally {
      await fixture.close();
    }
  },
);
