import assert from "node:assert/strict";
import test from "node:test";
import { RootsetError, SchemaOperationReportSchema } from "@rootset/contracts";
import { mapSchemaJournal } from "./schema-journal.js";

const id = (index: number) =>
  `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`;
const instant = "2026-10-02T00:00:00.000Z";
const field = {
  id: id(4),
  name: "CODE",
  type: "text",
  charLimit: 10,
  order: 0,
};
const table = {
  id: id(2),
  orgId: id(0),
  databaseId: id(1),
  name: "Airlines",
  description: "",
  state: "active",
  schemaVersion: 3,
  rowCount: 50,
  createdAt: instant,
  updatedAt: instant,
  fields: [field],
  physicalName: "secret-physical-table",
  schemaName: "secret-physical-schema",
  generation: 1,
};
function journal(kind: string, input: unknown, state = "committed") {
  return {
    id: id(3),
    database_id: id(1),
    table_id: id(2),
    org_id: id(0),
    kind,
    state,
    expected_version: "3",
    before_definition: table,
    after_definition: input,
    plan: { transactional: true, physicalName: "secret-physical-index" },
    created_at: new Date(instant),
    committed_at: new Date(instant),
    error: null,
    idempotency_key: "secret-idempotency-key",
    input_hash: "secret-input-hash",
  };
}

test("schema journals expose public before/request metadata and preserve user JSON defaults", () => {
  const output = mapSchemaJournal(
    journal("field.create", {
      name: "META",
      type: "json",
      default: { context: "user data", physicalName: "user data" },
      context: { requestId: "secret-auth-context" },
      idempotencyKey: "secret-request-key",
      expectedSchemaVersion: 3,
    }),
  );
  assert.equal(output.phase, "committed");
  assert.equal(output.expectedSchemaVersion, 3);
  assert.equal(output.request.kind, "field.create");
  assert.deepEqual(output.change, {
    kind: "add_field",
    field: {
      name: "META",
      type: "json",
      default: { context: "user data", physicalName: "user data" },
    },
  });
  assert.deepEqual(output.before?.fields, [field]);
  assert.equal(output.before?.table.name, "Airlines");
  const serialized = JSON.stringify(output);
  for (const secret of [
    "secret-physical-table",
    "secret-physical-schema",
    "secret-physical-index",
    "secret-idempotency-key",
    "secret-input-hash",
    "secret-auth-context",
    "secret-request-key",
    "generation",
  ])
    assert.equal(serialized.includes(secret), false, secret);
  assert.equal(SchemaOperationReportSchema.safeParse(output).success, true);
});

test("field update/delete identity is reconstructed from the bound job input instead of guessed", () => {
  const update = journal("field.update", {
    expectedSchemaVersion: 3,
    context: { source: "schema" },
  });
  const incomplete = mapSchemaJournal(update);
  assert.equal(incomplete.change, undefined);
  const mapped = mapSchemaJournal(update, {
    jobId: id(8),
    request: { tableId: id(2), fieldId: id(4), field: {} },
  });
  assert.deepEqual(mapped.change, {
    kind: "update_field",
    fieldId: id(4),
    changes: {},
  });
  assert.equal(mapped.jobId, id(8));
  const deletion = mapSchemaJournal(
    journal("field.delete", { removeDependencies: true }),
    {
      request: {
        change: {
          kind: "delete_field",
          fieldId: id(4),
          removeDependencies: true,
        },
      },
    },
  );
  assert.deepEqual(deletion.change, {
    kind: "delete_field",
    fieldId: id(4),
    removeDependencies: true,
  });
  const reordered = mapSchemaJournal(
    journal("fields.reorder", { fieldIds: [id(4)], context: {} }),
  );
  assert.deepEqual(reordered.change, {
    kind: "reorder_fields",
    fieldIds: [id(4)],
  });
});

test("schema journals preserve generator configuration and explicit default removal", () => {
  const mapped = mapSchemaJournal(
    journal("field.update", { autoIncrement: true, clearDefault: true }),
    {
      request: {
        fieldId: id(4),
        field: { name: "RECORD_ID", type: "integer", autoIncrement: true },
        clearDefault: true,
      },
    },
  );
  assert.deepEqual(mapped.change, {
    kind: "update_field",
    fieldId: id(4),
    changes: {
      name: "RECORD_ID",
      type: "integer",
      autoIncrement: true,
      clearDefault: true,
    },
  });
});

