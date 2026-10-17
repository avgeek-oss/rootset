import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActivityPageSchema,
  newId,
  RootsetError,
  type Actor,
  type Role,
} from "@rootset/contracts";
import { withOrg } from "@rootset/database";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { createRuntime } from "./runtime";
import { loadConfig } from "./config";
import { ActivityReader } from "./activity";

test(
  "activity combines retained histories and durable job transitions with current access, redaction and bound paging",
  { skip: !process.env.ROOTSET_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await isolatedDatabase();
    const runtime = await createRuntime({
      ...loadConfig(),
      databaseURL: fixture.app.options.connectionString!,
    });
    const orgId = newId();
    try {
      await fixture.owner.query(
        "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Activity')",
        [orgId],
      );
      async function person(role: Role): Promise<Actor> {
        const userId = newId(),
          sessionId = newId();
        await fixture.owner.query(
          "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
          [userId, `${role} author`, `${userId.toLowerCase()}@example.test`],
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
        other = await person("member"),
        viewer = await person("viewer");
      const database = await runtime.storage.createDatabase(admin, {
        name: "Activity database",
      });
      const table = await runtime.storage.createTable(admin, database.id, {
        name: "Aircraft",
        fields: [
          { name: "NAME", type: "text" },
          { name: "COUNT", type: "integer" },
        ],
      });
      const record = await runtime.storage.createRow(member, table.id, {
        NAME: "hidden-cell-value",
        COUNT: 0,
      });
      const list = async (
        input: Record<string, unknown> = {},
        actor = admin,
        context = {},
      ) =>
        ActivityPageSchema.parse(
          await runtime.core.execute(
            "listActivity",
            actor,
            { orgId, ...input },
            context,
          ),
        );
      const job = async (operation: string, actor = member) => {
        const id = newId();
        await withOrg(fixture.app, orgId, (c) =>
          c.query(
            "INSERT INTO rootset_control.jobs(id,org_id,kind,operation_id,actor,requester_id,target_type,target_id,input,input_digest,idempotency_key) VALUES($1,$2,'import',$3,$4,$5,'table',$6,$7,'digest',$8)",
            [
              id,
              orgId,
              operation,
              JSON.stringify(actor),
              `${actor.kind}:${actor.id}`,
              table.id,
              JSON.stringify({
                fileName: "aircraft.csv",
                rawSecret: "hidden-job-payload",
              }),
              newId(),
            ],
          ),
        );
        return id;
      };
      const importId = await job("importRows"),
        otherJob = await job("exportRows", other),
        exportId = await job("exportView");
      await withOrg(fixture.app, orgId, async (c) => {
        await c.query(
          "UPDATE rootset_control.jobs SET state='running',attempt=1 WHERE id=$1",
          [importId],
        );
        await c.query(
          "UPDATE rootset_control.jobs SET state='failed',completed_at=now(),error='{\"message\":\"hidden-provider-password\"}' WHERE id=$1",
          [importId],
        );
        await c.query(
          "UPDATE rootset_control.jobs SET state='queued',completed_at=NULL,error=NULL WHERE id=$1",
          [importId],
        );
        await c.query(
          "UPDATE rootset_control.jobs SET state='running',attempt=2 WHERE id=$1",
          [importId],
        );
        await c.query(
          "UPDATE rootset_control.jobs SET state='succeeded',completed_at=now() WHERE id=$1",
          [importId],
        );
        await c.query(
          "UPDATE rootset_control.jobs SET state='cancelled',completed_at=now() WHERE id=$1",
          [exportId],
        );
        await c.query(
          "INSERT INTO rootset_control.backup_policies(org_id,database_id) VALUES($1,$2)",
          [orgId, database.id],
        );
        await c.query(
          "INSERT INTO rootset_control.backup_alerts(id,org_id,database_id,kind,occurrence_at) VALUES($1,$2,$3,'overdue',now()-interval '2 hours')",
          [newId(), orgId, database.id],
        );
        for (const operation of [
          "database.backup_policy.update",
          "database.restore",
          "private-view.secret",
          "operatorRepair",
        ]) {
          await c.query(
            "INSERT INTO rootset_control.resource_history(org_id,database_id,resource_id,operation,actor,context,after_value) VALUES($1,$2,$2,$3,$4,'{}','{\"secret\":\"hidden-resource-payload\"}')",
            [orgId, database.id, operation, JSON.stringify(admin)],
          );
        }
      });
      await t.test(
        "every family, one event per mutation and distinct retries without raw values",
        async () => {
          const page = await list();
          assert.deepEqual(
            new Set(page.data.map((event) => event.category)),
            new Set([
              "schema",
              "records",
              "imports",
              "exports",
              "backups",
              "restores",
            ]),
          );
          const mutation = page.data.filter(
            (event) => event.category === "records",
          );
          assert.equal(mutation.length, 1);
          assert.equal(mutation[0]!.affectedRows, 1);
          assert.equal(mutation[0]!.rowId, record.id);
          assert.equal(mutation[0]!.destination, "record");
          assert.equal(mutation[0]!.actor.name, "member author");
          assert.deepEqual(
            page.data
              .filter((event) => event.jobId === importId)
              .map((event) => event.status)
              .sort(),
            ["failed", "requested", "requested", "succeeded"],
          );
          const publicJson = JSON.stringify(page);
          assert.ok(
            !/hidden-|example.test|scopes|input_digest|operatorRepair|private-view/.test(
              publicJson,
            ),
          );
          assert.equal(
            page.data.find(
              (event) =>
                event.jobId === exportId && event.status === "cancelled",
            )!.destination,
            "exports",
          );
        },
      );
      await t.test(
        "search, scope, type, dates and permission filtering precede pagination",
        async () => {
          const searched = await list({
            q: "aircraft.csv",
            category: "imports",
          });
          assert.equal(searched.data.length, 4);
          assert.ok(
            searched.data.every((event) => event.fileName === "aircraft.csv"),
          );
          assert.ok(
            (await list({ q: "member author", category: "records" })).data
              .length,
          );
          assert.equal((await list({ q: "hidden-cell-value" })).data.length, 0);
          assert.ok(
            (await list({ tableId: table.id })).data.every(
              (event) => event.table?.id === table.id,
            ),
          );
          assert.equal(
            (await list({ from: "2099-01-01T00:00:00.000Z" })).data.length,
            0,
          );
          const memberPage = await list({}, member);
          assert.ok(memberPage.data.some((event) => event.jobId === importId));
          assert.ok(
            memberPage.data.every(
              (event) =>
                event.jobId !== otherJob &&
                !["backups", "restores"].includes(event.category),
            ),
          );
          const viewerPage = await list({}, viewer);
          assert.deepEqual(
            new Set(viewerPage.availableCategories),
            new Set(["schema", "records", "exports"]),
          );
          assert.ok(viewerPage.data.every((event) => !event.jobId));
          await assert.rejects(list({ category: "backups" }, viewer), {
            code: "FORBIDDEN",
          });
          const key = (await runtime.core.execute(
            "createPersonalKey",
            admin,
            {
              orgId,
              name: "Activity reader",
              access: "read",
              includeAdmin: false,
              expiresAt: "2030-01-01T00:00:00.000Z",
            },
            { idempotencyKey: newId() },
          )) as { key: { id: string }; secret: string };
          const credential = await runtime.identity.resolveActor(
            new Request("http://localhost:4310/v1", {
              headers: { authorization: `Bearer ${key.secret}` },
            }),
            "api",
          );
          assert(credential);
          const credentialPage = await list({}, credential);
          assert.equal(
            credentialPage.availableCategories.includes("backups"),
            false,
          );
          assert.ok(
            credentialPage.data.every(
              (event) => event.category !== "imports" && !event.jobId,
            ),
          );
          await withOrg(fixture.app, orgId, (c) =>
            c.query(
              "UPDATE rootset_control.api_keys SET revoked_at=now() WHERE id=$1",
              [key.key.id],
            ),
          );
          await assert.rejects(list({}, credential), {
            code: "UNAUTHENTICATED",
          });
        },
      );
      await t.test(
        "microsecond ties, newer writes, cursor tamper and all principal/filter bindings",
        async () => {
          await withOrg(fixture.app, orgId, (c) =>
            c.query(
              "UPDATE rootset_control.activity_job_events SET occurred_at='2026-01-01T01:02:03.123456Z' WHERE job_id=ANY($1)",
              [[importId, otherJob, exportId]],
            ),
          );
          const expected = (await list({ limit: 100 })).data.map(
            (event) => event.id,
          );
          let page = await list({ limit: 2 });
          const first = page;
          const seen = page.data.map((event) => event.id);
          await runtime.storage.createRow(member, table.id, {
            NAME: "newer",
            COUNT: 1,
          });
          assert.deepEqual(
            (await list({ limit: 2, cursor: first.startCursor })).data,
            first.data,
          );
          while (page.hasMore) {
            page = await list({ limit: 2, cursor: page.nextCursor });
            seen.push(...page.data.map((event) => event.id));
          }
          assert.deepEqual(seen, expected);
          assert.equal(new Set(seen).size, seen.length);
          assert.ok(first.nextCursor);
          for (const input of [
            { limit: 3 },
            { q: "Aircraft" },
            { category: "imports" },
            { tableId: table.id },
            { from: "2020-01-01T00:00:00.000Z" },
          ])
            await assert.rejects(
              list({ limit: 2, cursor: first.nextCursor, ...input }),
              { code: "CURSOR_INVALID" },
            );
          await assert.rejects(
            list({ limit: 2, cursor: first.nextCursor }, member),
            { code: "CURSOR_INVALID" },
          );
          await assert.rejects(
            list({ limit: 2, cursor: first.nextCursor!.slice(0, -3) + "abc" }),
            { code: "CURSOR_INVALID" },
          );
        },
      );
      await t.test(
        "bounded responses, cancellation and access changes discard the read",
        async () => {
          const first = await list({ limit: 100 }, admin, {
            responseBudget: 2400,
          });
          assert.ok(
            first.hasMore && first.data.length > 0 && first.data.length < 10,
          );
          await assert.rejects(list({}, admin, { responseBudget: 100 }), {
            code: "RESULT_TOO_LARGE",
          });
          const abort = new AbortController();
          abort.abort();
          await assert.rejects(list({}, admin, { signal: abort.signal }), {
            code: "REQUEST_TIMEOUT",
          });
          let reads = 0;
          const reader = new ActivityReader({
            pool: fixture.app,
            secret: runtime.config.cursorSecret,
            refreshActor: async (actor, client) => {
              if (++reads === 2)
                await withOrg(fixture.owner, orgId, (c) =>
                  c.query(
                    "UPDATE rootset_control.memberships SET role='viewer',version=version+1 WHERE user_id=$1",
                    [member.userId],
                  ),
                );
              return runtime.identity.refreshActor(actor, client);
            },
          });
          await assert.rejects(
            reader.list(await runtime.identity.refreshActor(member), { orgId }),
            { code: "FORBIDDEN" },
          );
          await withOrg(fixture.owner, orgId, (c) =>
            c.query(
              "DELETE FROM rootset_control.memberships WHERE user_id=$1",
              [other.userId],
            ),
          );
          await assert.rejects(list({}, other), { code: "UNAUTHENTICATED" });
        },
      );
      await t.test(
        "archived resources retain allowed metadata without live links or deleted record history",
        async () => {
          await runtime.storage.deleteTable(admin, table.id, {
            expectedSchemaVersion: table.schemaVersion,
          });
          const page = await list({ tableId: table.id });
          assert.equal(page.scope.table?.state, "deleted");
          assert.ok(page.data.length);
          assert.ok(
            page.data.every(
              (event) =>
                event.destination === null && event.category !== "records",
            ),
          );
          const wrong = await runtime.storage.createDatabase(admin, {
            name: "Unrelated",
          });
          await assert.rejects(
            list({ tableId: table.id, databaseId: wrong.id }),
            { code: "RESOURCE_NOT_FOUND" },
          );
          await assert.rejects(
            list({ orgId: newId() }),
            (error) => error instanceof RootsetError && error.status === 404,
          );
        },
      );
    } finally {
      await runtime.close();
      await fixture.close();
    }
  },
);
