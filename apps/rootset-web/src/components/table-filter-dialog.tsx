// Layout adapted from Towbar's Apache-2.0 Analytics filter dialog.
"use client";

import { useId, useState } from "react";
import { Input, Label, ListBox, Modal, Select, TextField } from "@heroui/react";
import {
  limits,
  operatorsByType,
  type FieldDefinition,
  type FilterNode,
  type QueryOperator,
} from "@rootset/contracts";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Filter, Plus, Trash2 } from "./ui/icons";
import {
  buildTableFilter,
  needsFilterValue,
  operatorLabels,
  type FilterCombination,
  type FilterCondition,
} from "../lib/table-filters";

function newCondition(field: FieldDefinition): FilterCondition {
  return {
    id: crypto.randomUUID(),
    fieldId: field.id,
    operator: operatorsByType[field.type][0]!,
    value: "",
    path: "",
  };
}

function FilterSelect({
  label,
  ariaLabel,
  hideLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  ariaLabel?: string;
  hideLabel: boolean;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      aria-label={ariaLabel}
      variant="secondary"
      className="table-filter-field"
      value={value || null}
      onChange={(key) => {
        if (key) onChange(String(key));
      }}
    >
      <Label className={hideLabel ? "sr-only" : "table-filter-label"}>
        {label}
      </Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item
              key={option.value}
              id={option.value}
              textValue={option.label}
            >
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function TableFilterDialog({
  fields,
  value,
  combination,
  onApply,
  onClear,
  onClose,
}: {
  fields: readonly FieldDefinition[];
  value: readonly FilterCondition[];
  combination: FilterCombination;
  onApply: (
    conditions: FilterCondition[],
    combination: FilterCombination,
    where: FilterNode | undefined,
  ) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<FilterCondition[]>(() =>
    value.length
      ? value.map((condition) => ({ ...condition }))
      : fields[0]
        ? [newCondition(fields[0])]
        : [],
  );
  const [match, setMatch] = useState(combination);
  const [error, setError] = useState<string | null>(null);
  function update(id: string, changes: Partial<FilterCondition>) {
    setDraft((current) =>
      current.map((condition) =>
        condition.id === id ? { ...condition, ...changes } : condition,
      ),
    );
    setError(null);
  }
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog className="table-filter-dialog">
            <Modal.Header>
              <Modal.Heading className="table-filter-heading">
                <Filter />
                Filters
              </Modal.Heading>
              <Modal.CloseTrigger aria-label="Close filters" />
            </Modal.Header>
            <Modal.Body>
              <form
                id={formId}
                className="table-filter-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    onApply(
                      draft,
                      match,
                      buildTableFilter(draft, match, fields),
                    );
                  } catch (failure) {
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : "Check the filter values.",
                    );
                  }
                }}
              >
                {draft.length > 1 && (
                  <div className="table-filter-combination">
                    <FilterSelect
                      label="Match conditions"
                      hideLabel={false}
                      value={match}
                      options={[
                        { value: "and", label: "All conditions (AND)" },
                        { value: "or", label: "Any condition (OR)" },
                      ]}
                      onChange={(next) => setMatch(next as FilterCombination)}
                    />
                  </div>
                )}
                {draft.map((condition, index) => {
                  const field = fields.find(
                    (entry) => entry.id === condition.fieldId,
                  );
                  const operators = field ? operatorsByType[field.type] : [];
                  const needsValue = needsFilterValue(condition.operator);
                  return (
                    <div className="table-filter-condition" key={condition.id}>
                      <div className="table-filter-condition-content">
                        <div className="table-filter-inputs">
                          <FilterSelect
                            label="Field"
                            ariaLabel={`Field for condition ${index + 1}`}
                            hideLabel={index > 0}
                            value={condition.fieldId}
                            options={fields.map((entry) => ({
                              value: entry.id,
                              label: entry.name,
                            }))}
                            onChange={(id) => {
                              const next = fields.find(
                                (entry) => entry.id === id,
                              );
                              if (next)
                                update(condition.id, {
                                  fieldId: id,
                                  operator: operatorsByType[next.type][0]!,
                                  value: "",
                                  path: "",
                                });
                            }}
                          />
                          <FilterSelect
                            label="Match"
                            ariaLabel={`Match for condition ${index + 1}`}
                            hideLabel={index > 0}
                            value={condition.operator}
                            options={operators.map((operator) => ({
                              value: operator,
                              label: operatorLabels[operator],
                            }))}
                            onChange={(operator) =>
                              update(condition.id, {
                                operator: operator as QueryOperator,
                                value: "",
                              })
                            }
                          />
                          <TextField
                            aria-label={`Value for condition ${index + 1}`}
                            className="table-filter-field"
                            value={needsValue ? condition.value : ""}
                            onChange={(value) =>
                              update(condition.id, { value })
                            }
                            isDisabled={!needsValue}
                          >
                            <Label
                              className={
                                index > 0 ? "sr-only" : "table-filter-label"
                              }
                            >
                              Value
                            </Label>
                            <Input
                              variant="secondary"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={
                                !needsValue
                                  ? "No value needed"
                                  : condition.operator === "between"
                                    ? "[lower, upper]"
                                    : condition.operator === "in"
                                      ? '["value", "value"]'
                                      : field?.type === "boolean"
                                        ? "true or false"
                                        : field?.type === "date-time"
                                          ? "2026-10-05T12:30:00Z"
                                          : field?.type === "time"
                                            ? "12:30:00Z"
                                            : field?.type === "json"
                                              ? "JSON value"
                                              : undefined
                              }
                            />
                          </TextField>
                        </div>
                        {condition.operator.startsWith("path") && (
                          <TextField
                            aria-label={`JSON path for condition ${index + 1}`}
                            className="table-filter-field"
                            value={condition.path}
                            onChange={(path) => update(condition.id, { path })}
                          >
                            <Label className="table-filter-label">
                              JSON path
                            </Label>
                            <Input
                              variant="secondary"
                              placeholder='["address", "city"]'
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </TextField>
                        )}
                      </div>
                      <Button
                        isIconOnly
                        variant="danger"
                        className="table-filter-remove"
                        aria-label={`Remove condition ${index + 1}`}
                        onPress={() => {
                          setDraft((current) =>
                            current.filter(
                              (entry) => entry.id !== condition.id,
                            ),
                          );
                          setError(null);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  );
                })}
                <Button
                  variant="secondary"
                  className="table-filter-add"
                  isDisabled={
                    !fields.length || draft.length >= limits.queryPredicates
                  }
                  onPress={() => {
                    const first = fields[0];
                    if (first)
                      setDraft((current) => [...current, newCondition(first)]);
                    setError(null);
                  }}
                >
                  <Plus />
                  Add condition
                </Button>
                {error && (
                  <p className="table-filter-error" role="alert">
                    {error}
                  </p>
                )}
              </form>
            </Modal.Body>
            <Modal.Footer className="table-filter-footer">
              <Button
                variant="danger"
                className="table-filter-clear"
                isDisabled={!value.length}
                onPress={onClear}
              >
                Clear all filters
              </Button>
              <Button variant="secondary" onPress={onClose}>
                Cancel
              </Button>
              <Button type="submit" form={formId}>
                Apply
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
