"use client";

import { useId, useState } from "react";
import { Badge } from "@heroui/react";
import { PreviewTrigger } from "react-aria-components";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Popover } from "@avgeek-oss/design-system/overlays/popover";
import { parseStrictJson, type FieldDefinition } from "@rootset/contracts";
import {
  needsFilterValue,
  operatorLabels,
  type FilterCombination,
  type FilterCondition,
} from "../lib/table-filters";
import { FieldTypeIcon } from "./settings/field-type-options";
import { Filter } from "./ui/icons";

function filterValue(condition: FilterCondition): string {
  if (!condition.value) return "“” (empty text)";
  if (condition.operator === "in" || condition.operator === "between") {
    const values = parseStrictJson(condition.value);
    if (Array.isArray(values))
      return values
        .map((value) => (value === "" ? "“”" : String(value)))
        .join(condition.operator === "between" ? " – " : ", ");
  }
  return condition.value;
}

export function TableFilterButton({
  fields,
  conditions,
  combination,
  isDisabled,
  isEditing,
  onPress,
}: {
  fields: readonly FieldDefinition[];
  conditions: readonly FilterCondition[];
  combination: FilterCombination;
  isDisabled: boolean;
  isEditing: boolean;
  onPress: () => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const count = conditions.length;
  return (
    <PreviewTrigger
      delay={2000}
      closeDelay={200}
      isDisabled={isDisabled || isEditing}
      isOpen={isOpen && !isDisabled && !isEditing}
      onOpenChange={setIsOpen}
    >
      <Badge.Anchor>
        <Button
          isIconOnly
          size="lg"
          variant={count ? "primary" : "secondary"}
          aria-label="Filter"
          aria-describedby={descriptionId}
          aria-pressed={count > 0}
          isDisabled={isDisabled}
          onPress={() => {
            setIsOpen(false);
            onPress();
          }}
        >
          <Filter size={20} />
        </Button>
        <span id={descriptionId} className="sr-only">
          {count
            ? `${count} ${count === 1 ? "filter" : "filters"} applied`
            : "No filters applied"}
        </span>
        {count > 0 && (
          <Badge
            size="sm"
            placement="top-right"
            className="table-filter-count"
            aria-hidden="true"
          >
            <Badge.Label>{count}</Badge.Label>
          </Badge>
        )}
      </Badge.Anchor>
      <Popover.Content
        className="popover table-filter-preview"
        placement="top end"
        offset={12}
        aria-labelledby={headingId}
      >
        <div className="table-filter-preview-header">
          <h3 id={headingId}>{count ? "Applied filters" : "Filters"}</h3>
          <p>
            {count > 1
              ? combination === "and"
                ? "Match all conditions"
                : "Match any condition"
              : count === 0
                ? "No filters applied."
                : "Match this condition"}
          </p>
        </div>
        {count > 0 && (
          <ul
            className="table-filter-preview-list"
            tabIndex={0}
            aria-label="Applied filter conditions"
          >
            {conditions.map((condition) => {
              const field = fields.find(
                (entry) => entry.id === condition.fieldId,
              );
              return (
                <li key={condition.id}>
                  <div className="table-filter-preview-field">
                    {field && <FieldTypeIcon type={field.type} size={14} />}
                    <span>{field?.name ?? "Removed field"}</span>
                  </div>
                  {condition.operator.startsWith("path") && (
                    <code className="table-filter-preview-path">
                      {condition.path}
                    </code>
                  )}
                  <div className="table-filter-preview-condition">
                    <span>{operatorLabels[condition.operator]}</span>
                    {needsFilterValue(condition.operator) && (
                      <span className="table-filter-preview-value">
                        {filterValue(condition)}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Popover.Content>
    </PreviewTrigger>
  );
}
