import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  CanonicalUtcDateTimeSchema,
  AccountActionSchema,
  AccountActionTypeSchema,
  JsonValueSchema,
  ImportMappingSchema,
  OperatorRepairAccountActionSchema,
  OperatorRepairIntentSchema,
  ErrorCodeSchema,
  FieldDefinitionSchema,
  FieldInputSchema,
  FieldNameSchema,
  ActorSchema,
  KeyMetadataSchema,
  assertFieldNames,
  IdSchema,
  QuerySpecSchema,
  RootsetError,
  RowSchema,
  VersionSchema,
  assertRowBytes,
  assertValueLexemes,
  assertFieldDefinitionLexemes,
  assertSchemaNumberLexemes,
  assertQueryLexemes,
  analyseNumberLexeme,
  canonicalJson,
  canonicalValue,
  decodeJsonBytes,
  errorEnvelope,
  generateClientSource,
  generateCoverageInventory,
  generateMcpTools,
  generateOpenApi,
  getRuntimeOperation,
  limits,
  newId,
  operationMap,
  operations,
  operationExample,
  ProtocolAdapterInventory,
  parseStrictJson,
  parseUtcDateTime,
  parseUtcTime,
  rowBytes,
  validateCell,
  validateQuery,
  validateValues,
  type FieldDefinition,
  type FilterNode,
  type NumberLexeme,
} from "./index";

const id = "01K6J7B8000000000000000000";
const makeField = (
  type: FieldDefinition["type"],
  extra: Partial<FieldDefinition> = {},
): FieldDefinition => ({ id, name: "CODE", type, ...extra });
const invalid = (call: () => unknown, code = "VALIDATION_FAILED") =>
  assert.throws(
    call,
    (error) => error instanceof RootsetError && error.code === code,
  );

test("unsupported organisation, resource grant, account deletion and team-key operations are absent", () => {
  const removed = [
    "createOrganisation",
    "listOrganisations",
    "switchOrganisation",
    "deleteOrganisation",
    "transferOwnership",
    "getGrants",
    "updateGrants",
    "queryOrganisationAudit",
    "deleteAccount",
    "listTeamKeys",
    "createTeamKey",
    "rotateTeamKey",
    "revokeTeamKey",
    "getBackupPolicy",
    "setBackupPolicy",
    "previewBackupSchedule",
    "getInstallationConfiguration",
    "updateInstallationConfiguration",
    "testEmail",
  ];
  const tools = generateMcpTools();
  const client = generateClientSource();
  for (const name of removed) {
    assert.equal(operationMap[name], undefined);
    assert.throws(() => getRuntimeOperation(name), /Unknown Rootset operation/);
    assert(!client.includes(`async ${name}(`));
  }
  assert.equal(operations.length, 90);
  assert.equal(tools.length, operations.length);
  for (const operation of operations)
    assert.equal(getRuntimeOperation(operation.id), operation);
  assert(!JSON.stringify(generateOpenApi()).includes('"team_key"'));
  assert.equal(
    AccountActionTypeSchema.safeParse("delete_account").success,
    false,
  );
  assert.equal(
    AccountActionTypeSchema.safeParse("transfer_ownership").success,
    false,
  );
  assert.equal(
    AccountActionTypeSchema.safeParse("delete_organisation").success,
    false,
  );
});

