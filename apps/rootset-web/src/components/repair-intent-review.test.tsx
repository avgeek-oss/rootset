import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OperatorRepairIntentSchema,
  type OperatorRepairIntent,
} from "@rootset/contracts";
import { RepairIntentReview } from "./repair-intent-review";
import RepairValueReview, { repairValuePage } from "./repair-value-review";
import { repairReviewUnavailable } from "./repair-review-status";

const orgId = "01M3YBZZ9GM226PW1QZFZQDJ88";
const databaseId = "01M3YC331BD433P2MBBTEQGAMT";
const tableId = "01M3YC338JZMS5M2ZXWRN8E0T6";
const rowId = "01M3YXT3XA864RRTE47RRKMWT1";
function intent(
  values: OperatorRepairIntent["updates"][number]["values"] = {
    name: "Corrected",
  },
): OperatorRepairIntent {
  return {
    orgId,
    databaseId,
    tableId,
    expectedSchemaVersion: 7,
    reason: "Verified source correction\nTicket 123",
    updates: [{ rowId, expectedVersion: "12", values }],
  };
}
function textContent(markup: string) {
  return markup
    .replace(/<[^>]*>/g, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("immutable operator repair review", () => {
  it("shows the exact target, reason, schema and row revision without treating business keys as credentials", () => {
    const parsed = OperatorRepairIntentSchema.parse(
      intent(
        JSON.parse(
          '{"password":"business password","token":"business token","secret":"business secret","META":{"__proto__":{"secret":"own business key"}}}',
        ),
      ),
    );
    const html = renderToStaticMarkup(
      createElement(RepairIntentReview, { intent: parsed }),
    );
    for (const expected of [
      orgId,
      databaseId,
      tableId,
      rowId,
      "Expected schema version",
      "Expected row version",
      "12",
      "Verified source correction\nTicket 123",
      "password",
      "token",
      "secret",
      "META",
    ])
      expect(html).toContain(expected);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("aria-controls");
    expect(html).not.toContain("business password");
    expect(html).not.toContain("business token");
    expect(html).not.toContain("business secret");
  });

  it.each([
    "id",
    "version",
    "createdAt",
    "updatedAt",
    "__proto__",
    "prototype",
    "constructor",
  ])(
    "rejects reserved top-level field %s while preserving nested JSON keys",
    (name) => {
      const values = Object.defineProperty({}, name, {
        enumerable: true,
        value: "business value",
      });
      expect(OperatorRepairIntentSchema.safeParse(intent(values)).success).toBe(
        false,
      );
      const nested = OperatorRepairIntentSchema.parse(
        intent({
          META: JSON.parse(
            '{"__proto__":{"token":"retained"},"constructor":"business"}',
          ),
        }),
      );
      expect(
        Object.hasOwn(nested.updates[0]!.values.META as object, "__proto__"),
      ).toBe(true);
    },
  );

  it("renders only the first requested row and ten field names, without accessing or serializing collapsed or offscreen data", () => {
    const values: Record<string, string> = {};
    for (let i = 0; i < 200; i++)
      Object.defineProperty(
        values,
        `FIELD_${String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26))}`,
        {
          enumerable: true,
          get() {
            throw new Error("Collapsed value was read");
          },
        },
      );
    const request = intent(values);
    request.updates = Array.from({ length: 1000 }, (_, index) =>
      index === 0
        ? request.updates[0]!
        : (Object.defineProperties(
            {},
            {
              rowId: {
                get() {
                  throw new Error("Offscreen row was read");
                },
              },
              expectedVersion: {
                get() {
                  throw new Error("Offscreen revision was read");
                },
              },
              values: {
                get() {
                  throw new Error("Offscreen fields were read");
                },
              },
            },
          ) as OperatorRepairIntent["updates"][number]),
    );
    const html = renderToStaticMarkup(
      createElement(RepairIntentReview, { intent: request }),
    );
    expect(html).toContain("1000");
    expect(
      html.match(/aria-label="View requested value for FIELD_/g),
    ).toHaveLength(10);
    expect(html).toContain("FIELD_AJ");
    expect(html).not.toContain("FIELD_AK");
    expect(html).not.toContain("Requested JSON value");
    expect(html).not.toContain("Opening requested value");
  });

  it("reveals a selected value as exact escaped JSON, including own prototype-shaped keys and sensitive business names", () => {
    const value = JSON.parse(
      '{"password":"literal <script>alert(1)</script>","token":"t","secret":"s","__proto__":{"token":"retained"},"empty":"","nothing":null,"number":12,"flag":false}',
    );
    const html = renderToStaticMarkup(
      createElement(RepairValueReview, { value, field: "token" }),
    );
    const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1];
    expect(pre).toBeDefined();
    expect(textContent(pre!)).toBe(JSON.stringify(value));
    expect(html).not.toContain("<script>");
    expect(JSON.parse(textContent(pre!))).toEqual(value);
    expect(Object.hasOwn(JSON.parse(textContent(pre!)), "__proto__")).toBe(
      true,
    );
    expect(html).not.toContain("[REDACTED]");
  });

  it.each(["abc", "", null, false, 0])(
    "keeps scalar %j distinguishable as JSON",
    (value) => {
      const html = renderToStaticMarkup(
        createElement(RepairValueReview, { value, field: "scalar" }),
      );
      expect(textContent(html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)![1]!)).toBe(
        JSON.stringify(value),
      );
    },
  );

  it("offers all of a large selected value in bounded sections without splitting Unicode or truncating its tail", () => {
    const value = {
      text: "a".repeat(32758) + "😀" + "b".repeat(32768) + "😀" + "TAIL",
      password: "literal-password",
      __proto__: null,
    };
    const full = JSON.stringify(value);
    const first = repairValuePage(full, 0);
    const sections = Array.from({ length: first.count }, (_, page) =>
      repairValuePage(full, page),
    );
    expect(sections.map((section) => section.text).join("")).toBe(full);
    for (const section of sections) {
      expect(section.text.length).toBeLessThanOrEqual(32769);
      expect(section.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    expect(
      JSON.parse(sections.map((section) => section.text).join("")),
    ).toEqual(JSON.parse(full));
    const html = renderToStaticMarkup(
      createElement(RepairValueReview, { value, field: "JSON" }),
    );
    expect(html).toContain("Next value section");
    expect(html).not.toContain("TAIL");
    expect(html.length).toBeLessThan(36000);
    expect(repairValuePage(full, -1).page).toBe(0);
    expect(repairValuePage(full, 1000).page).toBe(first.count - 1);
  });
});

describe("repair review approval guard", () => {
  it.each([undefined, "pending", "approved"])(
    "blocks a %s repair if its immutable intent is unavailable",
    (state) => {
      expect(repairReviewUnavailable({ type: "operator_repair", state })).toBe(
        true,
      );
      expect(
        repairReviewUnavailable({
          type: "operator_repair",
          state,
          repairIntent: { ...intent(), updates: [] },
        }),
      ).toBe(true);
    },
  );
  it("blocks an over-budget repair while permitting a complete pending repair", () => {
    const request = intent();
    expect(
      repairReviewUnavailable({
        type: "operator_repair",
        state: "pending",
        repairIntent: request,
      }),
    ).toBe(false);
    expect(
      repairReviewUnavailable({
        type: "operator_repair",
        state: "pending",
        repairIntent: {
          ...request,
          updates: Array.from({ length: 1001 }, () => request.updates[0]!),
        },
      }),
    ).toBe(true);
  });
  it("does not block ordinary actions or consumed repair receipts that omit intent", () => {
    expect(repairReviewUnavailable(undefined)).toBe(false);
    expect(
      repairReviewUnavailable({ type: "create_key", state: "pending" }),
    ).toBe(false);
    for (const state of ["consumed", "expired", "denied"])
      expect(repairReviewUnavailable({ type: "operator_repair", state })).toBe(
        false,
      );
  });
});
