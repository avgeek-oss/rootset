import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import {
  getOperation,
  newId,
  type Actor,
  type Workspace,
} from "@rootset/contracts";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { createRuntime } from "./runtime";
import { loadConfig } from "./config";

let fixture: Awaited<ReturnType<typeof isolatedDatabase>>;
let runtime: Awaited<ReturnType<typeof createRuntime>>;
const orgId = newId();
const actors = {} as Record<"admin" | "peer" | "member" | "viewer", Actor>;
const call = (
  who: Actor,
  operation: string,
  input: Record<string, unknown> = {},
  key = newId(),
) =>
  runtime.core.execute(
    operation,
    who,
    {
      orgId,
      ...(getOperation(operation).workspaceScoped
        ? { workspaceId: orgId }
        : {}),
      ...input,
    },
    { surface: "rest", idempotencyKey: key },
  );
const unavailable = (work: Promise<unknown>) =>
  assert.rejects(work, { code: "RESOURCE_NOT_FOUND" });
let workspace: Workspace;
let privateDatabase: { id: string };
before(async () => {
  fixture = await isolatedDatabase();
  runtime = await createRuntime({
    ...loadConfig(),
    databaseURL: fixture.owner.options.connectionString!,
  });
  await fixture.owner.query(
    "INSERT INTO rootset_control.organisations(id,name) VALUES($1,'Workspace fixture')",
    [orgId],
  );
  for (const name of ["admin", "peer", "member", "viewer"] as const) {
    const userId = newId(),
      role = name === "peer" ? "admin" : name;
    await fixture.owner.query(
      "INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,$2,$3,true)",
      [userId, name, `${userId.toLowerCase()}@example.test`],
    );
    await fixture.owner.query(
      "INSERT INTO rootset_control.memberships(id,org_id,user_id,role) VALUES($1,$2,$3,$4)",
      [newId(), orgId, userId, role],
    );
    actors[name] = {
      kind: "session",
      id: newId(),
      orgId,
      userId,
      role,
      scopes: [],
      authenticatedAt: Date.now(),
    };
    await fixture.owner.query(
      "INSERT INTO rootset_control.sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [actors[name].id, userId, newId()],
    );
  }
});
after(async () => {
  await runtime?.close();
  await fixture?.close();
});
test("Default is created atomically, shared by every role, and cannot be renamed or deleted", async () => {
  for (const actor of Object.values(actors)) {
    const result = (await call(actor, "listWorkspaces")) as {
      data: Workspace[];
    };
    assert.deepEqual(
      result.data.map((w) => [w.id, w.name, w.memberCount]),
      [[orgId, "Default", 4]],
    );
    await call(actor, "listDatabases");
  }
  await assert.rejects(
    call(actors.admin, "deleteWorkspace", { workspaceId: orgId }),
    { code: "VALIDATION_FAILED" },
  );
  await assert.rejects(
    call(actors.admin, "updateWorkspace", {
      workspaceId: orgId,
      name: "Renamed",
      description: "",
    }),
    { code: "VALIDATION_FAILED" },
  );
  await assert.rejects(
    fixture.owner.query("DELETE FROM rootset_control.workspaces WHERE id=$1", [
      orgId,
    ]),
    /Default workspace/,
  );
});
test("workspace creation is admin-only and replay-safe; team directory grants no data access", async () => {
  for (const actor of [actors.member, actors.viewer])
    await assert.rejects(
      call(actor, "createWorkspace", { name: "Denied", description: "" }),
      { code: "FORBIDDEN" },
    );
  const key = newId();
  workspace = (await call(
    actors.admin,
    "createWorkspace",
    { name: "Private", description: "Private reference data" },
    key,
  )) as Workspace;
  assert.equal(
    (
      (await call(
        actors.admin,
        "createWorkspace",
        { name: "Private", description: "Private reference data" },
        key,
      )) as Workspace
    ).id,
    workspace.id,
  );
  assert.equal(workspace.memberCount, 1);
  const peer = (await call(actors.peer, "listWorkspaces")) as {
    data: Workspace[];
  };
  assert.equal(peer.data.length, 1);
  const directory = (await call(actors.peer, "listTeamWorkspaces")) as {
    data: Workspace[];
  };
  assert.equal(directory.data.length, 2);
  const members = (await call(actors.peer, "listWorkspaceMembers", {
    workspaceId: workspace.id,
  })) as { data: { userId: string }[] };
  assert.equal(members.data[0]?.userId, actors.admin.userId);
  await unavailable(
    call(actors.peer, "getWorkspace", { workspaceId: workspace.id }),
  );
  await unavailable(
    call(actors.peer, "listDatabases", { workspaceId: workspace.id }),
  );
  await unavailable(
    call(actors.peer, "addWorkspaceMember", {
      workspaceId: workspace.id,
      userId: actors.peer.userId,
    }),
  );
});
test("database, table, audit, cursor and job boundaries stay inside the selected workspace", async () => {
  privateDatabase = (await call(actors.admin, "createDatabase", {
    workspaceId: workspace.id,
    name: "Private database",
  })) as { id: string };
  const table = (await call(actors.admin, "createTable", {
    workspaceId: workspace.id,
    databaseId: privateDatabase.id,
    name: "Private table",
    fields: [{ name: "NAME", type: "text" }],
  })) as { table: { id: string; schemaVersion: number } };
  await call(actors.admin, "createRow", {
    workspaceId: workspace.id,
    databaseId: privateDatabase.id,
    tableId: table.table.id,
    expectedSchemaVersion: table.table.schemaVersion,
    values: { NAME: "Confidential" },
  });
  for (const actor of [actors.admin, actors.peer])
    await unavailable(
      call(actor, "getDatabase", { databaseId: privateDatabase.id }),
    );
  const defaults = (await call(actors.admin, "listDatabases")) as {
    data: unknown[];
  };
  assert.equal(defaults.data.length, 0);
  const logs = (await call(actors.admin, "listActivity", {
    workspaceId: workspace.id,
  })) as { data: { id: string }[] };
  assert.ok(logs.data.length);
  const defaultLogs = (await call(actors.admin, "listActivity")) as {
    data: unknown[];
  };
  assert.equal(defaultLogs.data.length, 0);
  await unavailable(
    call(actors.admin, "getActivityDetails", { eventId: logs.data[0]!.id }),
  );
  await assert.rejects(
    call(actors.admin, "deleteWorkspace", { workspaceId: workspace.id }),
    { code: "VALIDATION_FAILED" },
  );
  for (const operation of [
    "listDatabases",
    "getActivityDetails",
    "listJobs",
    "createWorkspaceKey",
  ]) {
    assert.equal(
      getOperation(operation).inputSchema.safeParse({ orgId }).success,
      false,
    );
  }
});
test("access is immediate, inherits live team roles, and only an enrolled admin manages members", async () => {
  for (const actor of [actors.peer, actors.member, actors.viewer])
    await call(actors.admin, "addWorkspaceMember", {
      workspaceId: workspace.id,
      userId: actor.userId,
    });
  await assert.rejects(
    call(actors.viewer, "listActivity", { workspaceId: workspace.id }),
    { code: "FORBIDDEN" },
  );
  await call(actors.member, "createDatabase", {
    workspaceId: workspace.id,
    name: "Member database",
  });
  await assert.rejects(
    call(actors.viewer, "createDatabase", {
      workspaceId: workspace.id,
      name: "Denied",
    }),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(
    call(actors.member, "removeWorkspaceMember", {
      workspaceId: workspace.id,
      userId: actors.member.userId,
    }),
    { code: "FORBIDDEN" },
  );
  await call(actors.peer, "removeWorkspaceMember", {
    workspaceId: workspace.id,
    userId: actors.member.userId,
  });
  await unavailable(
    call(actors.member, "listDatabases", { workspaceId: workspace.id }),
  );
  await call(actors.peer, "removeWorkspaceMember", {
    workspaceId: workspace.id,
    userId: actors.peer.userId,
  });
  await unavailable(
    call(actors.peer, "listDatabases", { workspaceId: workspace.id }),
  );
});
test("workspace keys are bound to one workspace, cannot manage the team, and only admins can issue them", async () => {
  await assert.rejects(
    call(actors.viewer, "createWorkspaceKey", {
      workspaceId: workspace.id,
      name: "Denied",
      access: "read",
      includeAdmin: false,
      expiresAt: null,
    }),
    { code: "FORBIDDEN" },
  );
  const result = (await call(actors.admin, "createWorkspaceKey", {
    workspaceId: workspace.id,
    name: "Workspace integration",
    access: "edit",
    includeAdmin: true,
    expiresAt: null,
  })) as { secret: string; key: { id: string; workspaceId: string } };
  assert.equal(result.key.workspaceId, workspace.id);
  const actor = await runtime.identity.resolveActor(
    new Request(`${runtime.config.baseURL}/v1/me`, {
      headers: { authorization: `Bearer ${result.secret}` },
    }),
    "api",
  );
  assert.ok(actor);
  assert.equal(actor.kind, "workspace_key");
  await call(actor, "getDatabase", {
    workspaceId: workspace.id,
    databaseId: privateDatabase.id,
  });
  await unavailable(call(actor, "listDatabases"));
  await assert.rejects(call(actor, "listTeamWorkspaces"), {
    code: "INSUFFICIENT_SCOPE",
  });
  await assert.rejects(call(actor, "getUsage"), { code: "INSUFFICIENT_SCOPE" });
  await call(actor, "getWorkspace", { workspaceId: workspace.id });
  await unavailable(call(actor, "getWorkspace", { workspaceId: orgId }));
  const own = (await call(actor, "listWorkspaces")) as { data: Workspace[] };
  assert.deepEqual(
    own.data.map((w) => w.id),
    [workspace.id],
  );
  await unavailable(
    call(actors.admin, "revokeWorkspaceKey", { id: result.key.id }),
  );
});
test("empty workspaces can be deleted and disappear without deleting Default", async () => {
  const empty = (await call(actors.admin, "createWorkspace", {
    name: "Disposable",
    description: "",
  })) as Workspace;
  await call(actors.admin, "deleteWorkspace", { workspaceId: empty.id });
  await unavailable(
    call(actors.admin, "getWorkspace", { workspaceId: empty.id }),
  );
  const all = (await call(actors.admin, "listWorkspaces")) as {
    data: Workspace[];
  };
  assert.ok(all.data.some((w) => w.isDefault));
  assert.ok(!all.data.some((w) => w.id === empty.id));
});

test("queued exports and their artifacts retain private workspace scope", async () => {
  const accepted = (await call(actors.admin, "exportDatabase", {
    workspaceId: workspace.id,
    databaseId: privateDatabase.id,
    format: "jsonl",
  })) as { jobId: string; statusUrl: string };
  assert.equal(
    new URL(accepted.statusUrl, runtime.config.baseURL).searchParams.get(
      "workspaceId",
    ),
    workspace.id,
  );
  await unavailable(call(actors.admin, "getJob", { id: accepted.jobId }));
  let job:
    | { state: string; result?: { artifactId: string }; error?: unknown }
    | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    await runtime.jobs.runOnce(orgId);
    job = (await call(actors.admin, "getJob", {
      workspaceId: workspace.id,
      id: accepted.jobId,
    })) as typeof job;
    if (job && !["queued", "running"].includes(job.state)) break;
  }
  assert.equal(job?.state, "succeeded", JSON.stringify(job?.error));
  const artifact = (await call(actors.admin, "getArtifact", {
    workspaceId: workspace.id,
    id: job!.result!.artifactId,
  })) as { downloadUrl: string };
  assert.equal(
    new URL(artifact.downloadUrl).searchParams.get("workspaceId"),
    workspace.id,
  );
  await unavailable(
    call(actors.admin, "getArtifact", { id: job!.result!.artifactId }),
  );
});

test("database creation and workspace deletion cannot both commit", async () => {
  const empty = (await call(actors.admin, "createWorkspace", {
    name: "Concurrent deletion",
    description: "Preserve description",
  })) as Workspace;
  const updated = (await call(actors.admin, "updateWorkspace", {
    workspaceId: empty.id,
    name: "Concurrent workspace",
  })) as Workspace;
  assert.equal(updated.description, "Preserve description");
  const results = await Promise.allSettled([
    call(actors.admin, "createDatabase", {
      workspaceId: empty.id,
      name: "Concurrent database",
    }),
    call(actors.admin, "deleteWorkspace", { workspaceId: empty.id }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = results.find(
    (result) => result.status === "rejected",
  ) as PromiseRejectedResult;
  assert.ok(
    ["RESOURCE_NOT_FOUND", "VALIDATION_FAILED"].includes(failure.reason.code),
  );
});
