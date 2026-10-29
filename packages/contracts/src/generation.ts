import { z } from "zod";
import {
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  RootsetError,
  limits,
} from "./models";
import type { NumberLexeme } from "./decoder";
import {
  operations,
  ProtocolAdapterInventory,
  type OperationDefinition,
} from "./operations";

export type JsonSchemaDocument = Record<string, unknown>;
export function schemaToJsonSchema(schema: z.ZodType): JsonSchemaDocument {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
  }) as JsonSchemaDocument;
}
const numericSchemaCache = new WeakMap<z.ZodType, JsonSchemaDocument>();
export function assertSchemaNumberLexemes(
  schema: z.ZodType,
  lexemes: readonly NumberLexeme[],
): void {
  let document = numericSchemaCache.get(schema);
  if (!document) {
    document = schemaToJsonSchema(schema);
    numericSchemaCache.set(schema, document);
  }
  const root = document;
  function typesAt(
    node: unknown,
    path: readonly (string | number)[],
    seen: Set<string>,
  ): string[] {
    if (!node || typeof node !== "object") return [];
    const part = node as Record<string, unknown>;
    if (typeof part.$ref === "string") {
      const identity = `${part.$ref}:${path.join("/")}`;
      if (seen.has(identity)) return [];
      const next = new Set(seen);
      next.add(identity);
      let resolved: unknown = root;
      for (const segment of part.$ref.slice(2).split("/"))
        resolved = (resolved as Record<string, unknown>)[segment];
      return typesAt(resolved, path, next);
    }
    const alternatives = part.anyOf ?? part.oneOf;
    if (Array.isArray(alternatives))
      return alternatives.flatMap((value) => typesAt(value, path, seen));
    if (!path.length) return typeof part.type === "string" ? [part.type] : [];
    const [key, ...rest] = path;
    if (part.type === "array") return typesAt(part.items, rest, seen);
    if (part.type === "object") {
      const child =
        (part.properties as Record<string, unknown> | undefined)?.[
          String(key)
        ] ?? part.additionalProperties;
      return typesAt(child, rest, seen);
    }
    return [];
  }
  for (const information of lexemes) {
    const numericTypes = typesAt(root, information.path, new Set()).filter(
      (type) => type === "integer" || type === "number",
    );
    if (
      numericTypes.length &&
      numericTypes.every((type) => type === "integer") &&
      (!information.integer || !information.safeInteger)
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "An integer input cannot be rounded from a fractional or unsafe numeric literal",
        422,
        { path: information.pointer },
      );
  }
}
export function schemaExample(schema: z.ZodType): unknown {
  const document = schemaToJsonSchema(schema);
  function example(node: unknown, name: string, depth: number): unknown {
    if (!node || typeof node !== "object" || depth > 12) return null;
    const part = node as Record<string, unknown>;
    if (typeof part.$ref === "string") {
      let resolved: unknown = document;
      for (const segment of part.$ref.slice(2).split("/"))
        resolved = (resolved as Record<string, unknown>)[segment];
      return example(resolved, name, depth + 1);
    }
    if (Object.hasOwn(part, "const")) return part.const;
    if (Array.isArray(part.examples) && part.examples.length)
      return part.examples[0];
    if (Object.hasOwn(part, "default")) return part.default;
    if (Array.isArray(part.enum)) return part.enum[0];
    const union = part.anyOf ?? part.oneOf;
    if (Array.isArray(union)) return example(union[0], name, depth + 1);
    if (part.type === "null") return null;
    if (part.type === "boolean") return false;
    if (part.type === "number" || part.type === "integer")
      return Math.max(
        Number(part.minimum ?? 0),
        Number(part.exclusiveMinimum ?? 0) +
          (part.exclusiveMinimum === undefined ? 0 : 1),
      );
    if (part.type === "string") {
      if (/ids?$/i.test(name) && name !== "clientId" && name !== "operationId")
        return "01K6J7B8000000000000000000";
      if (/version/i.test(name)) return "1";
      if (name === "scopes") return "viewer";
      if (name === "timezone") return "UTC";
      if (name === "locale") return "en-GB";
      if (name === "cron") return "* * * * *";
      if (name === "field") return "CODE";
      if (name === "checksum") return "a".repeat(64);
      if (name === "cursor") return "example-cursor";
      if (
        part.format === "email" ||
        name === "email" ||
        name === "recipient" ||
        name === "from"
      )
        return "admin@example.test";
      if (
        part.format === "uri" ||
        /url$/i.test(name) ||
        name === "audience" ||
        name === "endpoint"
      )
        return "https://rootset.example/";
      if (/at$/i.test(name) || name === "timestamp")
        return "2024-01-01T00:00:00.000Z";
      const minimum = Math.max(1, Number(part.minLength ?? 1));
      return "example".padEnd(minimum, "x");
    }
    if (part.type === "array")
      return Array.from({ length: Number(part.minItems ?? 0) }, () =>
        example(part.items, name, depth + 1),
      );
    if (part.type === "object" || part.properties) {
      const required = (part.required ?? []) as string[];
      const properties = (part.properties ?? {}) as Record<string, unknown>;
      return Object.fromEntries(
        required.map((key) => [key, example(properties[key], key, depth + 1)]),
      );
    }
    return null;
  }
  return example(document, "", 0);
}
export function operationExample(
  definition: OperationDefinition,
): Record<string, unknown> {
  const example = Object.keys(definition.example).length
    ? definition.example
    : schemaExample(definition.inputSchema);
  return definition.inputSchema.parse(
    definition.workspaceScoped
      ? {
          workspaceId: "01K6J7B8000000000000000000",
          ...(example as Record<string, unknown>),
        }
      : example,
  ) as Record<string, unknown>;
}
function componentSchema(schema: z.ZodType, name: string): JsonSchemaDocument {
  const result = schemaToJsonSchema(schema);
  delete result.$schema;
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/"))
      record.$ref = `#/components/schemas/${name}${record.$ref.slice(1)}`;
    Object.values(record).forEach(visit);
  }
  visit(result);
  return result;
}

