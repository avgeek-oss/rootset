import { expect, it } from "vitest";
import { ownedBackupObject } from "./ownership.js";

it("retention and restore accept only an exact published filename in its database namespace", () => {
  const source = {
    id: "01J00000000000000000000001",
    database_id: "01J00000000000000000000002",
    prefix: "team/backups",
    object_key:
      "team/backups/01J00000000000000000000002/2026/10/17/01J00000000000000000000001-01J00000000000000000000003.rootset-backup",
  };
  expect(ownedBackupObject(source)).toBe(true);
  for (const key of [
    "other/object.rootset-backup",
    source.object_key.replace(source.database_id, source.id),
    source.object_key + "/another-key",
    source.object_key.replace("/2026/10/17/", "/../"),
    source.object_key.replace(`${source.id}-`, "01J00000000000000000000004-"),
    source.object_key.replace(".rootset-backup", ".zip"),
  ])
    expect(ownedBackupObject({ ...source, object_key: key })).toBe(false);
  for (const prefix of [
    "/team/backups",
    "../team/backups",
    "team/../backups",
    "team\\backups",
    "team/\nbackups",
  ])
    expect(
      ownedBackupObject({
        ...source,
        prefix,
        object_key: source.object_key.replace(source.prefix, prefix),
      }),
    ).toBe(false);
});
