import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  newId,
  type Actor,
  type Role,
  type SavedView,
} from "@rootset/contracts";
import { withOrg } from "@rootset/database";
import { createIdentityService } from "./index";
import { TableStorage } from "../../table-storage/src/index";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";

const failure = (code: string) => (error: unknown) =>
  (error as { code: string }).code === code;
test(
  "saved views enforce personal ownership, shared write authority, versions and durable retries",
  { skip: !process.env.ROOTSET_TEST_DATABASE_URL },
  async () => {
    const fixture = await isolatedDatabase();
    const config = {
      pool: fixture.identity,
      baseURL: "http://localhost:6300",
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
    try {
      await service.claimSetup({
        bootstrapSecret: config.bootstrapSecret,
        name: "View owner",
        email: "view-owner@example.test",
        password: randomBytes(32).toString("base64url"),
        organisationName: "Saved views",
      });
      const orgId = (
        await fixture.owner.query<{ id: string }>(
          "SELECT id FROM rootset_control.organisations",
        )
      ).rows[0]!.id;
      async function person(role: Role): Promise<Actor> {
        const userId = newId(),
          sessionId = newId();
        await withOrg(fixture.owner, orgId, async (client) => {
          await client.query(
            "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
            [userId, role + " person", userId.toLowerCase() + "@example.test"],
          );
          await client.query(
            "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,$4)",
            [newId(), orgId, userId, role],
          );
          await client.query(
            "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
            [sessionId, userId, newId()],
          );
        });
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
      const owner = await person("admin"),
        member = await person("member"),
        viewer = await person("viewer"),
        admin = await person("admin");
      const database = await storage.createDatabase(owner, { name: "Views" });
      let table = await storage.createTable(owner, database.id, {
        name: "Records",
        fields: [
          { name: "NAME", type: "text", charLimit: 80 },
          { name: "COUNT", type: "integer" },
        ],
      });
      const base = { orgId, databaseId: database.id, tableId: table.id };
      const definition = {
        columnOrder: table.fields.map((field) => field.id),
        columnWidths: { [table.fields[0]!.id]: 220 },
        frozenColumns: 1,
        hiddenColumns: [table.fields[1]!.id],
        query: {
          where: { field: "COUNT", op: "eq", value: 0 },
          orderBy: [{ field: "NAME", direction: "asc" }],
        },
      };
      const execute = (
        operation: string,
        actor: Actor,
        input: Record<string, unknown>,
        key = newId(),
      ) =>
        service.execute(
          operation,
          actor,
          { ...base, ...input },
          { idempotencyKey: key },
        );
      const create = (
        actor: Actor,
        name: string,
        visibility = "personal",
        key = newId(),
      ) =>
        execute(
          "createSavedView",
          actor,
          {
            name,
            visibility,
            definition,
            expectedSchemaVersion: table.schemaVersion,
          },
          key,
        ) as Promise<SavedView>;
      const key = newId();
      const personal = await create(owner, " Needs review ", "personal", key);
      assert.equal(personal.name, "Needs review");
      assert.deepEqual(
        await create(owner, " Needs review ", "personal", key),
        personal,
      );
      for (const stranger of [member, viewer, admin]) {
        assert.deepEqual(await execute("listSavedViews", stranger, {}), {
          data: [],
        });
        await assert.rejects(
          () => execute("getSavedView", stranger, { viewId: personal.id }),
          failure("RESOURCE_NOT_FOUND"),
        );
        await assert.rejects(
          () =>
            execute("updateSavedView", stranger, {
              viewId: personal.id,
              expectedSchemaVersion: table.schemaVersion,
              expectedVersion: personal.version,
              name: "Private probe",
            }),
          failure("RESOURCE_NOT_FOUND"),
        );
      }
      const shared = await create(owner, "Team review", "shared");
      const listed = (await execute("listSavedViews", member, {})) as {
        data: { id: string; canEdit: boolean }[];
      };
      assert.deepEqual(
        listed.data.map((view) => view.id),
        [shared.id],
      );
      assert.equal(listed.data[0]!.canEdit, false);
      assert.equal(
        (
          (await execute("getSavedView", admin, {
            viewId: shared.id,
          })) as SavedView
        ).canEdit,
        true,
      );
      await assert.rejects(
        () =>
          execute("updateSavedView", member, {
            viewId: shared.id,
            expectedSchemaVersion: table.schemaVersion,
            expectedVersion: "1",
            name: "Not owner",
          }),
        failure("ACCESS_DENIED"),
      );
      await create(viewer, "Viewer's view");
      await assert.rejects(
        () => create(viewer, "Publish denied", "shared"),
        failure("FORBIDDEN"),
      );
      const credential = (await service.execute(
        "createPersonalKey",
        admin,
        {
          orgId,
          name: "Read-only views",
          access: "read",
          includeAdmin: false,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        { idempotencyKey: newId() },
      )) as { key: { id: string }; secret: string };
      const reader = (await service.resolveActor(
        new Request(`${config.baseURL}/v1/me`, {
          headers: { authorization: `Bearer ${credential.secret}` },
        }),
        "api",
      ))!;
      assert.equal(reader.role, "viewer");
      assert.equal(
        (
          (await execute("getSavedView", reader, {
            viewId: shared.id,
          })) as SavedView
        ).canEdit,
        false,
      );
      await create(reader, "Reader personal");
      await assert.rejects(
        () => create(reader, "Reader cannot publish", "shared"),
        failure("FORBIDDEN"),
      );
      await service.execute(
        "revokePersonalKey",
        admin,
        { orgId, id: credential.key.id },
        { idempotencyKey: newId() },
      );
      await assert.rejects(
        () => execute("getSavedView", reader, { viewId: shared.id }),
        failure("UNAUTHENTICATED"),
      );
      const changed = (await execute("updateSavedView", admin, {
        viewId: shared.id,
        expectedSchemaVersion: table.schemaVersion,
        expectedVersion: shared.version,
        name: "Team renamed",
      })) as SavedView;
      assert.equal(changed.version, "2");
      await assert.rejects(
        () =>
          execute("updateSavedView", admin, {
            viewId: shared.id,
            expectedSchemaVersion: table.schemaVersion,
            expectedVersion: "2",
            visibility: "personal",
          }),
        failure("ACCESS_DENIED"),
      );
      await assert.rejects(
        () =>
          execute("updateSavedView", owner, {
            viewId: shared.id,
            expectedSchemaVersion: table.schemaVersion,
            expectedVersion: shared.version,
            name: "Stale rename",
          }),
        failure("VIEW_VERSION_CONFLICT"),
      );
      const deletedKey = newId(),
        remove = { viewId: shared.id, expectedVersion: changed.version };
      const deleted = await execute(
        "deleteSavedView",
        admin,
        remove,
        deletedKey,
      );
      assert.deepEqual(
        await execute("deleteSavedView", admin, remove, deletedKey),
        deleted,
      );
      await assert.rejects(
        () => execute("getSavedView", owner, { viewId: shared.id }),
        failure("RESOURCE_NOT_FOUND"),
      );
      const race = await Promise.allSettled([
        create(owner, "Race"),
        create(owner, "race"),
      ]);
      assert.equal(
        race.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.ok(
        race.some(
          (result) =>
            result.status === "rejected" &&
            failure("VIEW_NAME_CONFLICT")(result.reason),
        ),
      );
      const concurrent = await create(owner, "Concurrent edit");
      const edits = await Promise.allSettled(
        ["First edit", "Second edit"].map((name) =>
          execute("updateSavedView", owner, {
            viewId: concurrent.id,
            expectedSchemaVersion: table.schemaVersion,
            expectedVersion: concurrent.version,
            name,
          }),
        ),
      );
      assert.equal(
        edits.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.ok(
        edits.some(
          (result) =>
            result.status === "rejected" &&
            failure("VIEW_VERSION_CONFLICT")(result.reason),
        ),
      );
      await storage.updateField(owner, table.id, table.fields[0]!.id, {
        name: "RENAMED",
        expectedSchemaVersion: table.schemaVersion,
        idempotencyKey: newId(),
      });
      table = await storage.getTable(owner, table.id);
      const renamed = (await execute("getSavedView", owner, {
        viewId: personal.id,
      })) as SavedView;
      assert.deepEqual(renamed.validationErrors, []);
      assert.equal(
        renamed.definition.query.orderBy?.[0]?.field,
        table.fields[0]!.id,
      );
      await storage.deleteField(owner, table.id, table.fields[1]!.id, {
        expectedSchemaVersion: table.schemaVersion,
        idempotencyKey: newId(),
      });
      table = await storage.getTable(owner, table.id);
      const broken = (await execute("getSavedView", owner, {
        viewId: personal.id,
      })) as SavedView;
      assert.equal(broken.validationErrors.length, 1);
      assert.deepEqual(
        broken.definition.query.where,
        personal.definition.query.where,
      );
      assert.deepEqual(broken.definition.hiddenColumns, []);
      const fixed = (await execute("updateSavedView", owner, {
        viewId: personal.id,
        expectedSchemaVersion: table.schemaVersion,
        expectedVersion: personal.version,
        definition: { ...broken.definition, query: {} },
      })) as SavedView;
      assert.deepEqual(fixed.validationErrors, []);
      assert.equal(fixed.schemaVersion, table.schemaVersion);
      await withOrg(fixture.owner, orgId, (client) =>
        client.query(
          "UPDATE rootset_control.memberships SET role='viewer',version=version+1 WHERE org_id=$1 AND user_id=$2",
          [orgId, owner.userId],
        ),
      );
      const own = (await execute("updateSavedView", owner, {
        viewId: personal.id,
        expectedSchemaVersion: table.schemaVersion,
        expectedVersion: fixed.version,
        name: "Personal after downgrade",
      })) as SavedView;
      assert.equal(own.canEdit, true);
      await assert.rejects(
        () =>
          execute("updateSavedView", owner, {
            viewId: personal.id,
            expectedSchemaVersion: table.schemaVersion,
            expectedVersion: own.version,
            visibility: "shared",
          }),
        failure("FORBIDDEN"),
      );
      await withOrg(fixture.owner, orgId, (client) =>
        client.query(
          "DELETE FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
          [orgId, owner.userId],
        ),
      );
      await assert.rejects(
        () => execute("getSavedView", owner, { viewId: personal.id }),
        failure("UNAUTHENTICATED"),
      );
      const quotaTable = await storage.createTable(admin, database.id, {
        name: "View limits",
        fields: [{ name: "NAME", type: "text" }],
      });
      const quotaDefinition = {
        columnOrder: [quotaTable.fields[0]!.id],
        columnWidths: {},
        frozenColumns: 0,
        hiddenColumns: [],
        query: {},
      };
      await withOrg(fixture.owner, orgId, async (client) => {
        for (const visibility of ["personal", "shared"])
          await client.query(
            "INSERT INTO rootset_control.saved_views(id,org_id,table_id,owner_user_id,owner_name_snapshot,name,visibility,definition,schema_version) SELECT id,$2,$3,$4,'Limit owner',$5||ordinal::text,$5,$6::jsonb,1 FROM unnest($1::varchar[]) WITH ORDINALITY AS seed(id,ordinal)",
            [
              Array.from({ length: 99 }, () => newId()),
              orgId,
              quotaTable.id,
              admin.userId,
              visibility,
              JSON.stringify(quotaDefinition),
            ],
          );
      });
      for (const visibility of ["personal", "shared"]) {
        const actors =
          visibility === "shared" ? [admin, member] : [admin, admin];
        const results = await Promise.allSettled(
          actors.map((actor, index) =>
            execute("createSavedView", actor, {
              tableId: quotaTable.id,
              expectedSchemaVersion: 1,
              name: "Last slot " + index,
              visibility,
              definition: quotaDefinition,
            }),
          ),
        );
        assert.equal(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        assert.ok(
          results.some(
            (result) =>
              result.status === "rejected" &&
              failure("CAPACITY_LIMIT")(result.reason),
          ),
        );
      }
      await execute("createSavedView", member, {
        tableId: quotaTable.id,
        expectedSchemaVersion: 1,
        name: "Independent personal scope",
        visibility: "personal",
        definition: quotaDefinition,
      });
      assert.equal(
        (
          (await execute("listSavedViews", admin, {
            tableId: quotaTable.id,
          })) as { data: unknown[] }
        ).data.length,
        200,
      );
      assert.equal(
        (
          (await execute("listSavedViews", viewer, {
            tableId: quotaTable.id,
          })) as { data: unknown[] }
        ).data.length,
        100,
      );
    } finally {
      await fixture.close();
    }
  },
);
