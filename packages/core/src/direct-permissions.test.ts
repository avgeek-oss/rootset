import { workspaceInput } from "../../../tools/verification/workspace-input";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { newId, type Actor } from "@rootset/contracts";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { createRuntime } from "./runtime";
import { loadConfig } from "./config";

test("direct database/table permissions, fresh identity and worker role checks", async () => {
  const fixture = await isolatedDatabase();
  const origin = "http://localhost:6315";
  const runtime = await createRuntime({
    ...loadConfig(),
    baseURL: origin,
    webURL: origin,
    databaseURL: fixture.app.options.connectionString!,
  });
  try {
    const password = randomBytes(32).toString("base64url"),
      email = `permissions-${newId().toLowerCase()}@example.test`;
    await runtime.identity.claimSetup({
      bootstrapSecret: runtime.config.bootstrapSecret,
      name: "Permission reviewer",
      email,
      password,
      organisationName: "Disposable permissions",
    });
    await fixture.owner.query(
      "UPDATE rootset_control.users SET email_verified=true WHERE email=$1",
      [email],
    );
    const login = await runtime.identity.auth.handler(
      new Request(`${origin}/v1/auth/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const session = (await runtime.identity.resolveActor(
      new Request(`${origin}/v1/auth/get-session`, { headers: { cookie } }),
      "browser",
    ))!;
    const execute = (
      actor: Actor,
      id: string,
      input: Record<string, unknown>,
      surface: "rest" | "mcp" = "rest",
    ) =>
      runtime.core.execute(id, actor, workspaceInput(id, actor, input), {
        idempotencyKey: newId(),
        surface,
      });
    const key = async (access: "read" | "edit", includeAdmin: boolean) => {
      const result = (await execute(session, "createPersonalKey", {
        orgId: session.orgId,
        name: "Permission fixture",
        access,
        includeAdmin,
        expiresAt: "2030-01-01T00:00:00.000Z",
      })) as { secret: string };
      return (await runtime.identity.resolveActor(
        new Request(`${origin}/v1`, {
          headers: { authorization: `Bearer ${result.secret}` },
        }),
        "api",
      ))!;
    };
    const editor = await key("edit", false),
      reader = await key("read", false),
      admin = await key("edit", true);
    for (const surface of ["rest", "mcp"] as const) {
      const db = (await execute(
        editor,
        "createDatabase",
        { orgId: session.orgId, name: `Editor ${surface}` },
        surface,
      )) as { id: string };
      const database = { orgId: session.orgId, databaseId: db.id };
      await execute(
        editor,
        "updateDatabase",
        { ...database, name: "Edited database" },
        surface,
      );
      const table = (await execute(
        editor,
        "createTable",
        {
          ...database,
          name: "Editor table",
          fields: [{ name: "NAME", type: "text" }],
        },
        surface,
      )) as { table: { id: string; schemaVersion: number } };
      const target = {
        ...database,
        tableId: table.table.id,
        expectedSchemaVersion: table.table.schemaVersion,
      };
      await execute(
        editor,
        "updateTable",
        { ...target, name: "Edited table" },
        surface,
      );
      for (const [operation, input] of [
        ["deleteDatabase", database],
        ["deleteTable", target],
        ["createDatabase", { orgId: session.orgId, name: "Denied" }],
      ] as const) {
        await assert.rejects(() => execute(reader, operation, input, surface), {
          code: "FORBIDDEN",
        });
        if (operation.startsWith("delete"))
          await assert.rejects(
            () => execute(editor, operation, input, surface),
            { code: "FORBIDDEN" },
          );
      }
      // A session must have server-verified recent proof; changing the supplied timestamp cannot bypass it.
      await fixture.owner.query(
        "UPDATE rootset_control.sessions SET authenticated_at=now()-interval '1 hour' WHERE id=$1",
        [session.id],
      );
      await assert.rejects(
        () =>
          execute(
            { ...session, authenticatedAt: Date.now() },
            "deleteDatabase",
            database,
            surface,
          ),
        { code: "STEP_UP_REQUIRED" },
      );
      const proof = (attempt: string) =>
        runtime.identity.auth.handler(
          new Request(`${origin}/v1/auth/reauthenticate`, {
            method: "POST",
            headers: { origin, cookie, "content-type": "application/json" },
            body: JSON.stringify({ password: attempt }),
          }),
        );
      assert.equal((await proof("incorrect password")).status, 403);
      assert.equal((await proof(password)).status, 200);
      const admitted = (await execute(
        session,
        "deleteDatabase",
        database,
        surface,
      )) as { jobId: string };
      assert.ok(admitted.jobId);
      assert.equal(await runtime.jobs.runOnce(session.orgId), true);
      assert.equal(
        (
          await fixture.owner.query(
            "SELECT state FROM rootset_control.jobs WHERE id=$1",
            [admitted.jobId],
          )
        ).rows[0].state,
        "succeeded",
      );
    }
    // Admin bearer credentials need no browser approval and workers recheck their role before publication.
    const db = (await execute(editor, "createDatabase", {
      orgId: session.orgId,
      name: "Worker authority",
    })) as { id: string };
    const table = (await execute(editor, "createTable", {
      orgId: session.orgId,
      databaseId: db.id,
      name: "Worker table",
    })) as { table: { id: string; schemaVersion: number } };
    const deletion = (await execute(admin, "deleteTable", {
      orgId: session.orgId,
      databaseId: db.id,
      tableId: table.table.id,
      expectedSchemaVersion: table.table.schemaVersion,
    })) as { jobId: string };
    await fixture.owner.query(
      "UPDATE rootset_control.memberships SET role='member',version=version+1 WHERE user_id=$1",
      [session.userId],
    );
    assert.equal(await runtime.jobs.runOnce(session.orgId), true);
    const blocked = (
      await fixture.owner.query(
        "SELECT state,error FROM rootset_control.jobs WHERE id=$1",
        [deletion.jobId],
      )
    ).rows[0];
    assert.equal(blocked.state, "failed");
    assert.equal(blocked.error.code, "FORBIDDEN");
    await runtime.storage.getTable(
      await runtime.identity.refreshActor(editor),
      table.table.id,
    );
    assert.equal(
      (
        await fixture.owner.query(
          "SELECT to_regclass('rootset_control.account_actions') AS legacy",
        )
      ).rows[0].legacy,
      null,
    );
  } finally {
    await runtime.close();
    await fixture.close();
  }
});
