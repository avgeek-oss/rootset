import { z } from "zod";
import {
  JsonValueSchema,
  IdSchema,
  assertFieldNames,
  RootsetError,
  limits,
  type FieldDefinition,
  type JsonValue,
} from "./models";
import { canonicalJson, canonicalValue, validateCell } from "./values";
import type { NumberLexeme } from "./decoder";

export const QueryOperatorSchema = z.enum([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "in",
  "isNull",
  "isNotNull",
  "prefix",
  "contains",
  "iContains",
  "pathExists",
  "pathEq",
  "jsonContains",
]);
export type QueryOperator = z.infer<typeof QueryOperatorSchema>;
export interface Predicate {
  field: string;
  op: QueryOperator;
  value?: JsonValue;
  path?: (string | number)[];
}
export type FilterNode =
  Predicate | { and: FilterNode[] } | { or: FilterNode[] };
export const PredicateSchema: z.ZodType<Predicate> = z.strictObject({
  field: z.string().min(1).max(64),
  op: QueryOperatorSchema,
  value: JsonValueSchema.optional(),
  path: z
    .array(
      z.union([
        z.string().max(1024),
        z.number().int().nonnegative().max(2147483647),
      ]),
    )
    .max(limits.jsonDepth)
    .optional(),
});
export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    PredicateSchema,
    z.strictObject({
      and: z.array(FilterNodeSchema).min(1).max(limits.queryPredicates),
    }),
    z.strictObject({
      or: z.array(FilterNodeSchema).min(1).max(limits.queryPredicates),
    }),
  ]),
);
export interface QuerySpec {
  select?: string[];
  where?: FilterNode;
  orderBy?: { field: string; direction: "asc" | "desc" }[];
  limit?: number;
  cursor?: string | null;
}
export function preflightQuery(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const query = input as Record<string, unknown>;
  const stack: { value: unknown; depth: number }[] =
    query.where === undefined ? [] : [{ value: query.where, depth: 1 }];
  let predicates = 0,
    nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (
      ++nodes > limits.queryPredicates * (limits.queryDepth + 1) ||
      current.depth > limits.queryDepth
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Filter exceeds depth/node budget",
      );
    if (
      !current.value ||
      typeof current.value !== "object" ||
      Array.isArray(current.value)
    )
      continue;
    const node = current.value as Record<string, unknown>;
    if (Object.hasOwn(node, "field") && ++predicates > limits.queryPredicates)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Filter exceeds 100 predicates",
      );
    if (Object.hasOwn(node, "value")) canonicalJson(node.value);
    for (const group of [node.and, node.or])
      if (Array.isArray(group)) {
        if (group.length > limits.queryPredicates)
          throw new RootsetError(
            "VALIDATION_FAILED",
            "Filter group exceeds 100 members",
          );
        for (const value of group)
          stack.push({ value, depth: current.depth + 1 });
      }
  }
  return input;
}
export const QuerySpecSchema: z.ZodType<QuerySpec> = z.preprocess(
  preflightQuery,
  z
    .strictObject({
      select: z
        .array(z.string().min(1).max(64))
        .max(limits.maxFields)
        .optional(),
      where: FilterNodeSchema.optional(),
      orderBy: z
        .array(
          z.strictObject({
            field: z.string().min(1).max(64),
            direction: z.enum(["asc", "desc"]),
          }),
        )
        .max(limits.querySorts)
        .optional(),
      limit: z.number().int().min(1).max(limits.queryRows).optional(),
      cursor: z.string().min(1).max(131200).nullable().optional(),
    })
    .superRefine((query, context) => {
      let predicates = 0;
      function walk(node: FilterNode, depth: number): void {
        if (depth > limits.queryDepth) {
          context.addIssue({
            code: "custom",
            path: ["where"],
            message: "Filter nesting exceeds eight levels",
          });
          return;
        }
        if ("field" in node) predicates++;
        else
          for (const item of "and" in node ? node.and : node.or)
            walk(item, depth + 1);
      }
      if (query.where) walk(query.where, 1);
      if (predicates > limits.queryPredicates)
        context.addIssue({
          code: "custom",
          path: ["where"],
          message: "Filter exceeds 100 predicates",
        });
      if (query.select && new Set(query.select).size !== query.select.length)
        context.addIssue({
          code: "custom",
          path: ["select"],
          message: "Projection fields must be distinct",
        });
      if (
        query.orderBy &&
        new Set(query.orderBy.map((sort) => sort.field)).size !==
          query.orderBy.length
      )
        context.addIssue({
          code: "custom",
          path: ["orderBy"],
          message: "Sort fields must be distinct",
        });
    }),
);

