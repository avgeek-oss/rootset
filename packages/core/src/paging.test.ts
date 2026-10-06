import assert from "node:assert/strict";
import test from "node:test";
import { type Actor, RootsetError } from "@rootset/contracts";
import { MetadataPaging } from "./paging.js";

const id = (index: number) =>
  `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`;
const actor: Actor = {
  kind: "personal_key",
  id: id(0),
  orgId: id(1),
  userId: id(2),
  credentialId: id(3),
  role: "member",
  scopes: ["databases:read", "tables:read"],
  membershipVersion: 4,
};
const rows = [8, 4, 7, 5, 6].map((value) => ({
  id: id(value),
  name: `Name ${value}`,
}));
const request = { resource: `tables:${actor.orgId}:${id(4)}`, limit: 2 };
const errorCode = (code: string) => (error: unknown) =>
  error instanceof RootsetError && error.code === code;

test("metadata paging produces stable complete keyset pages despite changing labels", () => {
  const paging = new MetadataPaging("x".repeat(32));
  const first = paging.paginate(rows, actor, request);
  assert.deepEqual(
    first.data.map((row) => row.id),
    [id(4), id(5)],
  );
  assert.equal(first.hasMore, true);
  const secondRequest = { ...request, cursor: first.nextCursor };
  assert.deepEqual(paging.read(actor, secondRequest), {
    afterId: id(5),
    limit: 2,
    pageNumber: 2,
  });
  const second = paging.paginate(
    rows.map((row) => ({ ...row, name: "Renamed" })),
    actor,
    secondRequest,
  );
  assert.deepEqual(
    second.data.map((row) => row.id),
    [id(6), id(7)],
  );
  const final = paging.paginate(rows, actor, {
    ...request,
    cursor: second.nextCursor,
  });
  assert.deepEqual(
    final.data.map((row) => row.id),
    [id(8)],
  );
  assert.equal(final.nextCursor, null);
  assert.equal(final.hasMore, false);
});

test("metadata cursors bind organisation, principal, credential, role revision and query", () => {
  const paging = new MetadataPaging("x".repeat(32));
  const cursor = paging.paginate(rows, actor, request).nextCursor;
  const actors = [
    { ...actor, orgId: id(9) },
    { ...actor, id: id(9) },
    { ...actor, userId: id(9) },
    { ...actor, credentialId: id(9) },
    { ...actor, kind: "oauth" as const, clientId: id(9) },
    { ...actor, role: "viewer" as const },
    { ...actor, membershipVersion: 5 },
    { ...actor, scopes: ["databases:read"] },
  ];
  for (const changed of actors)
    assert.throws(
      () => paging.read(changed, { ...request, cursor }),
      errorCode("CURSOR_INVALID"),
    );
  for (const changed of [
    { ...request, resource: `databases:${actor.orgId}` },
    { ...request, limit: 3 },
    { ...request, filter: { state: "active" } },
  ])
    assert.throws(
      () => paging.read(actor, { ...changed, cursor }),
      errorCode("CURSOR_INVALID"),
    );
  assert.equal(
    paging.read(
      { ...actor, scopes: [...actor.scopes].reverse() },
      { ...request, cursor },
    ).afterId,
    id(5),
  );
});

test("metadata cursors reject tampering, wrong signing keys and expiry", () => {
  let now = 1_000_000;
  const paging = new MetadataPaging("x".repeat(32), {
    clock: () => now,
    lifetimeMs: 1000,
  });
  const cursor = paging.paginate(rows, actor, request).nextCursor!;
  assert.throws(
    () =>
      paging.read(actor, {
        ...request,
        cursor: `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`,
      }),
    errorCode("CURSOR_INVALID"),
  );
  assert.throws(
    () =>
      new MetadataPaging("y".repeat(32), { clock: () => now }).read(actor, {
        ...request,
        cursor,
      }),
    errorCode("CURSOR_INVALID"),
  );
  for (const malformed of ["", "a.b", "a".repeat(2049), `${cursor}.extra`])
    assert.throws(
      () => paging.read(actor, { ...request, cursor: malformed }),
      errorCode("CURSOR_INVALID"),
    );
  now += 999;
  assert.equal(paging.read(actor, { ...request, cursor }).afterId, id(5));
  now += 1;
  assert.throws(
    () => paging.read(actor, { ...request, cursor }),
    errorCode("CURSOR_INVALID"),
  );
});

test("metadata SQL continuation takes limit plus one and remains stable after deletion", () => {
  const paging = new MetadataPaging("x".repeat(32));
  const first = paging.paginate(rows, actor, request);
  const nextRequest = { ...request, cursor: first.nextCursor };
  const position = paging.read(actor, nextRequest);
  const sqlRows = rows
    .filter((row) => row.id > position.afterId!)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, position.limit + 1);
  const second = paging.paginate(sqlRows, actor, nextRequest);
  assert.deepEqual(
    second.data.map((row) => row.id),
    [id(6), id(7)],
  );
  assert.equal(second.hasMore, true);
  assert.deepEqual(
    paging
      .paginate(
        rows.filter((row) => row.id !== id(5)),
        actor,
        nextRequest,
      )
      .data.map((row) => row.id),
    [id(6), id(7)],
  );
});

test("metadata paging validates collection identifiers and limits", () => {
  const paging = new MetadataPaging("x".repeat(32));
  for (const limit of [0, -1, 1.5, 25001, Infinity])
    assert.throws(
      () => paging.read(actor, { ...request, limit }),
      errorCode("VALIDATION_FAILED"),
    );
  assert.throws(
    () => new MetadataPaging("short"),
    errorCode("CONFIGURATION_INVALID"),
  );
  assert.throws(
    () =>
      new MetadataPaging("x".repeat(32), {
        defaultLimit: 1001,
        maxLimit: 1000,
      }),
    errorCode("CONFIGURATION_INVALID"),
  );
  assert.throws(
    () => paging.paginate([{ id: "integer-1" }], actor, request),
    errorCode("INTERNAL_ERROR"),
  );
  assert.throws(
    () => paging.paginate([rows[0]!, rows[0]!], actor, request),
    errorCode("INTERNAL_ERROR"),
  );
  assert.deepEqual(paging.paginate([], actor, request), {
    data: [],
    hasMore: false,
    nextCursor: null,
  });
  assert.equal(paging.read(actor, { resource: "databases" }).limit, 200);
});