test("profile and installation organisation outputs omit removed lifecycle flags", () => {
  const timestamps = {
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
  const profile = {
    id,
    name: "Admin",
    email: "admin@example.test",
    emailVerified: true,
    ...timestamps,
  };
  const organisation = { id, name: "Installation", ...timestamps };
  assert.deepEqual(
    operationMap.getProfile!.outputSchema.parse(profile),
    profile,
  );
  assert.deepEqual(
    operationMap.getOrganisation!.outputSchema.parse(organisation),
    organisation,
  );
  assert.equal(
    operationMap.getProfile!.outputSchema.safeParse({
      ...profile,
      disabled: false,
    }).success,
    false,
  );
  assert.equal(
    operationMap.getOrganisation!.outputSchema.safeParse({
      ...organisation,
      state: "active",
    }).success,
    false,
  );
});

test("IDs are valid, opaque, normalised ULIDs and decimal revisions preserve bigint precision", () => {
  const ids = new Set(Array.from({ length: 5000 }, newId));
  assert.equal(ids.size, 5000);
  for (const value of ids) assert.equal(IdSchema.parse(value), value);
  assert.equal(IdSchema.parse(id.toLowerCase()), id);
  for (const value of ["8".repeat(26), "01K6J7B800000000000000000O", "123", ""])
    assert.equal(IdSchema.safeParse(value).success, false);
  assert.equal(
    VersionSchema.parse("9223372036854775807"),
    "9223372036854775807",
  );
  for (const value of ["0", "-1", "01", "9223372036854775808"])
    assert.equal(VersionSchema.safeParse(value).success, false);
});

test("all field variants reject unknown options and validate bounds and defaults", () => {
  for (const type of [
    "text",
    "integer",
    "float",
    "boolean",
    "date",
    "time",
    "date-time",
    "json",
  ] as const)
    assert.equal(FieldDefinitionSchema.parse(makeField(type)).type, type);
  assert.equal(
    FieldDefinitionSchema.safeParse(makeField("boolean", { min: 1 })).success,
    false,
  );
  assert.equal(
    FieldDefinitionSchema.safeParse(makeField("integer", { min: 2, max: 1 }))
      .success,
    false,
  );
  assert.equal(
    FieldDefinitionSchema.safeParse(
      makeField("text", { charLimit: 2, default: "long" }),
    ).success,
    false,
  );
  assert.equal(
    FieldDefinitionSchema.safeParse(
      makeField("text", { required: true, default: null }),
    ).success,
    false,
  );
  assert.equal(
    FieldInputSchema.safeParse({
      name: "CODE",
      type: "integer",
      default: 1.2,
    }).success,
    false,
  );
  assert.equal(
    FieldInputSchema.safeParse({
      name: "CODE1",
      type: "integer",
    }).success,
    false,
  );
  const utcBound = FieldDefinitionSchema.parse(
    makeField("date-time", { min: "2020-01-01T00:00:00Z" }),
  );
  assert.equal("min" in utcBound && utcBound.min, "2020-01-01T00:00:00.000Z");
});

test("text character limits count Unicode scalar values while byte limits count UTF-8", () => {
  assert.equal(validateCell(makeField("text", { charLimit: 2 }), "😀é"), "😀é");
  invalid(() => validateCell(makeField("text", { charLimit: 1 }), "😀é"));
  invalid(() => validateCell(makeField("text"), "\ud800"));
  invalid(() => validateCell(makeField("text"), "bad\u0000text"));
  assert.equal(
    rowBytes([makeField("text")], { CODE: "😀" }),
    new TextEncoder().encode(`{"${id}":"😀"}`).byteLength,
  );
});

test("nullable, missing, zero, false, empty string and patch omission are distinct", () => {
  const fields = [
    makeField("integer", { default: 0 }),
    makeField("boolean", { id: newId(), name: "ACTIVE" }),
    makeField("text", { id: newId(), name: "TEXT" }),
  ];
  assert.deepEqual(
    { ...validateValues(fields, {}) },
    { CODE: 0, ACTIVE: null, TEXT: null },
  );
  assert.deepEqual(
    { ...validateValues(fields, { CODE: null, ACTIVE: false, TEXT: "" }) },
    { CODE: null, ACTIVE: false, TEXT: "" },
  );
  assert.deepEqual(
    { ...validateValues(fields, { ACTIVE: false }, "patch") },
    { ACTIVE: false },
  );
  invalid(() => validateValues([makeField("integer", { required: true })], {}));
  invalid(() => validateValues(fields, { row_id: id }));
  invalid(() => validateValues(fields, { CODE: undefined }));
  invalid(() => validateValues(fields, { CODE: 1, [id]: 2 }));
  assert.equal(validateValues(fields, { [id]: 3 }).CODE, 3);
});

test("numbers are never coerced and their inclusive min/max rules are enforced", () => {
  const integer = makeField("integer", { min: -2, max: 2 });
  for (const value of [-2, 0, 2])
    assert.equal(validateCell(integer, value), value);
  for (const value of [
    -3,
    3,
    1.1,
    "1",
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    NaN,
  ])
    invalid(() => validateCell(integer, value));
  assert.equal(
    validateCell(makeField("integer"), Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    validateCell(makeField("float", { min: -1.5, max: 1.5 }), 1.5),
    1.5,
  );
  assert.equal(validateCell(makeField("float"), 1e20), 1e20);
  assert.doesNotThrow(() => rowBytes([makeField("float")], { CODE: 1e20 }));
  assert.equal(Object.is(validateCell(makeField("float"), -0), -0), false);
  invalid(() => validateCell(makeField("float"), "1.5"));
});

test("UTC-only time and date-time canonicalise permitted fractions and reject local/offset/leap values", () => {
  assert.equal(parseUtcTime("00:00:00Z"), "00:00:00.000Z");
  assert.equal(parseUtcTime("23:59:59.1Z"), "23:59:59.100Z");
  assert.equal(
    parseUtcDateTime("0001-01-01T00:00:00.12Z"),
    "0001-01-01T00:00:00.120Z",
  );
  assert.equal(
    parseUtcDateTime("2024-02-29T00:00:00Z"),
    "2024-02-29T00:00:00.000Z",
  );
  for (const value of [
    "24:00:00Z",
    "23:59:60Z",
    "00:00:00",
    "00:00:00+00:00",
    "00:00:00.1234Z",
  ])
    invalid(() => parseUtcTime(value));
  for (const value of [
    "2023-02-29T00:00:00Z",
    "0000-01-01T00:00:00Z",
    "2024-01-01 00:00:00Z",
    "2024-01-01T00:00:00+00:00",
  ])
    invalid(() => parseUtcDateTime(value));
  for (const value of ["2023-02-29", "1900-02-29", "2024-13-01", "0000-01-01"])
    invalid(() => validateCell(makeField("date"), value));
  assert.equal(validateCell(makeField("date"), "2000-02-29"), "2000-02-29");
  assert.equal(
    CanonicalUtcDateTimeSchema.safeParse("2023-02-29T00:00:00.000Z").success,
    false,
  );
});

test("temporal field bounds are inclusive and canonical request serialisation does not change calendar dates", () => {
  const field = makeField("date-time", {
    min: "2024-01-01T00:00:00.100Z",
    max: "2024-01-01T00:00:00.200Z",
  });
  assert.equal(
    validateCell(field, "2024-01-01T00:00:00.1Z"),
    "2024-01-01T00:00:00.100Z",
  );
  invalid(() => validateCell(field, "2024-01-01T00:00:00Z"));
  assert.equal(
    validateCell(
      makeField("date", { min: "2024-01-01", max: "2024-01-02" }),
      "2024-01-02",
    ),
    "2024-01-02",
  );
});

test("canonical JSON ignores object ordering and spelling, retains array order and nested null", () => {
  assert.equal(
    canonicalJson({ b: 2, a: { z: false, x: null } }),
    canonicalJson({ a: { x: null, z: false }, b: 2.0 }),
  );
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson({ a: -0 }), '{"a":0}');
  assert.deepEqual(
    validateCell(makeField("json"), { b: null, a: [0, false, ""] }),
    { a: [0, false, ""], b: null },
  );
  invalid(() =>
    validateCell(makeField("json"), { unsafe: Number.MAX_SAFE_INTEGER + 1 }),
  );
  for (const value of [
    undefined,
    new Date(),
    { value: undefined },
    [Infinity],
    new Array(2),
  ])
    invalid(() => canonicalValue(value));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  invalid(() => canonicalJson(cycle));
});

test("JSON cells and dictionary adapters preserve own prototype-named keys without pollution", () => {
  const input = parseStrictJson(
    '{"__proto__":{"marker":"preserved"},"constructor":{"prototype":{"marker":"ordinary"}},"a":1}',
  );
  assert.equal(
    JSON.stringify(JsonValueSchema.parse(input)),
    JSON.stringify(input),
  );
  const field = makeField("json", { name: "META" });
  const parsed = operationMap.createRow!.inputSchema.parse({
    ...operationExample(operationMap.createRow!),
    values: { META: input },
  }) as { values: Record<string, unknown> };
  assert.equal(
    canonicalJson(validateValues([field], parsed.values).META),
    canonicalJson(input),
  );
  assert.deepEqual(Object.keys(parsed.values.META as object), [
    "__proto__",
    "constructor",
    "a",
  ]);
  assert.equal(({} as { marker?: string }).marker, undefined);
  const mapped = ImportMappingSchema.parse(
    parseStrictJson('{"__proto__":"META","constructor":"CODE"}'),
  );
  assert.equal(Object.hasOwn(mapped, "__proto__"), true);
  assert.equal(mapped.__proto__, "META");
  const unknownValues = parseStrictJson('{"__proto__":1}');
  assert.equal(
    operationMap.createRow!.inputSchema.safeParse({
      ...operationExample(operationMap.createRow!),
      values: unknownValues,
    }).success,
    false,
  );
  invalid(() => validateValues([field], unknownValues));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(JsonValueSchema.safeParse(cycle).success, false);
  assert.equal(JsonValueSchema.safeParse([, 1]).success, false);
  assert.equal(JsonValueSchema.safeParse({ date: new Date() }).success, false);
});

test("JSON has an exact nesting cap and full-depth cells remain valid inside stable-ID row measurement", () => {
  let value: unknown = 1;
  for (let i = 0; i < 32; i++) value = [value];
  assert.doesNotThrow(() => validateCell(makeField("json"), value));
  assert.doesNotThrow(() =>
    rowBytes([makeField("json")], { CODE: value as never }),
  );
  invalid(() => validateCell(makeField("json"), [value]));
});

test("row budget boundary includes every null cell and stable field-key byte", () => {
  const field = makeField("text", { charLimit: 65536 });
  const overhead = rowBytes([field], { CODE: "" });
  const atLimit = { CODE: "a".repeat(limits.rowBytes - overhead) };
  assert.equal(assertRowBytes([field], atLimit), 65536);
  invalid(
    () => assertRowBytes([field], { CODE: atLimit.CODE + "a" }),
    "ROW_SIZE_LIMIT",
  );
  assert.equal(
    rowBytes([field], {}),
    new TextEncoder().encode(`{"${id}":null}`).byteLength,
  );
  assert.equal(
    rowBytes([{ ...field, name: "RENAMED" }], {
      RENAMED: atLimit.CODE,
    }),
    65536,
  );
});

test("strict decoder rejects duplicate decoded keys, malformed Unicode, invalid UTF-8 and unsafe integer lexemes", () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"a":}',
    "[1,]",
    "01",
    "true false",
    '"\\ud800"',
    '"\\u0000"',
    "9007199254740993",
    "9007199254740993.0",
    "9.007199254740993e15",
    "1e309",
  ])
    invalid(() => parseStrictJson(text));
  assert.equal(parseStrictJson("9007199254740991"), 9007199254740991);
  assert.equal(parseStrictJson("1.25e1"), 12.5);
  assert.equal(parseStrictJson("1e20", { safeIntegers: false }), 1e20);
  assert.equal(parseStrictJson("-0"), 0);
  assert.equal(
    (
      parseStrictJson('{"__proto__":{"polluted":true}}') as Record<
        string,
        unknown
      >
    ).__proto__ !== undefined,
    true,
  );
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  invalid(() => decodeJsonBytes(new Uint8Array([0xc0, 0xaf])));
  invalid(() => parseStrictJson('"😀"', { maxBytes: 5 }), "PAYLOAD_TOO_LARGE");
  invalid(() => parseStrictJson("[[[0]]]", { maxDepth: 2 }));
});

