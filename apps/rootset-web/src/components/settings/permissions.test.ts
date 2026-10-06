import { describe, expect, it } from "vitest";
import { canOpenSettings, SECTION_LABELS } from "./types";

const management = [
  "organisation",
  "members",
  "database",
  "table",
  "fields",
  "rules",
  "indexes",
  "backups",
  "operator",
] as const;
const personalAndRead = [
  "profile",
  "preferences",
  "email-password",
  "passkeys",
  "sessions",
  "mcp",
  "api-keys",
  "exports",
] as const;
describe("settings role boundaries", () => {
  it.each(management)(
    "admits only admins to %s, including direct links",
    (section) => {
      expect(canOpenSettings(section, "admin")).toBe(true);
      for (const role of ["editor", "viewer", "owner", undefined])
        expect(canOpenSettings(section, role)).toBe(false);
    },
  );
  it.each(personalAndRead)(
    "retains %s for every installation role",
    (section) => {
      for (const role of ["admin", "editor", "viewer"])
        expect(canOpenSettings(section, role)).toBe(true);
      expect(canOpenSettings(section)).toBe(false);
    },
  );
  it("keeps row imports for writers and removes obsolete settings navigation", () => {
    expect(canOpenSettings("imports", "admin")).toBe(true);
    expect(canOpenSettings("imports", "editor")).toBe(true);
    expect(canOpenSettings("imports", "viewer")).toBe(false);
    expect(SECTION_LABELS).not.toHaveProperty("grants");
    expect(SECTION_LABELS).not.toHaveProperty("audit");
    expect(SECTION_LABELS).not.toHaveProperty("jobs");
  });
});
