import { describe, expect, it } from "vitest";
import { canOpenSettings, SECTION_LABELS } from "./types";

const management = [
  "backup-schedule",
  "backup-history",
  "restore-requests",
  "organisation",
  "members",
  "workspace-api-keys",
  "database-danger-zone",
  "table-danger-zone",
] as const;
const personalAndRead = [
  "profile",
  "preferences",
  "email-password",
  "passkeys",
  "sessions",
  "mcp",
  "api-keys",
  "mcp-connections",
  "exports",
  "database-exports",
] as const;
describe("settings role boundaries", () => {
  it.each([
    "database",
    "table",
    "fields",
    "rules",
    "foreign-keys",
    "imports",
  ] as const)("allows editors and administrators to %s", (section) => {
    expect(canOpenSettings(section, "member")).toBe(true);
    expect(canOpenSettings(section, "admin")).toBe(true);
    expect(canOpenSettings(section, "viewer")).toBe(false);
  });
  it.each(management)(
    "admits only admins to %s, including direct links",
    (section) => {
      expect(canOpenSettings(section, "admin")).toBe(true);
      for (const role of ["member", "viewer", "owner", undefined])
        expect(canOpenSettings(section, role)).toBe(false);
    },
  );
  it.each(personalAndRead)(
    "retains %s for every installation role",
    (section) => {
      for (const role of ["admin", "member", "viewer"])
        expect(canOpenSettings(section, role)).toBe(true);
      expect(canOpenSettings(section)).toBe(false);
    },
  );
  it("removes obsolete settings navigation", () => {
    expect(SECTION_LABELS).not.toHaveProperty("grants");
    expect(SECTION_LABELS).not.toHaveProperty("audit");
    expect(SECTION_LABELS).not.toHaveProperty("jobs");
  });
});