test("numeric lexemes preserve fractional source intent while allowing finite float cells", () => {
  const lexemes: NumberLexeme[] = [];
  const decoded = parseStrictJson(
    '{"values":{"CODE":9007199254740990.5,"FLOAT":1e100,"JSON":{"a/b~c":9007199254740993}},"query":{"limit":1.0000000000000001}}',
    {
      safeIntegers: false,
      onNumber: (information) => lexemes.push(information),
    },
  );
  assert.equal(lexemes[0]!.value, 9007199254740990);
  assert.equal(lexemes[0]!.integer, false);
  assert.equal(lexemes[2]!.pointer, "/values/JSON/a~1b~0c");
  invalid(() => assertValueLexemes([makeField("integer")], lexemes));
  assert.doesNotThrow(() =>
    assertValueLexemes([makeField("float", { name: "FLOAT" })], lexemes),
  );
  invalid(() =>
    assertValueLexemes([makeField("json", { name: "JSON" })], lexemes),
  );
  invalid(() =>
    assertSchemaNumberLexemes(operationMap.queryRows!.inputSchema, lexemes),
  );
  assert.equal(typeof decoded, "object");
  assert.equal(analyseNumberLexeme("12.0").safeInteger, true);
  assert.equal(analyseNumberLexeme("1.2e1").safeInteger, true);
  assert.equal(analyseNumberLexeme("1e-999").integer, false);
  assert.equal(analyseNumberLexeme("0e9999999").safeInteger, true);
  assert.equal(analyseNumberLexeme("-9007199254740991").safeInteger, true);
  invalid(() =>
    assertFieldDefinitionLexemes(
      makeField("integer"),
      [analyseNumberLexeme("1.0000000000000001", ["field", "default"])],
      ["field"],
    ),
  );
});

test("query numeric lexemes validate integer predicates and JSON paths without restricting floats", () => {
  const fields = [
    makeField("integer"),
    makeField("json", { id: newId(), name: "META" }),
    makeField("float", { id: newId(), name: "SCORE" }),
  ];
  function check(text: string, path: (string | number)[] = ["query"]): void {
    const lexemes: NumberLexeme[] = [];
    const decoded = parseStrictJson(text, {
      safeIntegers: false,
      onNumber: (value) => lexemes.push(value),
    }) as Record<string, unknown>;
    const query = QuerySpecSchema.parse(decoded.query);
    assertQueryLexemes(fields, query, lexemes, path);
  }
  check('{"query":{"where":{"field":"CODE","op":"eq","value":1.2e1}}}');
  check('{"query":{"where":{"field":"SCORE","op":"eq","value":1e100}}}');
  invalid(() =>
    check(
      '{"query":{"where":{"field":"CODE","op":"eq","value":9007199254740990.5}}}',
    ),
  );
  invalid(() =>
    check(
      '{"query":{"where":{"and":[{"field":"CODE","op":"between","value":[1,1.0000000000000001]}]}}}',
    ),
  );
  invalid(() =>
    check(
      `{"query":{"where":{"or":[{"field":"${id.toLowerCase()}","op":"in","value":[9007199254740993]}]}}}`,
    ),
  );
  invalid(() =>
    check(
      '{"query":{"where":{"field":"META","op":"pathEq","path":["count"],"value":9007199254740993}}}',
    ),
  );
  invalid(() =>
    check(
      '{"query":{"where":{"field":"META","op":"jsonContains","value":{"nested":[1e20]}}}}',
    ),
  );
  check(
    '{"query":{"where":{"field":"META","op":"jsonContains","value":{"score":0.1}}}}',
  );
  const query = QuerySpecSchema.parse({
    where: { field: "CODE", op: "eq", value: 12 },
  });
  invalid(() =>
    assertQueryLexemes(
      fields,
      query,
      [
        analyseNumberLexeme("9007199254740990.5", [
          "export",
          "query",
          "where",
          "value",
        ]),
      ],
      ["export", "query"],
    ),
  );
  assertQueryLexemes(fields, query, [
    analyseNumberLexeme("9007199254740990.5", [
      "other",
      "query",
      "where",
      "value",
    ]),
  ]);
});