/** Preserve the source numeric domain before a parsed predicate reaches SQL. */
export function assertQueryLexemes(
  fields: readonly FieldDefinition[],
  query: QuerySpec,
  lexemes: readonly NumberLexeme[],
  queryPath: readonly (string | number)[] = ["query"],
): void {
  preflightQuery(query);
  const lookup = new Map(
    fields.flatMap(
      (field) =>
        [
          [field.name, field],
          [field.id, field],
        ] as const,
    ),
  );
  interface NumericPath {
    children: Map<string, NumericPath>;
    field?: FieldDefinition;
  }
  const paths: NumericPath = { children: new Map() };
  function walk(node: FilterNode, path: (string | number)[]): void {
    if ("field" in node) {
      const parsedId = IdSchema.safeParse(node.field);
      const field =
        lookup.get(node.field) ??
        (parsedId.success ? lookup.get(parsedId.data) : undefined);
      if (field && (field.type === "integer" || field.type === "json")) {
        let leaf = paths;
        for (const segment of [...path, "value"]) {
          const key = String(segment);
          let child = leaf.children.get(key);
          if (!child) {
            child = { children: new Map() };
            leaf.children.set(key, child);
          }
          leaf = child;
        }
        leaf.field = field;
      }
      return;
    }
    const group = "and" in node ? "and" : "or";
    const children = "and" in node ? node.and : node.or;
    children.forEach((child, index) => walk(child, [...path, group, index]));
  }
  if (query.where) walk(query.where, [...queryPath, "where"]);
  for (const information of lexemes) {
    let leaf: NumericPath | undefined = paths;
    for (const segment of information.path) {
      leaf = leaf.children.get(String(segment));
      if (!leaf || leaf.field) break;
    }
    const field = leaf?.field;
    if (!field) continue;
    if (
      field.type === "integer" &&
      (!information.integer || !information.safeInteger)
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        `Query field ${field.name} requires a lossless safe integer`,
        422,
        { fieldId: field.id, field: field.name },
      );
    if (
      field.type === "json" &&
      information.integer &&
      !information.safeInteger
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        `Query JSON field ${field.name} contains an unsafe integral number`,
        422,
        { fieldId: field.id, field: field.name },
      );
  }
}

export const operatorsByType = Object.freeze({
  text: [
    "eq",
    "ne",
    "in",
    "prefix",
    "contains",
    "iContains",
    "isNull",
    "isNotNull",
  ],
  integer: [
    "eq",
    "ne",
    "in",
    "lt",
    "lte",
    "gt",
    "gte",
    "between",
    "isNull",
    "isNotNull",
  ],
  float: [
    "eq",
    "ne",
    "in",
    "lt",
    "lte",
    "gt",
    "gte",
    "between",
    "isNull",
    "isNotNull",
  ],
  boolean: ["eq", "ne", "in", "isNull", "isNotNull"],
  date: [
    "eq",
    "ne",
    "in",
    "lt",
    "lte",
    "gt",
    "gte",
    "between",
    "isNull",
    "isNotNull",
  ],
  time: [
    "eq",
    "ne",
    "in",
    "lt",
    "lte",
    "gt",
    "gte",
    "between",
    "isNull",
    "isNotNull",
  ],
  "date-time": [
    "eq",
    "ne",
    "in",
    "lt",
    "lte",
    "gt",
    "gte",
    "between",
    "isNull",
    "isNotNull",
  ],
  json: ["pathExists", "pathEq", "jsonContains", "isNull", "isNotNull"],
} satisfies Record<FieldDefinition["type"], readonly QueryOperator[]>);