export function generateOpenApi(
  options: { baseUrl?: string; internal?: boolean; version?: string } = {},
): Record<string, unknown> {
  const baseUrl = (options.baseUrl ?? "http://localhost:4310").replace(
    /\/$/,
    "",
  );
  const schemas: Record<string, unknown> = {};
  const paths: Record<string, Record<string, unknown>> = {};
  for (const definition of operations) {
    const requestExample = operationExample(definition);
    const inputName = `${definition.id}Input`,
      outputName = `${definition.id}Output`;
    const input = componentSchema(definition.inputSchema, inputName);
    schemas[inputName] = input;
    schemas[outputName] = componentSchema(definition.outputSchema, outputName);
    const path = options.internal
      ? definition.path.replace(/^\/v1/, "/api/internal/v1")
      : definition.path;
    const pathNames = [...definition.path.matchAll(/\{([^}]+)\}/g)].map(
      (match) => match[1]!,
    );
    const properties = (input.properties ?? {}) as Record<string, unknown>;
    const parameters: Record<string, unknown>[] = pathNames.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: properties[name] ?? { type: "string" },
      example: requestExample[name],
    }));
    if (definition.idempotencyRequired)
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 8, maxLength: 255 },
        description:
          "Bound to actor, operation, target, schema version and canonical payload; changed input returns 409.",
      });
    if (definition.id === "deleteRow")
      parameters.push({
        name: "If-Match",
        in: "header",
        required: true,
        schema: {
          type: "string",
          pattern: '^"[0-7][0-9A-HJKMNP-TV-Z]{25}:[1-9][0-9]*"$',
        },
        description:
          "Quoted row-id:decimal-version optimistic concurrency proof.",
      });
    const payloadProperties = Object.fromEntries(
      Object.entries(properties).filter(([name]) => !pathNames.includes(name)),
    );
    const payloadRequired = ((input.required ?? []) as string[]).filter(
      (name) => !pathNames.includes(name),
    );
    const payloadSchema: Record<string, unknown> = {
      ...input,
      properties: payloadProperties,
      required: payloadRequired,
    };
    if (definition.httpMethod === "GET")
      for (const [name, schema] of Object.entries(payloadProperties)) {
        const record = schema as Record<string, unknown>;
        parameters.push({
          name,
          in: "query",
          required: payloadRequired.includes(name),
          example: requestExample[name],
          ...(record.type === "object" ||
          record.type === "array" ||
          record.anyOf
            ? { content: { "application/json": { schema } } }
            : { schema }),
        });
      }
    const success = {
      description: definition.job
        ? "Committed synchronous result or accepted durable job; polling is required for terminal verification."
        : "Authorised operation result.",
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${outputName}` },
        },
      },
    };
    const responses: Record<string, unknown> = {
      [definition.successStatus]: success,
    };
    if (definition.job && definition.successStatus !== 202)
      responses["202"] = success;
    for (const status of [
      "400",
      "401",
      "403",
      "404",
      "408",
      "409",
      "413",
      "422",
      "429",
      "500",
      "502",
      "503",
    ])
      responses[status] = {
        description: (
          {
            "400": "Malformed request.",
            "401": "Missing, expired, revoked or wrong-audience credential.",
            "403": "Insufficient current authority.",
            "404": "Unknown or undisclosed target.",
            "408":
              "Ordinary JSON request body did not finish within its bounded read deadline.",
            "409": "Revision, schema, uniqueness or idempotency conflict.",
            "413": "Payload or output budget exceeded.",
            "422": "Typed validation failure.",
            "429": "Rate, concurrency or admission limit.",
            "500": "Redacted internal failure.",
            "502": "A required upstream service is unavailable.",
            "503":
              "A required service is unavailable. Check service configuration before retrying.",
          } as Record<string, string>
        )[status],
        headers:
          status === "401"
            ? { "WWW-Authenticate": { schema: { type: "string" } } }
            : status === "429"
              ? { "Retry-After": { schema: { type: "string" } } }
              : undefined,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorEnvelope" },
          },
        },
      };
    paths[path] ??= {};
    paths[path]![definition.httpMethod.toLowerCase()] = {
      operationId: definition.id,
      tags: definition.tags,
      summary: definition.description,
      parameters,
      security: options.internal
        ? [{ browserSession: [] }]
        : [{ apiKey: [] }, { oauth: definition.scopes }],
      ...(definition.httpMethod !== "GET" &&
      Object.keys(payloadProperties).length
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: payloadSchema,
                  example: Object.fromEntries(
                    Object.entries(requestExample).filter(
                      ([name]) => !pathNames.includes(name),
                    ),
                  ),
                },
              },
            },
          }
        : {}),
      responses,
      "x-rootset-scopes": definition.scopes,
      "x-rootset-read-only": definition.readOnly,
      "x-rootset-step-up": definition.stepUp,
      "x-rootset-job": definition.job,
      "x-rootset-minimum-role": definition.minimumRole,
      "x-rootset-personal": definition.personal,
      "x-rootset-mcp-tool": definition.toolName,
      "x-rootset-error-codes": definition.errors,
      "x-rootset-json-request-max-bytes": limits.requestBytes,
      "x-rootset-json-read-timeout-ms": limits.requestTimeoutMs,
      "x-rootset-request-example": requestExample,
    };
  }
  schemas.ErrorCode = componentSchema(ErrorCodeSchema, "ErrorCode");
  schemas.ErrorEnvelope = {
    type: "object",
    required: ["error"],
    additionalProperties: false,
    properties: {
      error: {
        type: "object",
        required: ["code", "message", "requestId"],
        additionalProperties: false,
        properties: {
          code: {
            type: "string",
            description:
              "Known domain codes are published in ErrorCode; unknown future codes remain valid.",
            "x-rootset-known-error-codes": ErrorCodeSchema.options,
          },
          message: { type: "string" },
          requestId: { type: "string" },
          details: {},
        },
      },
    },
  };
  paths["/v1/orgs/{orgId}/artifacts/{id}/download"] = {
    get: {
      operationId: "downloadArtifactBytes",
      tags: ["artifacts"],
      summary:
        "Stream verified artifact bytes under current artifact-purpose and target authority.",
      description:
        "Use the authenticated download URL returned by getArtifact. An API key or API-audience OAuth bearer token is accepted; the MCP-audience OAuth grant used for artifact retrieval is also accepted only at this bound binary handoff. The server rechecks the artifact's organisation, original purpose scopes, requester and current role, verifies encrypted-object integrity, then streams the bytes with their exact declared size and checksum. Artifact-bound downloads are the only MCP-audience exception among /v1 routes; ordinary JSON API routes remain API-audience only. The ordinary JSON response budget does not apply to the binary stream. MCP artifact resources return bounded metadata with this authenticated download URL.",
      parameters: [
        ...["orgId", "id"].map((name) => ({
          name,
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$" },
        })),
        {
          name: "workspaceId",
          in: "query",
          required: true,
          schema: { type: "string", pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$" },
        },
      ],
      security: [{ apiKey: [] }, { oauth: [] }],
      responses: {
        "200": {
          description:
            "Verified artifact stream with its exact byte length and checksum.",
          headers: {
            "Content-Length": {
              schema: { type: "string", pattern: "^[0-9]+$" },
            },
            "Content-Disposition": { schema: { type: "string" } },
            "Cache-Control": { schema: { type: "string", const: "no-store" } },
            Digest: {
              schema: { type: "string" },
              description: "sha-256= followed by the base64 checksum.",
            },
          },
          content: Object.fromEntries(
            [
              "application/octet-stream",
              "text/csv",
              "application/x-ndjson",
            ].map((type) => [
              type,
              { schema: { type: "string", format: "binary" } },
            ]),
          ),
        },
        ...Object.fromEntries(
          ["401", "403", "404", "409", "410", "429", "500", "503"].map(
            (status) => [
              status,
              {
                description:
                  "Redacted artifact authentication, current authority, availability, expiry or integrity failure.",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/ErrorEnvelope" },
                  },
                },
              },
            ],
          ),
        ),
      },
      "x-rootset-operation": "getArtifact",
      "x-rootset-protocol-adapter": "binary",
      "x-rootset-read-only": true,
      "x-rootset-mcp-audience-handoff": true,
      "x-rootset-target-resolver": "artifact-purpose-and-current-target",
    },
  };
  if (options.internal) {
    const download = paths["/v1/orgs/{orgId}/artifacts/{id}/download"]!
      .get as Record<string, unknown>;
    paths["/api/internal/v1/orgs/{orgId}/artifacts/{id}/download"] = {
      get: {
        ...download,
        operationId: "downloadBrowserArtifactBytes",
        summary:
          "Stream verified artifact bytes using the current browser session.",
        description:
          "Browser clients use the API-origin session-only download path. It uses the same original artifact-purpose, requester and current target authority checks and the same integrity-verified stream as the public handoff. Bearer API or OAuth tokens are not accepted here. This GET only reads artifact bytes and requires no mutation CSRF proof. Public /v1 binary downloads remain bearer-only, including the explicit bound MCP-audience handoff.",
        security: [{ browserSession: [] }],
        "x-rootset-mcp-audience-handoff": false,
        "x-rootset-browser-session-only": true,
      },
    };
  }
  const supportedScopes = Object.fromEntries(
    [...new Set(operations.flatMap((operation) => operation.scopes))].map(
      (scope) => [
        scope,
        `Current ${scope} authority; the live role ceiling still applies.`,
      ],
    ),
  );
  return {
    openapi: "3.1.2",
    info: {
      title: `Rootset ${options.internal ? "browser" : "public"} API`,
      version: options.version ?? "0.1.0",
      description:
        "Typed MDM storage. Temporal values are UTC only; IDs are opaque ULIDs. Runtime table definitions are discovered through the schema endpoint.",
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Rootset personal API key",
        },
        browserSession: {
          type: "apiKey",
          in: "cookie",
          name: "rootset.session_token",
        },
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: `${baseUrl}/oauth/authorize`,
              tokenUrl: `${baseUrl}/oauth/token`,
              scopes: supportedScopes,
            },
          },
        },
      },
    },
    "x-rootset-protocol-adapters": ProtocolAdapterInventory,
    "x-rootset-json-request-max-bytes": limits.requestBytes,
    "x-rootset-json-read-timeout-ms": limits.requestTimeoutMs,
  };
}
export const generateOpenAPI = generateOpenApi;
export const generateOpenApiSpec = generateOpenApi;

export function mcpOutputJsonSchema(
  definition: OperationDefinition,
): JsonSchemaDocument {
  const definitions: Record<string, unknown> = {};
  function branch(schema: z.ZodType, prefix: string): JsonSchemaDocument {
    const document = schemaToJsonSchema(schema);
    const local = (document.$defs ?? {}) as Record<string, unknown>;
    delete document.$schema;
    delete document.$defs;
    function rename(value: unknown): void {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) return value.forEach(rename);
      const record = value as Record<string, unknown>;
      if (typeof record.$ref === "string" && record.$ref.startsWith("#/$defs/"))
        record.$ref = record.$ref.replace("#/$defs/", `#/$defs/${prefix}_`);
      Object.values(record).forEach(rename);
    }
    rename(document);
    for (const [name, value] of Object.entries(local)) {
      rename(value);
      definitions[`${prefix}_${name}`] = value;
    }
    return document;
  }
  const success = branch(definition.outputSchema, "success");
  const error = branch(ErrorEnvelopeSchema, "error");
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    anyOf: [success, error],
    ...(Object.keys(definitions).length ? { $defs: definitions } : {}),
  };
}
export function generateMcpTools(): Record<string, unknown>[] {
  return operations.map((definition) => {
    const inputSchema = schemaToJsonSchema(definition.inputSchema);
    if (definition.idempotencyRequired) {
      const properties = (inputSchema.properties ?? {}) as Record<
        string,
        unknown
      >;
      properties.idempotencyKey = {
        type: "string",
        minLength: 8,
        maxLength: 255,
        description:
          "Stable caller-provided key across retries of this exact operation.",
      };
      inputSchema.properties = properties;
      inputSchema.required = [
        ...((inputSchema.required ?? []) as string[]),
        "idempotencyKey",
      ];
    }
    return {
      name: definition.toolName,
      title: definition.id,
      description: definition.description,
      inputSchema,
      outputSchema: mcpOutputJsonSchema(definition),
      annotations: {
        readOnlyHint: definition.readOnly,
        destructiveHint: definition.destructive,
        idempotentHint: definition.idempotent || definition.idempotencyRequired,
        openWorldHint: false,
      },
      _meta: {
        "rootset.dev/jsonRequestMaxBytes": limits.requestBytes,
        "rootset.dev/jsonReadTimeoutMs": limits.requestTimeoutMs,
        "rootset.dev/errorCodes": definition.errors,
      },
    };
  });
}
export function generateCoverageInventory(): Record<string, unknown>[] {
  return operations.map((definition) => ({
    operationId: definition.id,
    publicRoute: `${definition.httpMethod} ${definition.path}`,
    browserRoute: `${definition.httpMethod} ${definition.path.replace(/^\/v1/, "/api/internal/v1")}`,
    mcpTool: definition.toolName,
    scopes: definition.scopes,
    role: definition.minimumRole,
    resource: definition.resource,
    personal: definition.personal,
    readOnly: definition.readOnly,
    stepUp: definition.stepUp,
    job: definition.job,
    errors: definition.errors,
    jsonRequestMaxBytes: limits.requestBytes,
    jsonReadTimeoutMs: limits.requestTimeoutMs,
    uiEntry: definition.tags[0],
    verification: [
      "API-01",
      "API-02",
      "API-03",
      "API-06",
      "API-12",
      "MCP-08",
      ...(definition.stepUp !== "never" ? ["AUTH-07", "MCP-11"] : []),
      ...(definition.idempotencyRequired ? ["API-09"] : []),
      ...(definition.job ? ["JOB-04", "JOB-06", "MCP-10"] : []),
      ...(definition.tags[0] === "accounts"
        ? ["ACC-03", "ACC-04", "ACC-12", "UI-14"]
        : []),
    ],
  }));
}