test("typed query validation supports all documented field operators without applying data bounds to filters", () => {
  const fields = [
    makeField("integer", { min: 10, max: 20 }),
    makeField("text", { id: newId(), name: "NAME" }),
    makeField("date-time", { id: newId(), name: "TIME" }),
    makeField("json", { id: newId(), name: "META" }),
  ];
  const query = validateQuery(
    {
      where: {
        and: [
          { field: "CODE", op: "gt", value: 1000 },
          { field: "TIME", op: "eq", value: "2024-01-01T00:00:00Z" },
          { field: "META", op: "pathEq", path: ["a", 0], value: false },
        ],
      },
      orderBy: [{ field: "NAME", direction: "asc" }],
      limit: 1,
    },
    fields,
  );
  assert.equal(
    query.where &&
      "and" in query.where &&
      query.where.and[1] &&
      "value" in query.where.and[1]
      ? query.where.and[1].value
      : undefined,
    "2024-01-01T00:00:00.000Z",
  );
  for (const where of [
    { field: "CODE", op: "contains", value: "1" },
    { field: "MISSING", op: "eq", value: 1 },
    { field: "CODE", op: "eq", value: null },
    { field: "CODE", op: "between", value: [2, 1] },
    { field: "CODE", op: "in", value: [] },
    { field: "CODE", op: "isNull", value: null },
    { field: "META", op: "pathExists", path: [] },
    { field: "NAME", op: "eq", path: ["a"], value: "x" },
  ])
    invalid(() => validateQuery({ where }, fields));
  invalid(() => validateQuery({ select: ["CODE", id] }, fields));
  invalid(() =>
    validateQuery({ orderBy: [{ field: "META", direction: "asc" }] }, fields),
  );
});

test("query stable-ID aliases normalise to the same name projection/filter/sort", () => {
  const fields = [makeField("integer")];
  const ids = validateQuery(
    {
      select: [id.toLowerCase()],
      where: { and: [{ field: id.toLowerCase(), op: "in", value: [1, 2] }] },
      orderBy: [{ field: id, direction: "asc" }],
    },
    fields,
  );
  assert.deepEqual(
    ids,
    validateQuery(
      {
        select: ["CODE"],
        where: { and: [{ field: "CODE", op: "in", value: [1, 2] }] },
        orderBy: [{ field: "CODE", direction: "asc" }],
      },
      fields,
    ),
  );
  assert.equal(
    (ids.where as { and: { field: string }[] }).and[0]?.field,
    "CODE",
  );
});

test("upload contracts retain exact method and byte limits", () => {
  const upload = operationMap.prepareImportUpload!.outputSchema.parse({
    artifactId: id,
    uploadUrl: "http://localhost:9000/signed-upload",
    expiresAt: "2026-10-02T00:00:00.000Z",
    maxBytes: 134217728,
    method: "PUT",
    headers: { "content-type": "text/csv" },
    byteLength: 1001,
  });
  assert.equal((upload as { method: string }).method, "PUT");
  assert.equal(
    operationMap.prepareImportUpload!.outputSchema.safeParse({
      ...(upload as object),
      method: "POST",
    }).success,
    false,
  );
  assert.equal(
    operationMap.prepareImportUpload!.outputSchema.safeParse({
      ...(upload as object),
      byteLength: 134217729,
    }).success,
    false,
  );
});

test("usage rejects removed quota and storage-admission fields", () => {
  const usage = {
    databases: 1,
    tables: 2,
    rows: 10,
    dataBytes: 100,
    indexBytes: 40,
    historyBytes: 20,
    artifactBytes: 30,
  };
  assert.deepEqual(operationMap.getUsage!.outputSchema.parse(usage), usage);
  assert.equal(
    operationMap.getUsage!.outputSchema.safeParse({
      ...usage,
      storageQuotaBytes: 9223372036854775807,
    }).success,
    false,
  );
  assert.equal(
    operationMap.getUsage!.outputSchema.safeParse({
      ...usage,
      storageAdmission: { state: "available", reason: null },
    }).success,
    false,
  );
  const status = {
    healthy: false,
    version: "0.1.0",
    migrationVersion: "001",
    dependencies: { database: "unavailable", objectStorage: "unavailable" },
    workerHeartbeatAt: null,
    metrics: {
      collectedAt: "2026-10-02T00:00:00.000Z",
      processStartedAt: "2026-10-02T00:00:00.000Z",
      uptimeSeconds: 0,
      requestCounterScope: "process_since_start",
      requests: {
        total: 0,
        errors: 0,
        timeouts: 0,
        rowLimitRejections: 0,
        rateLimitRejections: 0,
        loggingFailures: 0,
        operations: [],
      },
      pools: {},
      databaseStatus: "unavailable",
      database: null,
      signals: [],
    },
  };
  assert.deepEqual(
    operationMap.getInstallationStatus!.outputSchema.parse(status),
    status,
  );
  const { metrics, ...missingMetrics } = status;
  assert.equal(typeof metrics, "object");
  assert.equal(
    operationMap.getInstallationStatus!.outputSchema.safeParse(missingMetrics)
      .success,
    false,
  );
});

