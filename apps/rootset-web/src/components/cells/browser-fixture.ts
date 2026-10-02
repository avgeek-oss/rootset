import type { FieldDefinition, JsonValue } from "@rootset/contracts";

export const cellBrowserFields: Omit<FieldDefinition, "id">[] = [
  {
    apiKey: "NAME",
    label: "Name",
    type: "text",
    required: true,
    charLimit: 24,
    order: 0,
  },
  {
    apiKey: "INTEGER",
    label: "Integer",
    type: "integer",
    required: true,
    min: 0,
    max: 1_000_000,
    order: 1,
  },
  {
    apiKey: "FLOAT",
    label: "Float",
    type: "float",
    min: -100,
    max: 100,
    order: 2,
  },
  { apiKey: "BOOLEAN", label: "Boolean", type: "boolean", order: 3 },
  {
    apiKey: "DATE",
    label: "Date",
    type: "date",
    min: "2020-01-01",
    max: "2030-12-31",
    order: 4,
  },
  { apiKey: "TIME", label: "Time", type: "time", order: 5 },
  {
    apiKey: "DATETIME",
    label: "Date-time",
    type: "date-time",
    min: "2020-01-01T00:00:00.000Z",
    max: "2030-12-31T23:59:59.999Z",
    order: 6,
  },
  { apiKey: "JSON", label: "JSON", type: "json", order: 7 },
];

export const cellBrowserValues: Record<string, JsonValue> = {
  NAME: "Seed",
  INTEGER: 1,
  FLOAT: 1.5,
  BOOLEAN: false,
  DATE: "2026-10-02",
  TIME: "07:04:03.100Z",
  DATETIME: "2026-10-02T12:30:00.123Z",
  JSON: { nested: null, seed: true },
};

export interface BrowserDatabaseFixture {
  orgId: string;
  databaseId: string;
  tableId?: string;
  tableName?: string;
}
