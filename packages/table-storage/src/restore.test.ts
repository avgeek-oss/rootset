import assert from "node:assert/strict";
import { test } from "node:test";
import { IdSchema } from "@rootset/contracts";
import { backupTimestamp, restoredId } from "./restore";
const database = "01J00000000000000000000001",
  source = "01J00000000000000000000002";
test("restore identifiers stay stable within a restore and cannot reuse source global identities", () => {
  const result = restoredId(database, "field", source);
  assert.equal(IdSchema.parse(result), result);
  assert.notEqual(result, source);
  assert.equal(
    restoredId(database.toLowerCase(), "field", source.toLowerCase()),
    result,
  );
  assert.notEqual(restoredId(database, "table", source), result);
  assert.notEqual(restoredId(source, "field", source), result);
});
test("backup timestamps keep microsecond precision while rejecting normalized invalid dates", () => {
  assert.equal(
    backupTimestamp("2026-10-17 09:41:49.615155+00"),
    "2026-10-17T09:41:49.615155Z",
  );
  assert.equal(
    backupTimestamp("2024-02-29T23:59:59.000001Z"),
    "2024-02-29T23:59:59.000001Z",
  );
  for (const value of [
    "2026-02-29T00:00:00Z",
    "2026-02-31T00:00:00Z",
    "2026-10-17T24:00:00Z",
    "infinity",
    "0000-01-01T00:00:00Z",
    "2026-10-17T09:00:00+01:00",
    null,
  ])
    assert.throws(() => backupTimestamp(value));
});
