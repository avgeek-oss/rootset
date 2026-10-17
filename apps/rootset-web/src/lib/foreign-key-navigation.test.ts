import { describe, expect, it } from "vitest";
import { validateQuery, type ForeignKey, type Row } from "@rootset/contracts";
import {
  foreignKeyLinks,
  readLinkedTableFilter,
  reverseRelationshipPath,
} from "./foreign-key-navigation";
import { buildTableFilter } from "./table-filters";

const source = "01M3YTS99KPQXTMVWRN1V91562";
const target = "01M3YTS99KPQXTMVWRN1V91563";
const secondSource = "01M3YTS99KPQXTMVWRN1V91564";
const secondTarget = "01M3YTS99KPQXTMVWRN1V91565";
const rule: ForeignKey = {
  id: "01M3YTS99KPQXTMVWRN1V91566",
  tableId: "01M3YTS99KPQXTMVWRN1V91567",
  fieldIds: [source],
  referencedTableId: "01M3YTS99KPQXTMVWRN1V91568",
  referencedTableName: "Manufacturers",
  referencedRuleId: "01M3YTS99KPQXTMVWRN1V91569",
  referencedFieldIds: [target],
  referencedFieldNames: ["ID"],
  state: "active",
};
const row: Row = {
  id: "01M3YTS99KPQXTMVWRN1V91570",
  version: "1",
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
  values: { manufacturerId: 846 },
};
const fieldNames = new Map([
  [source, "manufacturerId"],
  [secondSource, "region"],
]);

function linkedFilter(link: { href: string }) {
  return readLinkedTableFilter(
    new URL(link.href, "http://localhost").searchParams.get("filter"),
  );
}

describe("foreign-key record navigation", () => {
  it("opens the referenced table with an equality filter on its field ID", () => {
    const [link] = foreignKeyLinks("database", [rule], row, fieldNames);
    const url = new URL(link!.href, "http://localhost");
    expect(url.pathname).toBe(
      `/databases/database/tables/${rule.referencedTableId}`,
    );
    const initial = linkedFilter(link!);
    expect(initial.where).toEqual({ field: target, op: "eq", value: 846 });
    const fields = [
      { id: target, name: "renamedId", type: "integer" as const },
    ];
    expect(validateQuery({ where: initial.where }, fields).where).toEqual({
      field: "renamedId",
      op: "eq",
      value: 846,
    });
    expect(buildTableFilter(initial.conditions, "and", fields)).toEqual({
      field: "renamedId",
      op: "eq",
      value: 846,
    });
  });

  it.each([
    "",
    " 00846 ",
    "A&B + /?#= தமிழில்",
    false,
    0,
    "9223372036854775807",
  ])("preserves the exact key value %j", (value) => {
    const [link] = foreignKeyLinks(
      "database",
      [rule],
      { ...row, values: { manufacturerId: value } },
      fieldNames,
    );
    expect(linkedFilter(link!).where).toEqual({
      field: target,
      op: "eq",
      value,
    });
  });

  it("filters by every component in order for composite keys", () => {
    const composite = {
      ...rule,
      fieldIds: [secondSource, source],
      referencedFieldIds: [secondTarget, target],
      referencedFieldNames: ["REGION", "ID"],
    };
    const [link] = foreignKeyLinks(
      "database",
      [composite],
      { ...row, values: { manufacturerId: 846, region: "EU" } },
      fieldNames,
    );
    expect(linkedFilter(link!).where).toEqual({
      and: [
        { field: secondTarget, op: "eq", value: "EU" },
        { field: target, op: "eq", value: 846 },
      ],
    });
    for (const values of Array.of<Row["values"]>(
      { manufacturerId: 846 },
      { manufacturerId: 846, region: null },
    )) {
      expect(
        foreignKeyLinks(
          "database",
          [composite],
          { ...row, values },
          fieldNames,
        ),
      ).toEqual([]);
    }
  });

  it("has no destination for NULL or unloaded fields", () => {
    for (const values of Array.of<Row["values"]>({ manufacturerId: null }, {}))
      expect(
        foreignKeyLinks("database", [rule], { ...row, values }, fieldNames),
      ).toEqual([]);
    expect(foreignKeyLinks("database", [rule], row, new Map())).toEqual([]);
  });

  it("retains each relationship when a field links to multiple tables", () => {
    const other = {
      ...rule,
      id: "01M3YTS99KPQXTMVWRN1V91571",
      referencedTableId: "01M3YTS99KPQXTMVWRN1V91572",
      referencedTableName: "Suppliers",
    };
    const links = foreignKeyLinks("database", [rule, other], row, fieldNames);
    expect(links.map((link) => link.name)).toEqual([
      "Manufacturers",
      "Suppliers",
    ]);
    expect(links[0]!.href).not.toBe(links[1]!.href);
  });

  it.each([
    "",
    "not JSON",
    "[]",
    '[{"fieldId":"invalid","value":846}]',
    JSON.stringify([{ fieldId: target, value: null }]),
    JSON.stringify([{ fieldId: target, value: { key: 846 } }]),
    JSON.stringify([{ fieldId: target, value: 846, op: "ne" }]),
    JSON.stringify(
      Array.from({ length: 9 }, () => ({ fieldId: target, value: 846 })),
    ),
  ])(
    "rejects malformed links without turning them into an unfiltered query",
    (value) => {
      expect(readLinkedTableFilter(value)).toEqual({
        conditions: [],
        error: expect.stringContaining("invalid"),
      });
    },
  );

  it("leaves ordinary table navigation unfiltered", () => {
    expect(readLinkedTableFilter(null)).toEqual({ conditions: [] });
  });
});

it("reverse navigation keeps key values out of the URL", () => {
  const href = reverseRelationshipPath(
    "database",
    rule.tableId,
    rule.id,
    row.id,
  );
  const url = new URL(href, "http://localhost");
  expect(url.searchParams.get("relationship")).toBe(rule.id);
  expect(url.searchParams.get("record")).toBe(row.id);
  expect(url.searchParams.has("filter")).toBe(false);
  expect(href.length).toBeLessThan(150);
});
