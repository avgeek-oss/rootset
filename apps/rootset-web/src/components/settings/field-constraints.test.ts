import { describe, expect, it } from "vitest";
import { fieldConstraints } from "./field-constraints";

describe("field constraints summary", () => {
  it("keeps zero bounds and false defaults visible", () => {
    expect(
      fieldConstraints({
        id: "field",
        name: "COUNT",
        type: "integer",
        min: 0,
        max: 100,
        default: 0,
      }),
    ).toEqual(["Min 0", "Max 100", "Default 0"]);
    expect(
      fieldConstraints({
        id: "field",
        name: "ACTIVE",
        type: "boolean",
        default: false,
      }),
    ).toEqual(["Default false"]);
  });
  it("distinguishes an explicit null default from no default", () => {
    expect(
      fieldConstraints({
        id: "field",
        name: "DATA",
        type: "json",
        default: null,
      }),
    ).toEqual(["Default null"]);
    expect(
      fieldConstraints({ id: "field", name: "DATA", type: "json" }),
    ).toEqual([]);
  });
  it("shows text limits and quotes literal text defaults", () => {
    expect(
      fieldConstraints({
        id: "field",
        name: "NAME",
        type: "text",
        charLimit: 64,
        default: "Unknown",
      }),
    ).toEqual(["Max 64 characters", 'Default "Unknown"']);
  });
});
