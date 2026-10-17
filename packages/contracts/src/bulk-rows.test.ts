import assert from "node:assert/strict";
import { test } from "node:test";
import { BulkRowsInputSchema, bulkRowsLimits } from "./bulk-rows";
import { getOperation } from "./operations";
const row = { rowId: "01J00000000000000000000001", expectedVersion: "1" };
test("bulk selections are bounded, distinct and revision-bound, and action payloads are strict", () => {
  const input = {
    expectedSchemaVersion: 1,
    rows: [row],
    action: {
      type: "set",
      values: { COUNT: 0, ENABLED: false, NAME: "", PAYLOAD: null },
    },
  };
  assert.deepEqual(BulkRowsInputSchema.parse(input), input);
  for (const rows of [
    [],
    [row, row],
    [{ rowId: row.rowId }],
    [{ ...row, expectedVersion: "0" }],
    Array.from({ length: bulkRowsLimits.rows + 1 }, (_, i) => ({
      ...row,
      rowId: i.toString().padStart(26, "0"),
    })),
  ])
    assert.equal(
      BulkRowsInputSchema.safeParse({ ...input, rows }).success,
      false,
    );
  assert.equal(
    BulkRowsInputSchema.safeParse({
      ...input,
      action: { type: "set", values: {} },
    }).success,
    false,
  );
  assert.equal(
    BulkRowsInputSchema.safeParse({
      ...input,
      action: { type: "delete", values: { COUNT: 1 } },
    }).success,
    false,
  );
  assert.equal(
    BulkRowsInputSchema.safeParse({
      ...input,
      action: { type: "duplicate", sourceValues: { NAME: "untrusted" } },
    }).success,
    false,
  );
  assert.equal(
    BulkRowsInputSchema.safeParse({ ...input, selectAll: true }).success,
    false,
  );
});
test("read-only bulk previews still require write authority and a member role", () => {
  const preview = getOperation("previewBulkRows"),
    apply = getOperation("bulkRows");
  assert.equal(preview.readOnly, true);
  assert.equal(preview.idempotencyRequired, false);
  assert.equal(preview.minimumRole, "member");
  assert.deepEqual(preview.scopes, ["rows:write"]);
  assert.equal(apply.idempotencyRequired, true);
  assert.equal(apply.destructive, true);
});