function schemaType(
  schema: unknown,
  localDefinitions: Record<string, unknown>,
  active = new Set<string>(),
): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const node = schema as Record<string, unknown>;
  if (typeof node.$ref === "string") {
    const name = node.$ref.split("/").at(-1)!;
    if (active.has(name)) return "JsonValue";
    const next = new Set(active);
    next.add(name);
    return schemaType(localDefinitions[name], localDefinitions, next);
  }
  if (Object.hasOwn(node, "const")) return JSON.stringify(node.const);
  if (Array.isArray(node.enum))
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  const union = node.anyOf ?? node.oneOf;
  if (Array.isArray(union))
    return union
      .map((value) => schemaType(value, localDefinitions, active))
      .join(" | ");
  if (node.type === "null") return "null";
  if (node.type === "string") return "string";
  if (node.type === "number" || node.type === "integer") return "number";
  if (node.type === "boolean") return "boolean";
  if (node.type === "array")
    return `(${schemaType(node.items, localDefinitions, active)})[]`;
  if (node.type === "object" || node.properties) {
    const required = (node.required ?? []) as string[];
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    const members = Object.entries(properties)
      .map(
        ([name, value]) =>
          `${JSON.stringify(name)}${required.includes(name) ? "" : "?"}: ${schemaType(value, localDefinitions, active)}`,
      )
      .join("; ");
    if (
      node.additionalProperties &&
      typeof node.additionalProperties === "object"
    )
      return members
        ? `({ ${members} } & Record<string, ${schemaType(node.additionalProperties, localDefinitions, active)}>)`
        : `Record<string, ${schemaType(node.additionalProperties, localDefinitions, active)}>`;
    return members ? `{ ${members} }` : "Record<string, never>";
  }
  return "unknown";
}
export function generateClientSource(): string {
  const errorCodeType = schemaType(schemaToJsonSchema(ErrorCodeSchema), {});
  const definitions = operations
    .map((operation) => {
      const input = schemaToJsonSchema(operation.inputSchema),
        output = schemaToJsonSchema(operation.outputSchema);
      return `export type ${operation.id}Input = ${schemaType(input, (input.$defs ?? {}) as Record<string, unknown>)};\nexport type ${operation.id}Output = ${schemaType(output, (output.$defs ?? {}) as Record<string, unknown>)};`;
    })
    .join("\n");
  const routes = Object.fromEntries(
    operations.map((operation) => [
      operation.id,
      {
        path: operation.path,
        method: operation.httpMethod,
        idempotencyRequired: operation.idempotencyRequired,
      },
    ]),
  );
  const methods = operations
    .map(
      (operation) =>
        `  ${operation.id}(input: ${operation.id}Input, options?: CallOptions): Promise<${operation.id}Output> { return this.call(${JSON.stringify(operation.id)}, input, options) as Promise<${operation.id}Output>; }`,
    )
    .join("\n");
  return `// Generated from @rootset/contracts. Regenerate through pnpm contracts:generate.\nexport type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };\nexport type ErrorCode = ${errorCodeType};\nexport const transportLimits = ${JSON.stringify({ jsonRequestMaxBytes: limits.requestBytes, jsonReadTimeoutMs: limits.requestTimeoutMs, restResultMaxBytes: limits.restResultBytes, mcpResultMaxBytes: limits.mcpResultBytes }, null, 2)} as const;\n${definitions}\nexport interface CallOptions { signal?: AbortSignal; idempotencyKey?: string }\nconst routes = ${JSON.stringify(routes, null, 2)} as const;\nexport class RootsetClient {\n  constructor(readonly baseUrl: string, readonly options: { bearer?: string; fetch?: typeof fetch; internal?: boolean } = {}) {}\n  private async call(operationId: keyof typeof routes, input: object, call: CallOptions = {}): Promise<unknown> {\n    const operation = routes[operationId]; const body = { ...input } as Record<string, unknown>;\n    let path: string = operation.path; path = path.replace(/\\{([^}]+)\\}/g, (_, name: string) => { const value = body[name]; if (typeof value !== 'string') throw new Error('Missing path parameter ' + name); delete body[name]; return encodeURIComponent(value); });\n    if (this.options.internal) path = path.replace(/^\\/v1/, '/api/internal/v1');\n    const headers = new Headers({ Accept: 'application/json' }); if (this.options.bearer) headers.set('Authorization', 'Bearer ' + this.options.bearer);\n    if (operation.idempotencyRequired) { if (!call.idempotencyKey) throw new Error('Idempotency-Key is required'); headers.set('Idempotency-Key', call.idempotencyKey); }\n    if (operationId === 'deleteRow') { const rowId = (input as Record<string, unknown>).rowId; headers.set('If-Match', '"' + String(rowId) + ':' + String(body.expectedVersion) + '"'); }\n    const url = new URL(path, this.baseUrl); let encoded: string | undefined;\n    if (operation.method === 'GET') { for (const [name, value] of Object.entries(body)) if (value !== undefined) url.searchParams.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value)); } else { headers.set('Content-Type', 'application/json'); encoded = JSON.stringify(body); }\n    const response = await (this.options.fetch ?? fetch)(url, { method: operation.method, headers, body: encoded, signal: call.signal, credentials: 'include' });\n    const result = await response.json() as unknown; if (!response.ok) { const error = new Error('Rootset request failed'); Object.assign(error, { status: response.status, result }); throw error; } return result;\n  }\n${methods}\n}\n`;
}
export function inputJsonSchema(
  definition: OperationDefinition,
): JsonSchemaDocument {
  return schemaToJsonSchema(definition.inputSchema);
}