test("ordinary JSON budgets retain 8 MiB input, a separate read deadline and unchanged result/binary budgets", () => {
  assert.equal(limits.requestBytes, 8_388_608);
  assert.equal(limits.requestTimeoutMs, 10_000);
  assert.equal(limits.restResultBytes, 8_388_608);
  assert.equal(limits.mcpResultBytes, 1_048_576);
  assert.equal(ErrorCodeSchema.parse("REQUEST_TIMEOUT"), "REQUEST_TIMEOUT");
  const document = generateOpenApi() as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const query = document.paths[operationMap.queryRows!.path]!.post!;
  assert.equal(query["x-rootset-json-request-max-bytes"], limits.requestBytes);
  assert.equal(
    query["x-rootset-json-read-timeout-ms"],
    limits.requestTimeoutMs,
  );
  assert.ok((query.responses as Record<string, unknown>)["408"]);
  const upload = document.paths["/v1/orgs/{orgId}/artifacts/{id}/upload"]!.put!;
  assert.equal(upload["x-rootset-max-bytes"], 134_217_728);
  assert.equal(upload["x-rootset-json-read-timeout-ms"], undefined);
  const tool = generateMcpTools().find(
    (value) => value.name === "rootset_query_rows",
  )!;
  assert.equal(
    (tool._meta as Record<string, unknown>)["rootset.fyi/jsonRequestMaxBytes"],
    limits.requestBytes,
  );
  const client = generateClientSource();
  assert.ok(client.includes("export const transportLimits"));
  assert.ok(client.includes('"jsonReadTimeoutMs": 10000'));
  const proxy = ProtocolAdapterInventory.find(
    (value) => value.kind === "reverse_proxy",
  )!;
  assert.equal(proxy.upstream, "configured-api-only");
  assert.equal(proxy.jsonRequestMaxBytes, limits.requestBytes);
  assert.equal(proxy.jsonReadTimeoutMs, limits.requestTimeoutMs);
  assert.equal(proxy.requestHeaderMaxBytes, 196_608);
  assert.equal(proxy.streamedResponses, true);
  assert.equal(proxy.binaryUpload.maxBytes, 134_217_728);
});

test("query AST budgets reject deep object input before recursive Zod traversal", () => {
  let where: FilterNode = { field: "CODE", op: "eq", value: 1 };
  for (let i = 0; i < 20_000; i++) where = { and: [where] };
  invalid(() => QuerySpecSchema.parse({ where }));
  invalid(() =>
    validateQuery(
      {
        where: {
          or: Array.from({ length: 101 }, () => ({
            field: "CODE",
            op: "eq",
            value: 1,
          })),
        },
      },
      [makeField("integer")],
    ),
  );
  for (const limit of [0, -1, 25001, 1.5])
    assert.equal(QuerySpecSchema.safeParse({ limit }).success, false);
  for (const limit of [1, 1000, 5000, 25000])
    assert.equal(QuerySpecSchema.safeParse({ limit }).success, true);
  assert.equal(QuerySpecSchema.safeParse({ sql: "DROP TABLE" }).success, false);
});

test("catalog covers every named baseline MCP operation with unique routes and strict envelopes", () => {
  const brief = readFileSync(
    fileURLToPath(
      new URL("../../../rc-plan/API_AND_MCP_ARCHITECTURE.md", import.meta.url),
    ),
    "utf8",
  );
  const promised = [...new Set(brief.match(/rootset_[a-z_]+/g))];
  const missing = promised.filter(
    (name) => !operations.some((operation) => operation.toolName === name),
  );
  assert.deepEqual(missing, []);
  assert.equal(
    new Set(operations.map((operation) => operation.id)).size,
    operations.length,
  );
  assert.equal(
    new Set(operations.map((operation) => operation.toolName)).size,
    operations.length,
  );
  assert.equal(
    new Set(
      operations.map(
        (operation) => `${operation.httpMethod} ${operation.path}`,
      ),
    ).size,
    operations.length,
  );
  assert.equal(operationMap.queryRows!.readOnly, true);
  assert.equal(operationMap.getInstallationStatus!.readOnly, true);
  assert.equal(operationMap.createRow!.readOnly, false);
  assert.equal(operationMap.createTeamKey, undefined);
  const indexInput = operationExample(operationMap.createIndex!);
  assert.equal(
    operationMap.createIndex!.inputSchema.safeParse(indexInput).success,
    true,
  );
  assert.equal(
    operationMap.createIndex!.inputSchema.safeParse({
      ...indexInput,
      fieldIds: [id, "01ARZ3NDEKTSV4RRFFQ69G5FAW"],
    }).success,
    false,
  );
  assert.equal(
    operationMap.createUniqueRule!.inputSchema.safeParse({
      ...operationExample(operationMap.createUniqueRule!),
      fieldIds: [id, "01ARZ3NDEKTSV4RRFFQ69G5FAW"],
    }).success,
    true,
  );
  for (const operation of operations)
    assert.equal(
      operation.inputSchema.safeParse({ actor: {}, rawSql: "SELECT 1" })
        .success,
      false,
    );
  assert.equal(
    operationMap.createPersonalKey!.inputSchema.safeParse({
      orgId: id,
      name: "bad",
      scopes: ["*"],
      targets: [],
    }).success,
    false,
  );
});

test("published invitation authority requires an admin and only supported membership roles", () => {
  const definition = operationMap.inviteMember!;
  assert.equal(definition.personal, true);
  assert.equal(definition.minimumRole, "admin");
  assert.deepEqual(definition.scopes, ["members:manage"]);
  assert.ok(definition.errors.includes("PERSONAL_IDENTITY_REQUIRED"));
  assert.ok(definition.description.includes("as an admin"));
  for (const internal of [false, true]) {
    const spec = generateOpenApi({ internal });
    const paths = spec.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const path = internal
      ? definition.path.replace(/^\/v1/, "/api/internal/v1")
      : definition.path;
    const operation = paths[path]!.post!;
    assert.equal(operation["x-rootset-personal"], true);
    assert.equal(operation["x-rootset-minimum-role"], "admin");
    assert.ok(
      (operation["x-rootset-error-codes"] as string[]).includes(
        "PERSONAL_IDENTITY_REQUIRED",
      ),
    );
  }
  const tool = generateMcpTools().find(
    (entry) => entry.name === definition.toolName,
  )!;
  assert.equal(tool.description, definition.description);
  assert.ok(
    (
      (tool._meta as Record<string, unknown>)[
        "rootset.fyi/errorCodes"
      ] as string[]
    ).includes("PERSONAL_IDENTITY_REQUIRED"),
  );
  const inventory = generateCoverageInventory().find(
    (entry) => entry.operationId === definition.id,
  )!;
  assert.equal(inventory.personal, true);
  assert.equal(inventory.role, "admin");
  for (const id of ["listInvitations", "cancelInvitation", "updateMember"])
    assert.equal(operationMap[id]!.personal, false);
  assert.equal(
    definition.inputSchema.safeParse({
      ...operationExample(definition),
      role: "owner",
    }).success,
    false,
  );
});

