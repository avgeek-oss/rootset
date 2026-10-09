import { describe, expect, it } from "vitest";
import { fieldConstraints } from "./field-constraints";

describe("field constraints summary", () => {
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
});