test("conversion recovery phases retain raw state and safe verification metadata", () => {
  for (const state of [
    "planned",
    "building",
    "staging",
    "staged",
    "running",
    "committed",
    "failed",
    "historical",
    "future_recovery_state",
  ]) {
    const raw = journal(
      "field.convert",
      {
        type: "integer",
        conversion: { strategy: "strict" },
        context: { privateKey: "secret" },
      },
      state,
    );
    const output = mapSchemaJournal({
      ...raw,
      plan: {
        shadow: "secret-shadow-generation",
        fieldId: id(4),
        nextField: { ...field, type: "integer", charLimit: undefined },
        transactional: false,
      },
    });
    assert.equal(output.state, state);
    assert.equal(
      output.phase,
      ["building", "staging", "staged", "running"].includes(state)
        ? "running"
        : state === "future_recovery_state"
          ? "unknown"
          : state,
    );
    assert.deepEqual(output.change, {
      kind: "update_field",
      fieldId: id(4),
      changes: { type: "integer" },
      conversion: "lossless",
    });
    assert.equal(output.verification.fieldId, id(4));
    assert.equal(output.verification.transactional, false);
    assert.equal(
      JSON.stringify(output).includes("secret-shadow-generation"),
      false,
    );
  }
});

test("non-field schema operations have typed requests without invented field changes", () => {
  const inputs: [string, unknown][] = [
    ["database.create", { name: "MDM", description: "" }],
    ["database.update", { name: "MDM" }],
    ["database.delete", { context: {} }],
    [
      "table.create",
      {
        name: "Airlines",
        fields: [{ name: "CODE", type: "text" }],
      },
    ],
    ["table.update", { description: null }],
    ["table.delete", { expectedSchemaVersion: 3 }],
    ["rule.create", { fieldIds: [id(4)], name: "Code uniqueness" }],
    ["rule.delete", { expectedSchemaVersion: 3 }],
  ];
  for (const [kind, input] of inputs) {
    const output = mapSchemaJournal(journal(kind, input), {
      request: { id: id(9) },
    });
    assert.equal(output.request.kind, kind);
    assert.equal(output.change, undefined);
    assert.equal(SchemaOperationReportSchema.safeParse(output).success, true);
  }
  const unknown = mapSchemaJournal(
    journal("future.kind", {
      name: "secret-unknown-business-payload",
      ddl: "private SQL",
    }),
  );
  assert.equal(unknown.kind, "future.kind");
  assert.deepEqual(unknown.request, { kind: "unknown" });
  assert.equal(JSON.stringify(unknown).includes("private SQL"), false);
  const initial = mapSchemaJournal({
    ...journal("table.create", { name: "Airlines", fields: [] }),
    before_definition: null,
    expected_version: null,
  });
  assert.equal(initial.before, null);
  assert.equal(initial.expectedSchemaVersion, null);
});

test("schema journal failures retain safe codes and never leak SQL or actor context", () => {
  const raw = journal("table.update", { name: "Airlines" }, "failed");
  const report = mapSchemaJournal({
    ...raw,
    committed_at: null,
    error: {
      code: "RECOVERED_PRE_CUTOVER",
      message: "secret postgres relation rst_physical SQL",
      retryable: true,
      stack: "secret-stack",
    },
  });
  assert.equal(report.error?.code, "RECOVERED_PRE_CUTOVER");
  assert.equal(report.error?.retryable, true);
  assert.equal(report.committedAt, null);
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.equal(
    mapSchemaJournal({
      ...raw,
      error: { code: "23505", message: "SQL constraint" },
    }).error?.code,
    "SCHEMA_OPERATION_FAILED",
  );
  assert.throws(
    () => mapSchemaJournal({ ...raw, id: "invalid" }),
    (error) => error instanceof RootsetError && error.code === "INTERNAL_ERROR",
  );
});