test("mixed destructive tools and actual protocol routes have conservative explicit metadata", () => {
  const tools = generateMcpTools();
  for (const name of [
    "mutateRows",
    "applySchemaChange",
    "restoreBackup",
    "completeAccountAction",
    "archiveHistory",
  ]) {
    const definition = operationMap[name]!;
    const tool = tools.find((entry) => entry.name === definition.toolName)!;
    assert.equal(
      (tool.annotations as { destructiveHint: boolean }).destructiveHint,
      true,
    );
  }
  assert.equal(operationMap.revokeSession!.stepUp, "never");
  for (const name of ["listJobs", "listBackups", "listHistoryArchives"]) {
    const definition = operationMap[name]!;
    assert.equal(
      definition.inputSchema.safeParse({
        ...operationExample(definition),
        limit: 100,
      }).success,
      true,
    );
    assert.equal(
      definition.inputSchema.safeParse({
        ...operationExample(definition),
        limit: 101,
      }).success,
      false,
    );
  }
  const source = readFileSync(
    new URL("../../../apps/rootset-api/src/app.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "app.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const actual = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(ast) === "app" &&
      ["get", "post", "put", "all", "on"].includes(node.expression.name.text)
    ) {
      const path = node.arguments.find(
        (argument) =>
          ts.isStringLiteral(argument) && argument.text.startsWith("/"),
      );
      if (path && ts.isStringLiteral(path))
        actual.add(path.text.replace(/:([^/]+)/g, "{$1}"));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const declared = new Set(
    ProtocolAdapterInventory.map((adapter) => adapter.path),
  );
  assert.deepEqual(
    [...actual].filter((path) => !declared.has(path)),
    [],
  );
});

test("OpenAPI, MCP and coverage are generated from the same operation inventory with resolved local references", () => {
  const document = generateOpenApi() as {
    openapi: string;
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: { schemas: Record<string, unknown> };
  };
  assert.equal(document.openapi, "3.1.2");
  const paths = Object.values(document.paths).flatMap((path) =>
    Object.values(path),
  );
  assert.equal(paths.length, operations.length + 2);
  assert.ok(
    paths.some((operation) => operation.operationId === "uploadArtifactBytes"),
  );
  const browserDownloadPath =
    "/api/internal/v1/orgs/{orgId}/artifacts/{id}/download";
  assert.equal(document.paths[browserDownloadPath], undefined);
  const internal = generateOpenApi({ internal: true }) as typeof document;
  const browserDownload = internal.paths[browserDownloadPath]!.get!;
  assert.equal(browserDownload.operationId, "downloadBrowserArtifactBytes");
  assert.deepEqual(browserDownload.security, [{ browserSession: [] }]);
  assert.equal(browserDownload["x-rootset-mcp-audience-handoff"], false);
  assert.equal(browserDownload["x-rootset-browser-session-only"], true);
  assert.deepEqual(
    document.paths["/v1/orgs/{orgId}/artifacts/{id}/download"]!.get!.security,
    [{ apiKey: [] }, { oauth: [] }],
  );
  for (const operation of paths)
    assert.equal(typeof operation.operationId, "string");
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === "string") {
      assert.ok(record.$ref.startsWith("#/components/schemas/"), record.$ref);
      const path = record.$ref.slice(2).split("/");
      let target: unknown = document;
      for (const segment of path)
        target = (target as Record<string, unknown>)[segment];
      assert.notEqual(target, undefined, record.$ref);
    }
    Object.values(record).forEach(walk);
  }
  walk(document);
  const tools = generateMcpTools();
  assert.equal(tools.length, operations.length);
  const queryTool = tools.find((tool) => tool.name === "rootset_query_rows")!;
  assert.equal(
    (queryTool.annotations as Record<string, unknown>).readOnlyHint,
    true,
  );
  const createTool = tools.find((tool) => tool.name === "rootset_create_row")!;
  assert.ok(
    (
      (createTool.inputSchema as Record<string, unknown>).required as string[]
    ).includes("idempotencyKey"),
  );
  for (const tool of tools)
    assert.equal((tool.outputSchema as Record<string, unknown>).type, "object");
  assert.equal(generateCoverageInventory().length, operations.length);
  const client = generateClientSource();
  assert.ok(client.includes("export type queryRowsInput"));
  assert.ok(client.includes("Promise<createRowOutput>"));
  assert.ok(client.includes("Idempotency-Key"));
});

test("every generated request example validates against its actual operation schema", () => {
  for (const operation of operations)
    assert.doesNotThrow(
      () => operation.inputSchema.parse(operationExample(operation)),
      operation.id,
    );
});

test("operator repair publishes revision-bound update inputs and retains ordinary batch behavior", () => {
  const operation = operationMap.mutateRows!;
  const target = {
    orgId: id,
    databaseId: id,
    tableId: id,
    expectedSchemaVersion: 1,
  };
  const update = {
    type: "update",
    rowId: id,
    expectedVersion: "9007199254740992",
    values: { CODE: "fixed" },
  };
  const repair = {
    ...target,
    mutations: [update],
    repair: { reason: "  Correct source record  " },
    approvalId: id,
  };
  const parsed = operation.inputSchema.parse(repair) as typeof repair;
  assert.equal(parsed.repair.reason, "Correct source record");
  assert.equal(parsed.mutations[0]!.expectedVersion, "9007199254740992");
  for (const mutation of [
    { type: "create", values: {} },
    { type: "delete", rowId: id, expectedVersion: "1" },
    { type: "update", rowId: id, values: {} },
  ])
    assert.equal(
      operation.inputSchema.safeParse({ ...repair, mutations: [mutation] })
        .success,
      false,
    );
  for (const reason of ["  ", "x".repeat(513)])
    assert.equal(
      operation.inputSchema.safeParse({ ...repair, repair: { reason } })
        .success,
      false,
    );
  assert.equal(
    operation.inputSchema.safeParse({
      ...repair,
      repair: { reason: "x".repeat(512) },
    }).success,
    true,
  );
  assert.equal(
    operation.inputSchema.safeParse({
      ...repair,
      repair: { reason: "fix", proof: "forbidden" },
    }).success,
    false,
  );
  assert.equal(
    operation.inputSchema.safeParse({
      ...repair,
      mutations: Array.from({ length: 1001 }, () => update),
    }).success,
    false,
  );
  assert.equal(
    operation.inputSchema.safeParse({
      ...target,
      mutations: [
        { type: "create", values: {} },
        update,
        { type: "delete", rowId: id, expectedVersion: "1" },
      ],
    }).success,
    true,
  );
  const batch = { mutationId: id, results: [{ type: "update", rowId: id }] };
  const accepted = {
    jobId: id,
    state: "queued",
    statusUrl: `/v1/orgs/${id}/jobs/${id}`,
  };
  assert.equal(operation.outputSchema.safeParse(batch).success, true);
  assert.equal(operation.outputSchema.safeParse(accepted).success, true);
  assert.equal(
    operation.outputSchema.safeParse({ ...accepted, secret: "forbidden" })
      .success,
    false,
  );
  assert.equal(operation.successStatus, 201);
  assert.equal(operation.job, true);
  assert.equal(operation.stepUp, "conditional");
  assert.equal(operation.personal, false);
  assert.equal("operator" in operation, false);
  assert.deepEqual(operation.scopes, ["rows:write"]);
  assert.ok(operation.errors.includes("PERSONAL_IDENTITY_REQUIRED"));
  assert.equal(operation.errors.includes("OPERATOR_REQUIRED"), false);
  assert.ok(operation.errors.includes("STEP_UP_REQUIRED"));
  assert.equal(operations.length, 90);
  const api = generateOpenApi() as {
    paths: Record<
      string,
      Record<
        string,
        { responses: Record<string, unknown>; "x-rootset-step-up": string }
      >
    >;
    components: { schemas: Record<string, { allOf?: unknown[] }> };
  };
  const route = api.paths[operation.path]!.post!;
  assert.ok(route.responses["201"]);
  assert.ok(route.responses["202"]);
  assert.equal(route["x-rootset-step-up"], "conditional");
  assert.deepEqual(api.components.schemas.mutateRowsInput!.allOf, [
    {
      if: { required: ["repair"] },
      then: {
        properties: {
          mutations: { items: { properties: { type: { const: "update" } } } },
        },
      },
    },
  ]);
  const tool = generateMcpTools().find(
    (item) => item.name === "rootset_mutate_rows",
  )!;
  assert.deepEqual(
    (tool.inputSchema as Record<string, unknown>).allOf,
    api.components.schemas.mutateRowsInput!.allOf,
  );
});

