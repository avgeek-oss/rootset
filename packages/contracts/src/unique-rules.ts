import { z } from "zod";
import { IdSchema, RootsetError, limits, type FieldDefinition } from "./models";
import { validateQuery } from "./query";

// A single scalar predicate keeps index membership deterministic and bounded.
export const UniqueRuleConditionSchema = z.union([
  z.strictObject({
    field: IdSchema,
    op: z.enum(["eq", "ne"]),
    value: z.union([
      z
        .string()
        .max(limits.textCharLimit * 2)
        .refine(
          (value) => [...value].length <= limits.textCharLimit,
          "Condition text supports up to 4,096 characters",
        )
        .meta({ maxLength: limits.textCharLimit }),
      z.number().finite(),
      z.boolean(),
    ]),
  }),
  z.strictObject({
    field: IdSchema,
    op: z.enum(["isNull", "isNotNull"]),
  }),
]);
export type UniqueRuleCondition = z.infer<typeof UniqueRuleConditionSchema>;

export function validateUniqueRuleCondition(
  input: unknown,
  fields: readonly FieldDefinition[],
): UniqueRuleCondition | undefined {
  if (input === undefined) return undefined;
  const parsed = UniqueRuleConditionSchema.safeParse(input);
  if (!parsed.success)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Invalid unique rule condition",
      422,
      {
        issues: parsed.error.issues.map((issue) => ({
          path: ["where", ...issue.path].join("."),
          message: issue.message,
        })),
      },
    );
  const field = fields.find((field) => field.id === parsed.data.field);
  if (!field || field.type === "json")
    throw new RootsetError(
      "VALIDATION_FAILED",
      "A unique rule condition must reference an existing scalar field ID",
    );
  const predicate = validateQuery({ where: parsed.data }, fields).where!;
  return UniqueRuleConditionSchema.parse({ ...predicate, field: field.id });
}
