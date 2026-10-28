import { describe, expect, it } from "vitest";
import { fieldConstraints } from "./field-constraints";

describe("field constraints summary", () => {
  it("shows the saved JSON schema expression in the constraints column", () => {
    const field = {
      id: "schema",
      name: "DATA",
      type: "json" as const,
      zodSchema: "z.object({ name: z.string() })",
    };
    expect(fieldConstraints(field)).toEqual([field.zodSchema]);
    expect(fieldConstraints({ ...field, zodSchema: null })).toEqual([]);
  });
  it("shows choices below ten and switches to a count at ten", () => {
    const choices = [
      "active",
      "planned",
      "NULL",
      " unknown ",
      "line\nbreak",
      "ceased",
      "merged",
      "suspended",
      "draft",
    ];
    const field = {
      id: "state",
      name: "STATE",
      type: "text" as const,
      allowedValues: choices,
    };
    expect(fieldConstraints(field)).toEqual([
      'active, planned, "NULL", " unknown ", "line\\nbreak", ceased, merged, suspended, draft',
    ]);
    expect(
      fieldConstraints({ ...field, allowedValues: [...choices, "archived"] }),
    ).toEqual(["10 allowed values"]);
  });
  it("keeps zero bounds and leaves defaults to their own column", () => {
    expect(
      fieldConstraints({
        id: "field",
        name: "COUNT",
        type: "integer",
        min: 0,
        max: 100,
        default: 0,
      }),
    ).toEqual(["Min 0", "Max 100"]);
    expect(
      fieldConstraints({
        id: "field",
        name: "ACTIVE",
        type: "boolean",
        default: false,
      }),
    ).toEqual([]);
  });
  it("does not treat null defaults as constraints", () => {
    expect(
      fieldConstraints({
        id: "field",
        name: "DATA",
        type: "json",
        default: null,
      }),
    ).toEqual([]);
    expect(
      fieldConstraints({ id: "field", name: "DATA", type: "json" }),
    ).toEqual([]);
  });
  it("shows text limits without including literal text defaults", () => {
    expect(
      fieldConstraints({
        id: "field",
        name: "NAME",
        type: "text",
        charLimit: 64,
        default: "Unknown",
      }),
    ).toEqual(["Max 64 characters"]);
  });
  it("formats date-time bounds with the shared default presentation", () => {
    expect(
      fieldConstraints({
        id: "field",
        name: "UPDATED",
        type: "date-time",
        min: "2026-10-14T00:00:00.000Z",
        max: "2026-10-15T12:30:00.000Z",
      }),
    ).toEqual(["Min 14 Oct 2026, 00:00 UTC", "Max 15 Oct 2026, 12:30 UTC"]);
  });
  it("uses the saved date, clock and timezone preferences for instants", () => {
    expect(
      fieldConstraints(
        {
          id: "field",
          name: "UPDATED",
          type: "date-time",
          min: "2026-10-14T00:00:00.000Z",
        },
        {
          timezone: "America/Los_Angeles",
          dateFormat: "month-day-year",
          timeFormat: "12-hour",
        },
      ),
    ).toEqual(["Min 10/13/2026, 5:00 PM America/Los_Angeles"]);
  });
  it("keeps date-only and UTC time-only bounds independent of the timezone", () => {
    const preferences = {
      timezone: "Asia/Kolkata",
      dateFormat: "day-month-year",
      timeFormat: "12-hour",
    } as const;
    expect(
      fieldConstraints(
        { id: "date", name: "DATE", type: "date", min: "2026-10-14" },
        preferences,
      ),
    ).toEqual(["Min 14/10/2026"]);
    expect(
      fieldConstraints(
        { id: "time", name: "TIME", type: "time", max: "12:30:00.000Z" },
        preferences,
      ),
    ).toEqual(["Max 12:30 PM UTC"]);
  });
});