export function validateQuery(
  input: unknown,
  fields: readonly FieldDefinition[],
): QuerySpec {
  assertFieldNames(fields);
  const parsed = QuerySpecSchema.safeParse(input);
  if (!parsed.success)
    throw new RootsetError("VALIDATION_FAILED", "Invalid query", 422, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  const query = parsed.data;
  const lookup = new Map(
    fields.flatMap(
      (field) =>
        [
          [field.id, field],
          [field.name, field],
        ] as const,
    ),
  );
  const fieldFor = (name: string) => {
    const field =
      lookup.get(name) ??
      lookup.get(IdSchema.safeParse(name).success ? name.toUpperCase() : name);
    if (!field)
      throw new RootsetError(
        "VALIDATION_FAILED",
        `Unknown query field ${name}`,
        422,
      );
    return field;
  };
  const selectIds = query.select?.map((name) => fieldFor(name).id);
  if (selectIds && new Set(selectIds).size !== selectIds.length)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Projection contains the same field twice",
    );
  const orderIds = query.orderBy?.map((sort) => {
    const field = fieldFor(sort.field);
    if (field.type === "json")
      throw new RootsetError(
        "VALIDATION_FAILED",
        "JSON sorting is unsupported; use a scalar field",
      );
    return field.id;
  });
  if (orderIds && new Set(orderIds).size !== orderIds.length)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Sort contains the same field twice",
    );
  function walk(node: FilterNode): FilterNode {
    if ("and" in node) return { and: node.and.map(walk) };
    if ("or" in node) return { or: node.or.map(walk) };
    const field = fieldFor(node.field);
    if (!(operatorsByType[field.type] as readonly string[]).includes(node.op))
      throw new RootsetError(
        "VALIDATION_FAILED",
        `Operator ${node.op} is unsupported for ${field.type}`,
      );
    if (node.op === "isNull" || node.op === "isNotNull") {
      if (Object.hasOwn(node, "value") || node.path)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Null tests do not accept a value/path",
        );
      return { ...node, field: field.name };
    }
    if (node.op === "pathExists" || node.op === "pathEq") {
      if (!node.path?.length)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "JSON path operator requires a nonempty bounded path",
        );
      canonicalJson(node.path);
      if (node.op === "pathExists") {
        if (Object.hasOwn(node, "value"))
          throw new RootsetError(
            "VALIDATION_FAILED",
            "Path-exists does not accept a value",
          );
        return { ...node, field: field.name };
      }
      if (!Object.hasOwn(node, "value"))
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Path equality requires a value",
        );
      canonicalValue(node.value);
      return { ...node, field: field.name };
    }
    if (node.path)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Path is only valid for a JSON path operator",
      );
    if (!Object.hasOwn(node, "value"))
      throw new RootsetError("VALIDATION_FAILED", "Predicate requires a value");
    if (node.op === "jsonContains") {
      canonicalValue(node.value);
      return { ...node, field: field.name };
    }
    const unbounded = {
      id: field.id,
      name: field.name,
      type: field.type,
      ...(field.charLimit !== undefined ? { charLimit: field.charLimit } : {}),
    };
    if (node.value === null)
      throw new RootsetError(
        "VALIDATION_FAILED",
        "Use isNull/isNotNull to compare a null cell",
      );
    if (node.op === "between" || node.op === "in") {
      if (
        !Array.isArray(node.value) ||
        node.value.length < 1 ||
        node.value.length > 100 ||
        (node.op === "between" && node.value.length !== 2)
      )
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Expected a bounded value list (two values for between)",
        );
      const values = node.value.map((value) => {
        if (value === null)
          throw new RootsetError(
            "VALIDATION_FAILED",
            "Value lists cannot contain null",
          );
        return validateCell(unbounded, value);
      });
      if (node.op === "between" && values[0]! > values[1]!)
        throw new RootsetError(
          "VALIDATION_FAILED",
          "Range minimum exceeds maximum",
        );
      return { ...node, field: field.name, value: values };
    }
    return {
      ...node,
      field: field.name,
      value: validateCell(unbounded, node.value),
    };
  }
  return {
    ...query,
    ...(query.select
      ? { select: query.select.map((name) => fieldFor(name).name) }
      : {}),
    ...(query.orderBy
      ? {
          orderBy: query.orderBy.map((sort) => ({
            ...sort,
            field: fieldFor(sort.field).name,
          })),
        }
      : {}),
    ...(query.where ? { where: walk(query.where) } : {}),
  };
}
