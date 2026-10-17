import type { FieldDefinition, FilterNode } from "@rootset/contracts";
import { needsFilterValue, operatorLabels } from "../lib/table-filters";
import { FieldTypeIcon } from "./settings/field-type-options";

export function filterPredicateCount(node: FilterNode): number {
  return "field" in node
    ? 1
    : ("and" in node ? node.and : node.or).reduce(
        (count, child) => count + filterPredicateCount(child),
        0,
      );
}
export function FilterTree({
  where,
  fields,
}: {
  where: FilterNode;
  fields: readonly FieldDefinition[];
}) {
  if ("field" in where) {
    const field = fields.find(
      (field) => field.id === where.field || field.name === where.field,
    );
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {field && <FieldTypeIcon type={field.type} size={14} />}
        <span className="font-medium">{field?.name ?? "Removed field"}</span>
        {where.path && (
          <code className="break-all">{JSON.stringify(where.path)}</code>
        )}
        <span className="text-muted">{operatorLabels[where.op]}</span>
        {needsFilterValue(where.op) && (
          <code
            className={`break-all${where.value === null ? " null-value" : ""}`}
          >
            {where.value === null ? "NULL" : JSON.stringify(where.value)}
          </code>
        )}
      </div>
    );
  }
  const children = "and" in where ? where.and : where.or;
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-xs font-medium text-muted">
        {"and" in where ? "Match all conditions" : "Match any condition"}
      </p>
      <ul className="space-y-3 border-l border-separator pl-3">
        {children.map((node, index) => (
          <li key={index}>
            <FilterTree where={node} fields={fields} />
          </li>
        ))}
      </ul>
    </div>
  );
}