test("operator repair approval intent preserves business keys and excludes credentials from its strict envelope", () => {
  const values = JSON.parse(
    '{"password":"business password","token":{"secret":"business secret"},"META":{"__proto__":{"marker":"retained"}}}',
  );
  const intent = {
    orgId: id,
    databaseId: id,
    tableId: id,
    expectedSchemaVersion: 1,
    reason: "Correct master record",
    updates: [{ rowId: id, expectedVersion: "1", values }],
  };
  const pending = {
    id,
    type: "operator_repair",
    state: "pending",
    expiresAt: "2024-01-01T00:00:00.000Z",
    approvalUrl: "https://rootset.example/approve",
    repairIntent: intent,
  };
  assert.equal(
    AccountActionTypeSchema.safeParse("operator_repair").success,
    true,
  );
  for (const schema of [
    OperatorRepairAccountActionSchema,
    AccountActionSchema,
  ]) {
    const parsed = schema.parse(pending);
    assert.equal(
      canonicalJson(parsed.repairIntent!.updates[0]!.values),
      canonicalJson(values),
    );
    assert.equal(
      Object.hasOwn(
        parsed.repairIntent!.updates[0]!.values.META as object,
        "__proto__",
      ),
      true,
    );
    assert.equal(
      schema.safeParse({ ...pending, repairIntent: undefined }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        ...pending,
        state: "approved",
        repairIntent: undefined,
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ ...pending, approvalId: id }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        ...pending,
        repairIntent: { ...intent, approvalId: id },
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ ...pending, result: { secret: "credential" } })
        .success,
      false,
    );
    assert.equal(
      schema.safeParse({
        ...pending,
        state: "consumed",
        repairIntent: undefined,
        result: { jobId: id, state: "queued", statusUrl: "/job" },
      }).success,
      true,
    );
  }
  for (const extra of [
    { cookie: "credential" },
    { token: "credential" },
    { proof: "credential" },
  ])
    assert.equal(
      OperatorRepairIntentSchema.safeParse({ ...intent, ...extra }).success,
      false,
    );
  assert.equal(
    OperatorRepairIntentSchema.safeParse({ ...intent, updates: [] }).success,
    false,
  );
  assert.equal(
    OperatorRepairIntentSchema.safeParse({
      ...intent,
      updates: [{ ...intent.updates[0], type: "create" }],
    }).success,
    false,
  );
  assert.equal(
    AccountActionSchema.safeParse({ ...pending, type: "set_backup_policy" })
      .success,
    false,
  );
});

test("MCP success/error schemas resolve all local definitions and use a typed error alternative", () => {
  for (const tool of generateMcpTools()) {
    const root = tool.outputSchema as Record<string, unknown>;
    function walk(node: unknown): void {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const record = node as Record<string, unknown>;
      if (typeof record.$ref === "string") {
        assert.ok(record.$ref.startsWith("#/$defs/"));
        let resolved: unknown = root;
        for (const segment of record.$ref.slice(2).split("/"))
          resolved = (resolved as Record<string, unknown>)[segment];
        assert.notEqual(
          resolved,
          undefined,
          `${String(tool.name)} ${record.$ref}`,
        );
      }
      Object.values(record).forEach(walk);
    }
    walk(root);
    assert.equal((root.anyOf as unknown[]).length, 2);
  }
});

test("generated typed browser/public client compiles against the actual TypeScript compiler", () => {
  const fileName = "/rootset-contract-generated-client.ts";
  const source = generateClientSource();
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host),
    originalExists = host.fileExists.bind(host);
  host.fileExists = (path) => path === fileName || originalExists(path);
  host.readFile = (path) => (path === fileName ? source : originalRead(path));
  const program = ts.createProgram([fileName], options, host);
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
  assert.deepEqual(
    errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ),
    [],
  );
});

