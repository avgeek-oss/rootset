import { workspaceInput } from "../../../tools/verification/workspace-input";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  ActivityPageSchema,
  ActivityFilterOptionsSchema,
  ActivityDetailsSchema,
  activityEventCatalog,
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
      // Reader redaction remains covered separately from the admin-only public audit API.
      const audit = async (
        operation:
          "listActivity" | "getActivityDetails" | "listActivityFilterOptions",
        actor: Actor,
        input: Record<string, unknown>,
        context = {},
      ) => {
        const scoped = workspaceInput(operation, actor, { orgId, ...input });
        if (actor.role === "admin")
          return runtime.core.execute(operation, actor, scoped, context);
        const current = {
          ...(await runtime.identity.refreshActor(actor)),
          workspaceId: orgId,
        };
        if (operation === "listActivity")
          return runtime.core.activity.list(current, scoped, context);
        if (operation === "getActivityDetails")
          return runtime.core.activity.details(current, scoped, context);
        return runtime.core.activity.filters(current, scoped, context);
      };
      const list = async (
        input: Record<string, unknown> = {},
        actor = admin,
        context = {},
      ) =>
        ActivityPageSchema.parse(
          await audit("listActivity", actor, input, context),
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
      const details = async (eventId: string, actor = admin, context = {}) =>
        ActivityDetailsSchema.parse(
          await audit("getActivityDetails", actor, { eventId }, context),
        );
      const filters = async (
        kind: "actors" | "resources",
        input: Record<string, unknown> = {},
        actor = admin,
        context = {},
      ) =>
        ActivityFilterOptionsSchema.parse(
          await audit(
            "listActivityFilterOptions",
            actor,
            { kind, ...input },
            context,
          ),
        );
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
        const failedBackupId = newId();
        await c.query(
          "INSERT INTO rootset_control.database_backups(id,org_id,database_id,kind,trigger,scheduled_at,bucket,prefix,backend_id) VALUES($1,$2,$3,'backup','manual',now(),'backups','','test')",
          [failedBackupId, orgId, database.id],
        );
        for (const kind of ["overdue", "failed"])
          await c.query(
            "INSERT INTO rootset_control.backup_alerts(id,org_id,database_id,kind,backup_id,occurrence_at,resolved_at) VALUES($1,$2,$3,$4,$5,now()-interval '2 hours',now())",
            [
              newId(),
              orgId,
              database.id,
              kind,
              kind === "failed" ? failedBackupId : null,
            ],
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
          const avatarHash = createHash("sha256")
            .update(`${member.userId!.toLowerCase()}@example.test`)
            .digest("hex");
          assert.equal(
            mutation[0]!.actor.avatarUrl,
            `https://www.gravatar.com/avatar/${avatarHash}?s=160&d=404&r=g`,
          );
          assert.equal(
            page.data.find((event) => event.id.startsWith("a:"))!.actor
              .avatarUrl,
            null,
          );
          assert.deepEqual(
            page.data
              .filter((event) => event.jobId === importId)
              .map((event) => event.status)
              .sort(),
            ["failed", "requested", "requested", "succeeded"],
          );
          assert.deepEqual(
            page.data
              .filter((event) => event.jobId === importId)
              .map((event) => event.summary)
              .sort(),
            [
              "Record import completed",
              "Record import failed",
              "Record import requested",
              "Record import requested",
            ],
          );
          assert.deepEqual(
            page.data
              .filter((event) => event.id.startsWith("a:"))
              .map((event) => event.summary)
              .sort(),
            [
              "Backup failure detected",
              "Backup failure resolved",
              "Backup overdue detected",
              "Backup overdue resolved",
            ],
          );
          const publicJson = JSON.stringify(page);
          for (const event of page.data) {
            assert.equal(
              activityEventCatalog[event.event]!.label,
              event.summary,
            );
            assert.ok(activityEventCatalog[event.event]!.icon);
          }
          assert.ok(
            !/hidden-|example.test|scopes|input_digest|operatorRepair|private-view/.test(
              publicJson,
            ),
          );
          const cancelled = page.data.find(
            (event) => event.jobId === exportId && event.status === "cancelled",
          )!;
          assert.equal(cancelled.destination, "exports");
          assert.equal(cancelled.summary, "View export cancelled");
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
          for (const summary of [
            "Record import requested",
            "Record import completed",
            "Record import failed",
            "View export cancelled",
            "Backup overdue detected",
            "Backup overdue resolved",
            "Backup failure detected",
            "Backup failure resolved",
          ]) {
            const matches = await list({ q: summary });
            assert.ok(matches.data.length, summary);
            assert.ok(matches.data.every((event) => event.summary === summary));
          }
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
            workspaceInput("createPersonalKey", admin, {
              orgId,
              name: "Activity reader",
              access: "read",
              includeAdmin: false,
              expiresAt: "2030-01-01T00:00:00.000Z",
            }),
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
      await t.test("partial completion is a searchable event", async () => {
        const partialId = await job("importRows");
        await withOrg(fixture.app, orgId, (c) =>
          c.query(
            "UPDATE rootset_control.jobs SET state='partially_completed',completed_at=now() WHERE id=$1",
            [partialId],
          ),
        );
        const page = await list({ q: "Record import partially completed" });
        assert.equal(page.data.length, 1);
        assert.equal(page.data[0]!.jobId, partialId);
        assert.equal(page.data[0]!.status, "partially_completed");
        assert.equal(
          page.data[0]!.summary,
          "Record import partially completed",
        );
      });
      await t.test(
        "exact event, actor and resource filters apply before pagination and combine",
        async () => {
          const input = {
            event: "job.importRows.queued",
            actor: `user:${member.userId}`,
            resource: `table:${table.id}`,
            limit: 1,
          };
          const first = await list(input);
          assert.equal(first.data.length, 1);
          assert.equal(first.hasMore, true);
          const second = await list({ ...input, cursor: first.nextCursor });
          assert.notEqual(first.data[0]!.id, second.data[0]!.id);
          for (const event of [...first.data, ...second.data]) {
            assert.equal(event.event, input.event);
            assert.equal(event.actor.key, input.actor);
            assert.equal(event.table?.id, table.id);
          }
          assert.equal(
            (await list({ ...input, actor: `user:${admin.userId}` })).data
              .length,
            0,
          );
          const dbOnly = await list({ resource: `database:${database.id}` });
          assert.ok(dbOnly.data.length);
          assert.ok(
            dbOnly.data.every(
              (event) => !event.table && event.database?.id === database.id,
            ),
          );
          const secondSession = newId();
          await fixture.owner.query(
            "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at,authenticated_at) VALUES($1,$2,$3,now()+interval '1 day',now())",
            [secondSession, member.userId, newId()],
          );
          await runtime.storage.createRow(
            { ...member, id: secondSession },
            table.id,
            { NAME: "another session", COUNT: 2 },
          );
          const samePerson = await list({
            actor: `user:${member.userId}`,
            category: "records",
          });
          assert.equal(samePerson.data.length, 2);
          assert.deepEqual(
            new Set(samePerson.data.map((event) => event.actor.id)),
            new Set([member.id, secondSession]),
          );
        },
      );
      await t.test(
        "filter options cover retained history beyond the event page without disclosing inaccessible events",
        async () => {
          const actors = await filters("actors");
          assert.ok(
            actors.data.some(
              (option) => option.value === `user:${other.userId}`,
            ),
          );
          const memberActors = await filters("actors", {}, member);
          assert.ok(
            memberActors.data.some(
              (option) => option.value === `user:${member.userId}`,
            ),
          );
          assert.ok(
            memberActors.data.every(
              (option) =>
                option.value !== `user:${other.userId}` &&
                option.value !== "automation",
            ),
          );
          const resources = await filters("resources");
          const lastDatabase = await runtime.storage.createDatabase(admin, {
            name: "Zulu database",
          });
          const databasesFirst = await filters("resources", { limit: 2 });
          assert.equal(databasesFirst.data.length, 2);
          assert.ok(
            databasesFirst.data.every((option) => option.kind === "database"),
          );
          assert.equal(
            databasesFirst.data[1]!.value,
            `database:${lastDatabase.id}`,
          );
          assert.equal(databasesFirst.hasMore, true);
          assert.ok(
            resources.data.some(
              (option) =>
                option.value === `table:${table.id}` &&
                option.kind === "table" &&
                option.description === "Activity database",
            ),
          );
          assert.ok(
            resources.data.some(
              (option) =>
                option.value === `database:${database.id}` &&
                option.kind === "database",
            ),
          );
          assert.equal((await filters("actors", { limit: 1 })).hasMore, true);
          const search = await filters("actors", {
            q: "admin author",
            limit: 1,
          });
          assert.equal(search.data[0]!.value, `user:${admin.userId}`);
          assert.equal(search.hasMore, false);
          assert.equal(
            (await filters("resources", { q: "Aircraft" })).data[0]!.value,
            `table:${table.id}`,
          );
          assert.ok(
            (await filters("resources", { q: "Activity database" })).data.some(
              (option) => option.value === `table:${table.id}`,
            ),
          );
          assert.equal(
            (await filters("actors", { q: "hidden-job-payload" })).data.length,
            0,
          );
          assert.ok(!/example.test|hidden-/.test(JSON.stringify(actors)));
          await assert.rejects(
            filters("actors", {}, admin, { responseBudget: 10 }),
            { code: "RESULT_TOO_LARGE" },
          );
          const abort = new AbortController();
          abort.abort();
          await assert.rejects(
            filters("resources", {}, admin, { signal: abort.signal }),
            { code: "REQUEST_TIMEOUT" },
          );
        },
      );
      await t.test(
        "automation actors share one filter before users and retain their provenance without avatar URLs",
        async () => {
          const automationOwner = await person("member");
          await fixture.owner.query(
            "UPDATE rootset_control.users SET name='Zulu automation' WHERE id=$1",
            [automationOwner.userId],
          );
          await withOrg(fixture.app, orgId, (c) =>
            c.query(
              "INSERT INTO rootset_control.resource_history(org_id,database_id,resource_id,operation,actor,context) VALUES($1,$2,$2,'database.backup.prune',$3,'{}')",
              [
                orgId,
                database.id,
                {
                  kind: "operator",
                  id: "backup-retention",
                  userId: automationOwner.userId,
                },
              ],
            ),
          );
          const first = await filters("actors", { limit: 1 });
          assert.deepEqual(first.data, [
            {
              value: "automation",
              label: "Automation",
              kind: "actor",
              avatarUrl: null,
              description: "automation",
            },
          ]);
          assert.equal(first.hasMore, true);
          const automation = await filters("actors", { q: "Automation" });
          assert.deepEqual(automation.data, first.data);
          assert.equal(automation.hasMore, false);
          const automated = await list({ actor: "automation" });
          assert.deepEqual(
            new Set(automated.data.map((event) => event.actor.kind)),
            new Set(["operator", "system"]),
          );
          assert.ok(
            automated.data.every(
              (event) =>
                event.actor.key === "automation" &&
                event.actor.name === "Automation" &&
                event.actor.avatarUrl === null,
            ),
          );
          const automatedPage = await list({ actor: "automation", limit: 1 });
          assert.equal(automatedPage.hasMore, true);
          const nextAutomatedPage = await list({
            actor: "automation",
            limit: 1,
            cursor: automatedPage.nextCursor,
          });
          assert.equal(nextAutomatedPage.data[0]!.actor.key, "automation");
          assert.notEqual(
            automatedPage.data[0]!.id,
            nextAutomatedPage.data[0]!.id,
          );
          assert.equal(
            (await list({ actor: `user:${automationOwner.userId}` })).data
              .length,
            0,
          );
          const events = await list({ event: "database.backup.prune" });
          assert.equal(events.data.length, 1);
          assert.equal(events.data[0]!.actor.name, "Automation");
          assert.equal(events.data[0]!.actor.id, "backup-retention");
          assert.equal(events.data[0]!.actor.kind, "operator");
          assert.equal(events.data[0]!.actor.avatarUrl, null);
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
            { event: "job.importRows.queued" },
            { actor: `user:${member.userId}` },
            { resource: `table:${table.id}` },
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
        "event details retain schema context, redact payloads and apply the same access as the list",
        async () => {
          const auditTable = await runtime.storage.createTable(
            admin,
            database.id,
            {
              name: "Audit context",
              fields: [
                { name: "FIRST", type: "text" },
                { name: "SECOND", type: "integer" },
              ],
            },
          );
          const reordered = await runtime.storage.reorderFields(
            admin,
            auditTable.id,
            {
              fieldIds: auditTable.fields.map((field) => field.id).reverse(),
              expectedSchemaVersion: auditTable.schemaVersion,
            },
          );
          const reorderEvent = (
            await list({ tableId: auditTable.id, event: "fields.reorder" })
          ).data[0]!;
          const renamed = await runtime.storage.updateField(
            admin,
            auditTable.id,
            reordered.fields[0]!.id,
            {
              name: "RENAMED",
              expectedSchemaVersion: reordered.schemaVersion,
            },
          );
          const reorderDetails = await details(reorderEvent.id);
          assert.deepEqual(reorderDetails.context.fieldOrder, {
            before: auditTable.fields.map(({ name }) => name),
            after: [...auditTable.fields].reverse().map(({ name }) => name),
          });
          const rule = await runtime.storage.createUniqueRule(
            admin,
            auditTable.id,
            {
              name: "Unique first",
              expectedSchemaVersion: renamed.schemaVersion,
              fieldIds: [auditTable.fields[0]!.id],
            },
          );
          const ruleEvent = (
            await list({ tableId: auditTable.id, event: "rule.create" })
          ).data[0]!;
          assert.deepEqual((await details(ruleEvent.id)).context.rules, [
            {
              id: rule.id,
              name: "Unique first",
              fields: [{ id: auditTable.fields[0]!.id, name: "FIRST" }],
              conditional: false,
            },
          ]);
          const page = await list({ limit: 100 });
          for (const event of page.data) {
            const result = await details(event.id);
            assert.equal(result.event, event.event);
            assert.equal(result.occurredAt, event.occurredAt);
            assert.ok(
              !/hidden-|physicalName|schemaName|input_digest|leaseToken|scopes|example.test/.test(
                JSON.stringify(result),
              ),
            );
            if (event.jobId === importId)
              assert.equal(result.context.status, event.status);
          }
          const recordEvent = page.data.find(
            (event) => event.category === "records",
          )!;
          assert.deepEqual(
            (await details(recordEvent.id)).context.fields,
            table.fields
              .map(({ id, name }) => ({ id, name }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          );
          const ownJob = page.data.find((event) => event.jobId === importId)!;
          assert.equal((await details(ownJob.id, member)).event, ownJob.event);
          const privateJob = page.data.find(
            (event) => event.jobId === otherJob,
          )!;
          await assert.rejects(details(privateJob.id, member), {
            code: "RESOURCE_NOT_FOUND",
          });
          await assert.rejects(details(ownJob.id, viewer), {
            code: "RESOURCE_NOT_FOUND",
          });
          const backupEvent = page.data.find(
            (event) => event.category === "backups",
          )!;
          await assert.rejects(details(backupEvent.id, viewer), {
            code: "RESOURCE_NOT_FOUND",
          });
          await assert.rejects(details("r:9223372036854775807"), {
            code: "RESOURCE_NOT_FOUND",
          });
          await assert.rejects(
            details(reorderEvent.id, admin, { responseBudget: 100 }),
            { code: "RESULT_TOO_LARGE" },
          );
          const abort = new AbortController();
          abort.abort();
          await assert.rejects(
            details(reorderEvent.id, admin, { signal: abort.signal }),
            { code: "REQUEST_TIMEOUT" },
          );
          await assert.rejects(
            runtime.core.execute(
              "getActivityDetails",
              admin,
              workspaceInput("getActivityDetails", admin, {
                orgId: newId(),
                eventId: reorderEvent.id,
              }),
            ),
            { code: "RESOURCE_NOT_FOUND" },
          );
          const ruleTable = await runtime.storage.getTable(
            admin,
            auditTable.id,
          );
          const withoutRule = await runtime.storage.deleteUniqueRule(
            admin,
            auditTable.id,
            rule.id,
            { expectedSchemaVersion: ruleTable.schemaVersion },
          );
          await runtime.storage.deleteTable(admin, auditTable.id, {
            expectedSchemaVersion: withoutRule.schemaVersion,
          });
          assert.equal(
            (await details(reorderEvent.id)).resource?.type,
            "table",
          );
          assert.deepEqual(
            (await details(reorderEvent.id)).context,
            reorderDetails.context,
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
            reader.list(await runtime.identity.refreshActor(member), {
              orgId,
              workspaceId: orgId,
            }),
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
          await withOrg(fixture.app, orgId, (c) =>
            c.query(
              "UPDATE rootset_control.tables SET state='maintenance' WHERE id=$1",
              [table.id],
            ),
          );
          const maintenance = await list({ tableId: table.id });
          assert.equal(maintenance.scope.table?.state, "maintenance");
          assert.ok(maintenance.data.length);
          assert.ok(
            maintenance.data.every(
              (event) =>
                event.table?.state === "maintenance" &&
                event.destination === null,
            ),
          );
          await withOrg(fixture.app, orgId, (c) =>
            c.query(
              "UPDATE rootset_control.tables SET state='active' WHERE id=$1",
              [table.id],
            ),
          );
          await runtime.storage.deleteTable(admin, table.id, {
            expectedSchemaVersion: table.schemaVersion,
          });
          const page = await list({ tableId: table.id });
          assert.ok(
            (await filters("resources")).data.some(
              (option) => option.value === `table:${table.id}`,
            ),
          );
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