test("generated client executes query/list/mutation adapters with encoded parents and required headers", async () => {
  const source = ts.transpileModule(generateClientSource(), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  const generated = (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )) as {
    RootsetClient: new (
      baseUrl: string,
      options: object,
    ) => {
      queryRows(input: object, options?: object): Promise<unknown>;
      listRows(input: object): Promise<unknown>;
      createRow(input: object, options?: object): Promise<unknown>;
      deleteRow(input: object, options?: object): Promise<unknown>;
    };
  };
  const requests: { url: URL; init: RequestInit }[] = [];
  const client = new generated.RootsetClient("https://rootset.example/", {
    bearer: "test-redacted-token",
    fetch: async (url: URL, init: RequestInit) => {
      requests.push({ url, init });
      return new Response('{"accepted":true}', {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const target = { orgId: id, databaseId: id, tableId: id };
  await client.queryRows({ ...target, query: { limit: 200 } });
  assert.equal(
    requests[0]!.url.pathname,
    `/v1/orgs/${id}/databases/${id}/tables/${id}/query`,
  );
  assert.equal(requests[0]!.init.method, "POST");
  assert.equal(
    new Headers(requests[0]!.init.headers).get("Authorization"),
    "Bearer test-redacted-token",
  );
  assert.deepEqual(JSON.parse(requests[0]!.init.body as string), {
    query: { limit: 200 },
  });
  await client.listRows({ ...target, select: ["CODE"], limit: 1 });
  assert.equal(requests[1]!.url.searchParams.get("select"), '["CODE"]');
  assert.equal(requests[1]!.url.searchParams.get("limit"), "1");
  await assert.rejects(
    client.createRow({ ...target, expectedSchemaVersion: 1, values: {} }),
    /Idempotency-Key/,
  );
  await client.createRow(
    { ...target, expectedSchemaVersion: 1, values: {} },
    { idempotencyKey: "mutation-test-001" },
  );
  assert.equal(
    new Headers(requests[2]!.init.headers).get("Idempotency-Key"),
    "mutation-test-001",
  );
  await client.deleteRow(
    {
      ...target,
      rowId: id,
      expectedSchemaVersion: 1,
      expectedVersion: "9007199254740992",
    },
    { idempotencyKey: "mutation-test-002" },
  );
  assert.equal(
    new Headers(requests[3]!.init.headers).get("If-Match"),
    `"${id}:9007199254740992"`,
  );
});

test("error envelopes expose domain detail but redact unexpected stack/SQL and row timestamps reject noncanonical output", () => {
  const envelope = errorEnvelope(
    new RootsetError("ROW_VERSION_CONFLICT", "Row changed", 409, {
      version: "4",
    }),
    "req",
  );
  assert.deepEqual(envelope, {
    error: {
      code: "ROW_VERSION_CONFLICT",
      message: "Row changed",
      details: { version: "4" },
      requestId: "req",
    },
  });
  assert.equal(
    JSON.stringify(
      errorEnvelope(new Error("password=secret SELECT * FROM users"), "req"),
    ).includes("secret"),
    false,
  );
  assert.equal(
    RowSchema.safeParse({
      id,
      version: "1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      values: {},
    }).success,
    false,
  );
});

test("property names are shared labels and row keys with stable IDs and collision protection", () => {
  for (const name of ["name", "Name", "_name", "_", "A".repeat(64)])
    assert.equal(FieldNameSchema.parse(name), name);
  for (const name of [
    "",
    "A".repeat(65),
    "field1",
    "First Name",
    "field-name",
    "id",
    "VERSION",
    "createdAt",
    "updatedAt",
    "__proto__",
    "constructor",
    "prototype",
  ])
    assert.equal(FieldNameSchema.safeParse(name).success, false, name);
  const field = makeField("text", { name: "first_name" });
  assert.equal(
    FieldDefinitionSchema.safeParse({ ...field, apiKey: "legacy" }).success,
    false,
  );
  assert.equal(
    FieldDefinitionSchema.safeParse({ ...field, label: "legacy" }).success,
    false,
  );
  assert.deepEqual(
    { ...validateValues([field], { first_name: "Ada" }) },
    { first_name: "Ada" },
  );
  const renamed = { ...field, name: "given_name" };
  assert.equal(
    rowBytes([field], { first_name: "Ada" }),
    rowBytes([renamed], { given_name: "Ada" }),
  );
  invalid(() =>
    assertFieldNames([field, { ...field, id: newId(), name: "FIRST_NAME" }]),
  );
  invalid(() =>
    validateQuery({ select: ["first_name"] }, [
      field,
      { ...field, id: newId() },
    ]),
  );
});

test("personal key metadata excludes selected authority and all actors use supported roles", () => {
  const actor = {
    kind: "personal_key",
    id: "personal:key",
    orgId: id,
    userId: id,
    role: "viewer",
    scopes: [],
  };
  assert.equal(ActorSchema.safeParse(actor).success, true);
  for (const extra of [
    { targets: [] },
    { unrestricted: true },
    { operator: true },
    { kind: "team_key" },
    { role: "owner" },
  ])
    assert.equal(ActorSchema.safeParse({ ...actor, ...extra }).success, false);
  const input = {
    orgId: id,
    name: "Automation",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  assert.equal(
    operationMap.createPersonalKey!.inputSchema.safeParse(input).success,
    true,
  );
  for (const extra of [
    { scopes: ["rows:read"] },
    { targets: [] },
    { unrestricted: true },
  ])
    assert.equal(
      operationMap.createPersonalKey!.inputSchema.safeParse({
        ...input,
        ...extra,
      }).success,
      false,
    );
  const key = {
    id,
    orgId: id,
    userId: id,
    name: "Automation",
    prefix: "rs_key_",
    createdAt: "2026-10-05T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  };
  assert.equal(KeyMetadataSchema.safeParse(key).success, true);
  for (const extra of [
    { ownerKind: "team" },
    { scopes: [] },
    { targets: [] },
    { unrestricted: true },
  ])
    assert.equal(
      KeyMetadataSchema.safeParse({ ...key, ...extra }).success,
      false,
    );
  for (const operation of operations)
    if (
      operation.scopes.some(
        (scope) =>
          scope.endsWith(":manage") &&
          !["profile:manage", "keys:manage"].includes(scope),
      )
    )
      assert.equal(operation.minimumRole, "admin", operation.id);
});

test("notification operations derive ownership from the caller and expose bounded personal contracts", () => {
  const list = operationMap.listNotifications!,
    mark = operationMap.markAllNotificationsRead!;
  for (const operation of [list, mark]) {
    assert.equal(operation.personal, true);
    assert.equal(operation.minimumRole, "viewer");
    assert.deepEqual(operation.scopes, ["profile:manage"]);
    assert.equal(operation.stepUp, "never");
    assert.equal(
      operation.inputSchema.safeParse({ userId: id }).success,
      false,
    );
    assert.equal(operation.inputSchema.safeParse({ orgId: id }).success, false);
  }
  assert.equal(list.readOnly, true);
  assert.equal(list.inputSchema.safeParse({ limit: 101 }).success, false);
  assert.equal(list.inputSchema.safeParse({ limit: 100 }).success, true);
  assert.equal(mark.readOnly, false);
  assert.equal(mark.idempotent, true);
  assert.equal(mark.idempotencyRequired, true);
  assert.equal(mark.outputSchema.safeParse({ ok: true }).success, true);
  assert.equal(
    mark.outputSchema.safeParse({ ok: true, secret: "forbidden" }).success,
    false,
  );
});
