"use client";

import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { statusColor, statusIcon, statusLabel } from "./status";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUpZeroOneIcon,
  CheckListIcon,
  MinusSignIcon,
  TextFontIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Label, ListBox, Select } from "@heroui/react";
import {
  canonicalJson,
  limits,
  type UniqueRuleCondition,
} from "@rootset/contracts";
import {
  parseUniqueRuleCondition,
  uniqueRuleConditionLabel,
} from "../../lib/unique-rule-condition";
import { allowedValueLabel } from "../../lib/field-choices";
import { operatorLabels } from "../../lib/table-filters";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  ResourceName,
  ResourceTable,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { Dialog } from "../dialog";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { Check, Trash2, Plus, Pencil, View } from "../ui/icons";
import { FieldTable } from "./field-table";
import { PageSelectionTitle } from "./account/page-selection-title";
import { fieldConstraints } from "./field-constraints";
import {
  organisationPath,
  tablePath,
  useMutation,
  useResource,
  write,
} from "./api";
import {
  Choice,
  Empty,
  Field,
  Form,
  Loading,
  Record,
  Section,
  Toggle,
  useConfirmation,
} from "./ui";
import {
  type SettingsPanelProps,
  type Job,
  type TableField,
  type TableSchemaResult,
} from "./types";

import { FIELD_TYPE_OPTIONS, FieldTypeIcon } from "./field-type-options";
import {
  fieldDraft,
  parseFieldDraft,
  type FieldDraft,
  type FieldDraftErrors,
} from "./field-draft";

const EMPTY_SCHEMA: TableSchemaResult = {
  table: { name: "", schemaVersion: 1 },
  fields: [],
  uniqueRules: [],
  foreignKeys: [],
};

function useSchema(props: SettingsPanelProps) {
  const path =
    props.databaseId && props.tableId
      ? tablePath(props.orgId, props.databaseId, props.tableId)
      : undefined;
  return {
    path,
    ...useResource<TableSchemaResult>(
      path ? `${path}/schema` : undefined,
      EMPTY_SCHEMA,
    ),
  };
}

export function TableSettings(props: SettingsPanelProps) {
  const schema = useSchema(props);
  const mutation = useMutation(() => {
    schema.reload();
    props.onChanged?.();
  });

  const [name, setName] = useState(schema.data.table.name);
  const [description, setDescription] = useState(
    schema.data.table.description ?? "",
  );
  useLayoutEffect(() => {
    setName(schema.data.table.name);
    setDescription(schema.data.table.description ?? "");
  }, [schema.data]);
  if (!schema.path)
    return <Empty>Select a table to manage its settings.</Empty>;
  return (
    <>
      <Loading {...schema} retry={schema.reload} />
      <Section title="Table details">
        <Form
          busy={mutation.busy}
          onSubmit={async () => {
            await mutation.run(
              () =>
                write(schema.path!, "PATCH", {
                  name,
                  description,
                  expectedSchemaVersion: schema.data.table.schemaVersion,
                }),
              "Table updated.",
            );
          }}
        >
          <Field label="Table name" value={name} onChange={setName} required />
          <Field
            label="Description"
            value={description}
            onChange={setDescription}
            multiline
          />
        </Form>
      </Section>
      {schema.data.table.state === "maintenance" && (
        <p role="status" className="settings-muted">
          This table is in read-only maintenance. Existing data remains visible
          while the schema job runs.
        </p>
      )}
    </>
  );
}

export function TableDangerZone(props: SettingsPanelProps) {
  const schema = useSchema(props);
  const mutation = useMutation(() => {
    props.onChanged?.();
    props.onClose();
  });
  const confirmation = useConfirmation();
  if (!schema.path)
    return <Empty>Select a table to manage its settings.</Empty>;
  return (
    <>
      <Loading {...schema} retry={schema.reload} />
      <Section
        title="Delete table"
        description="Deleting this table removes access to its rows and fields in Rootset, the API and MCP, and deletes their cell changelogs. This cannot be undone in Rootset."
      >
        <Button
          variant="danger-soft"
          isDisabled={mutation.busy}
          onPress={async () => {
            if (
              await confirmation.confirm(
                "Delete this table?",
                `Delete ${schema.data.table.name || "this table"}? Its rows and fields will no longer be accessible, and its cell changelogs will be deleted.`,
                "Delete table",
              )
            )
              await mutation.run(
                () =>
                  write(schema.path!, "DELETE", {
                    expectedSchemaVersion: schema.data.table.schemaVersion,
                  }),
                "Table deletion requested.",
              );
          }}
        >
          <Trash2 />
          Delete table
        </Button>
      </Section>
      {confirmation.dialog}
    </>
  );
}

export function FieldForm({
  field,
  busy,
  submit,
  onCancel,
}: {
  onCancel?: () => void;
  field?: TableField;
  busy: boolean;
  submit: (input: Record<string, unknown>) => Promise<void>;
}) {
  const [value, setValue] = useState(() => fieldDraft(field));
  const [errors, setErrors] = useState<FieldDraftErrors>({});
  function patch<K extends keyof FieldDraft>(key: K, next: FieldDraft[K]) {
    const updated = { ...value, [key]: next };
    if (
      key === "type" &&
      next !== "integer" &&
      updated.defaultMode === "autoIncrement"
    )
      updated.defaultMode = "none";
    setValue(updated);
    if (Object.keys(errors).length)
      setErrors(parseFieldDraft(updated).errors ?? {});
  }
  return (
    <Form
      busy={busy}
      submit={field ? "Preview and apply changes" : "Add field"}
      submitIcon={field ? <View /> : <Plus />}
      noValidate
      onCancel={onCancel}
      onSubmit={async () => {
        const parsed = parseFieldDraft(value);
        setErrors(parsed.errors ?? {});
        if (!parsed.input) {
          toast.danger(
            Object.values(parsed.errors)[0] ?? "Check the field definition.",
          );
          return;
        }
        try {
          await submit(parsed.input);
        } catch (reason) {
          toast.danger(
            reason instanceof Error
              ? reason.message
              : "Check the field definition.",
          );
        }
      }}
    >
      <Field
        label="Column name"
        value={value.name}
        onChange={(next) => patch("name", next)}
        required
        minLength={1}
        maxLength={64}
        pattern="[A-Za-z_]+"
        description="Use 1–64 letters or underscores."
      />
      <Choice
        label="Field type"
        value={value.type}
        onChange={(next) => patch("type", next as TableField["type"])}
        options={FIELD_TYPE_OPTIONS}
      />
      {value.type === "text" && (
        <Field
          label="Maximum characters"
          type="number"
          value={value.charLimit}
          onChange={(next) => patch("charLimit", next)}
          min={1}
          max={65536}
          required
        />
      )}
      {value.type === "text" && (
        <>
          <Choice
            label="Allowed values"
            value={value.restrictValues ? "choices" : "any"}
            disabled={busy}
            options={[
              {
                value: "any",
                label: "Any text",
                icon: (
                  <HugeiconsIcon icon={TextFontIcon} size={16} aria-hidden />
                ),
              },
              {
                value: "choices",
                label: "Only these choices",
                icon: (
                  <HugeiconsIcon icon={CheckListIcon} size={16} aria-hidden />
                ),
              },
            ]}
            onChange={(next) => patch("restrictValues", next === "choices")}
          />
          {value.restrictValues && (
            <div className="flex flex-col gap-2">
              {value.allowedValues.map((choice, index) => (
                <div key={index} className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field
                      label={index === 0 ? "Choices" : `Choice ${index + 1}`}
                      hideLabel={index > 0}
                      value={choice}
                      multiline
                      rows={Math.min(3, choice.split(/\r?\n/).length)}
                      readOnly={busy}
                      onChange={(next) =>
                        patch(
                          "allowedValues",
                          value.allowedValues.map((entry, position) =>
                            position === index ? next : entry,
                          ),
                        )
                      }
                    />
                  </div>
                  <Button
                    variant="secondary"
                    isDisabled={busy}
                    aria-label={`Remove choice ${index + 1}`}
                    onPress={() =>
                      patch(
                        "allowedValues",
                        value.allowedValues.filter(
                          (_, position) => position !== index,
                        ),
                      )
                    }
                  >
                    <Trash2 />
                    Remove
                  </Button>
                </div>
              ))}
              {errors.allowedValues && (
                <p role="alert" className="text-danger">
                  {errors.allowedValues}
                </p>
              )}
              <Button
                className="mt-1"
                variant="secondary"
                isDisabled={
                  busy || value.allowedValues.length >= limits.maxAllowedValues
                }
                onPress={() =>
                  patch("allowedValues", [...value.allowedValues, ""])
                }
              >
                <Plus />
                Add choice
              </Button>
            </div>
          )}
        </>
      )}
      {["integer", "float", "date", "date-time"].includes(value.type) && (
        <div className="settings-inline">
          <Field
            label="Minimum (inclusive)"
            value={
              value.type === "date-time" ? value.min.slice(0, 10) : value.min
            }
            onChange={(next) => patch("min", next)}
            type={
              ["date", "date-time"].includes(value.type)
                ? "date"
                : ["integer", "float"].includes(value.type)
                  ? "number"
                  : "text"
            }
            step={value.type === "float" ? "any" : 1}
            description={
              value.type === "date-time"
                ? "Selected dates use midnight UTC."
                : undefined
            }
          />
          <Field
            label="Maximum (inclusive)"
            value={
              value.type === "date-time" ? value.max.slice(0, 10) : value.max
            }
            onChange={(next) => patch("max", next)}
            type={
              ["date", "date-time"].includes(value.type)
                ? "date"
                : ["integer", "float"].includes(value.type)
                  ? "number"
                  : "text"
            }
            step={value.type === "float" ? "any" : 1}
          />
        </div>
      )}
      <Choice
        label="Default for new rows"
        value={value.defaultMode}
        onChange={(next) =>
          patch("defaultMode", next as FieldDraft["defaultMode"])
        }
        options={[
          {
            value: "none",
            label: "No default",
            icon: <HugeiconsIcon icon={MinusSignIcon} size={16} aria-hidden />,
          },
          {
            value: "value",
            label: "A literal value",
            icon: <FieldTypeIcon type={value.type} />,
          },
          ...(value.type === "integer"
            ? [
                {
                  value: "autoIncrement",
                  label: "Auto-increment",
                  icon: (
                    <HugeiconsIcon
                      icon={ArrowUpZeroOneIcon}
                      size={16}
                      aria-hidden
                    />
                  ),
                },
              ]
            : []),
        ]}
        error={errors.defaultMode}
      />
      {value.defaultMode === "value" &&
        (value.type === "boolean" ? (
          <Toggle
            label="Default value"
            selected={value.defaultBoolean}
            onChange={(next) => patch("defaultBoolean", next)}
          />
        ) : value.type === "text" && value.restrictValues ? (
          <Choice
            label="Default value"
            value={value.defaultValue}
            disabled={busy}
            error={errors.defaultValue}
            options={[
              ...new Set(value.allowedValues.filter((choice) => choice !== "")),
            ].map((choice) => ({
              value: choice,
              label: allowedValueLabel(choice),
              icon: <FieldTypeIcon type="text" />,
            }))}
            onChange={(next) => patch("defaultValue", next)}
          />
        ) : (
          <Field
            label="Default value"
            value={value.defaultValue}
            onChange={(next) => patch("defaultValue", next)}
            type={
              ["integer", "float"].includes(value.type)
                ? "number"
                : value.type === "date"
                  ? "date"
                  : "text"
            }
            multiline={value.type === "json"}
            required={value.required}
            step={value.type === "float" ? "any" : 1}
            description={
              value.type === "time"
                ? "UTC time with Z, for example 12:30:00.000Z."
                : value.type === "date-time"
                  ? "UTC date-time with Z."
                  : value.type === "json"
                    ? "Enter a valid JSON value."
                    : undefined
            }
          />
        ))}
      <Toggle
        label="Required"
        selected={value.required}
        onChange={(required) => patch("required", required)}
      />
    </Form>
  );
}

export function FieldsSettings(props: SettingsPanelProps) {
  const schema = useSchema(props);
  const mutation = useMutation();
  const [pendingJobId, setPendingJobId] = useState<string>();
  const job = useResource<Job | null>(
    pendingJobId
      ? `${organisationPath(props.orgId)}/jobs/${pendingJobId}`
      : undefined,
    null,
  );
  useEffect(() => {
    if (!pendingJobId) return;
    const timer = setInterval(job.reload, 2000);
    return () => clearInterval(timer);
  }, [pendingJobId, job.reload]);
  useEffect(() => {
    if (
      !pendingJobId ||
      job.data?.id !== pendingJobId ||
      ["queued", "running", "snapshotting", "uploading", "verifying"].includes(
        job.data.state,
      )
    )
      return;
    setPendingJobId(undefined);
    schema.reload();
    props.onChanged?.();
    if (job.data.state === "succeeded") toast.success("Fields updated.");
    else
      toast.danger(
        typeof job.data.error === "string"
          ? job.data.error
          : (job.data.error?.message ??
              "The field change could not be applied."),
      );
  }, [pendingJobId, job.data, schema.reload, props.onChanged]);
  function applySchema(result: TableSchemaResult | { jobId: string }) {
    if ("jobId" in result) setPendingJobId(result.jobId);
    else {
      schema.replace(result);
      props.onChanged?.();
    }
  }
  const confirmation = useConfirmation();
  const [editing, setEditing] = useState<TableField>();
  const [formOpen, setFormOpen] = useState(false);
  type FieldPreview = {
    valid?: boolean;
    conflicts?: { message?: string; rowId?: string; fieldId?: string }[];
    requiresJob?: boolean;
    rowCount?: number;
    reportArtifactId?: string;
  };
  const actions = useMemo(
    () => (
      <Button
        isDisabled={
          !schema.path ||
          schema.loading ||
          mutation.busy ||
          Boolean(pendingJobId)
        }
        onPress={() => {
          setEditing(undefined);
          setFormOpen(true);
        }}
      >
        <Plus />
        Add field
      </Button>
    ),
    [schema.path, schema.loading, mutation.busy, pendingJobId],
  );
  function closeForm() {
    if (mutation.busy) return;
    setFormOpen(false);
    setEditing(undefined);
  }
  if (!schema.path) return <Empty>Select a table to manage fields.</Empty>;
  async function apply(input: Record<string, unknown>) {
    if (!editing) {
      const result = await mutation.run(
        () =>
          write<TableSchemaResult | { jobId: string }>(
            `${schema.path}/fields`,
            "POST",
            {
              field: input,
              expectedSchemaVersion: schema.data.table.schemaVersion,
            },
          ),
        "Field creation requested.",
      );
      if (result.ok) {
        applySchema(result.value);
        setFormOpen(false);
        setEditing(undefined);
      }
      return;
    }
    const clearDefault =
      Object.hasOwn(editing, "default") && !Object.hasOwn(input, "default");
    const changes = {
      ...input,
      ...(clearDefault ? { clearDefault: true } : {}),
    };
    const change = {
      kind: "update_field",
      fieldId: editing.id,
      changes,
      conversion: "explicit",
    };
    const check = await mutation.run(() =>
      write<FieldPreview>(`${schema.path}/schema/preview`, "POST", {
        expectedSchemaVersion: schema.data.table.schemaVersion,
        change,
      }),
    );
    if (!check.ok) return;
    if (check.value.valid === false || check.value.conflicts?.length) {
      toast.danger("The field change cannot be applied.", {
        description: [
          ...new Set(
            check.value.conflicts?.map(
              (conflict) =>
                conflict.message ??
                "Existing data violates the field definition.",
            ),
          ),
        ].join(" "),
      });
      return;
    }
    if (
      await confirmation.confirm(
        "Apply this field change?",
        `${check.value.rowCount ?? "Existing"} rows will be checked. ${check.value.requiresJob ? "The table will enter read-only maintenance while the job runs." : "Rootset validates existing data before activating the change."}`,
        "Apply change",
      )
    ) {
      const result = await mutation.run(
        () =>
          write<TableSchemaResult | { jobId: string }>(
            `${schema.path}/fields/${editing.id}`,
            "PATCH",
            {
              field: input,
              ...(clearDefault ? { clearDefault: true } : {}),
              conversion: "explicit",
              expectedSchemaVersion: schema.data.table.schemaVersion,
            },
          ),
        "Field change requested.",
      );
      if (result.ok) {
        applySchema(result.value);
        setFormOpen(false);
        setEditing(undefined);
      }
    }
  }
  async function reorder(ids: string[]) {
    const result = await mutation.run(
      () =>
        write<TableSchemaResult | { jobId: string }>(
          `${schema.path}/field-order`,
          "PUT",
          {
            fieldIds: ids,
            expectedSchemaVersion: schema.data.table.schemaVersion,
          },
        ),
      "Field order updated.",
    );
    if (result.ok) applySchema(result.value);
  }
  const disabled = mutation.busy || schema.loading || Boolean(pendingJobId);
  return (
    <>
      <PageSelectionTitle label="Fields" actions={actions} />
      <Loading {...schema} retry={schema.reload} />
      {(!schema.loading || schema.data.fields.length > 0) && !schema.error && (
        <FieldTable
          items={schema.data.fields}
          disabled={disabled}
          onReorder={reorder}
          emptyAction={actions}
          columns={[
            {
              key: "name",
              header: "Column name",
              cell: (field) => (
                <ResourceName
                  name={field.name}
                  description={
                    <span className="flex items-center gap-1.5">
                      <FieldTypeIcon type={field.type} size={14} />
                      {field.type}
                    </span>
                  }
                />
              ),
            },
            {
              key: "required",
              header: "Required",
              cell: (field) => <FieldCheck checked={Boolean(field.required)} />,
            },
            {
              key: "default",
              header: "Default value",
              cell: (field) => {
                const generated =
                  field.type === "integer" && field.autoIncrement;
                const missing =
                  !generated && field.default === undefined && field.required;
                const value = generated
                  ? "Auto-increment"
                  : field.default == null
                    ? "NULL"
                    : JSON.stringify(field.default);
                return (
                  <TooltipText
                    tooltip={missing ? "No default value" : value}
                    className={`block max-w-64 truncate${missing ? " field-empty" : !generated && field.default == null ? " null-value" : ""}`}
                  >
                    {missing ? "—" : value}
                  </TooltipText>
                );
              },
            },
            {
              key: "constraints",
              header: "Constraints",
              className: "field-constraints",
              cell: (field) => {
                const constraints = fieldConstraints(
                  field,
                  props.preferences,
                ).join(", ");
                return (
                  <span className={constraints ? undefined : "field-empty"}>
                    {constraints || "—"}
                  </span>
                );
              },
            },
            {
              key: "actions",
              header: "Actions",
              headerClassName: "text-right",
              cell: (field) => (
                <div className="field-edit-actions">
                  <Button
                    variant="secondary"
                    isDisabled={disabled}
                    onPress={() => {
                      setEditing(field);
                      setFormOpen(true);
                    }}
                  >
                    <Pencil />
                    Edit
                  </Button>
                  <Button
                    variant="danger-soft"
                    isDisabled={disabled}
                    onPress={async () => {
                      const dependencies = schema.data.uniqueRules.filter(
                        (rule) =>
                          (rule.fieldIds ?? rule.fields ?? []).includes(
                            field.id,
                          ) || rule.where?.field === field.id,
                      );
                      if (
                        await confirmation.confirm(
                          "Remove this field?",
                          `${field.name} will be removed from the active table. ${dependencies.length ? `${dependencies.length} dependent unique rules will also be removed. ` : ""}Its cell changelogs are permanently removed.`,
                          "Remove field",
                        )
                      ) {
                        const result = await mutation.run(
                          () =>
                            write<TableSchemaResult | { jobId: string }>(
                              `${schema.path}/fields/${field.id}`,
                              "DELETE",
                              {
                                expectedSchemaVersion:
                                  schema.data.table.schemaVersion,
                                removeDependencies: dependencies.length > 0,
                              },
                            ),
                          "Field removal requested.",
                        );
                        if (result.ok) applySchema(result.value);
                      }
                    }}
                  >
                    <Trash2 />
                    Remove
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
      {formOpen && (
        <Dialog
          title={editing ? `Edit ${editing.name}` : "Add field"}
          onClose={closeForm}
          closeDisabled={mutation.busy}
        >
          <FieldForm
            key={editing?.id ?? "new"}
            field={editing}
            busy={mutation.busy}
            submit={apply}
            onCancel={closeForm}
          />
        </Dialog>
      )}
      {confirmation.dialog}
    </>
  );
}

function FieldCheck({ checked }: { checked: boolean }) {
  return (
    <span className={`field-check${checked ? " field-check-yes" : ""}`}>
      <span className="sr-only">{checked ? "Yes" : "No"}</span>
      {checked ? (
        <Check size={18} />
      ) : (
        <span className="field-empty" aria-hidden="true">
          —
        </span>
      )}
    </span>
  );
}

export function UniqueRulesSettings(props: SettingsPanelProps) {
  const schema = useSchema(props);
  const mutation = useMutation();
  const [pendingJobId, setPendingJobId] = useState<string>();
  const job = useResource<Job | null>(
    pendingJobId
      ? `${organisationPath(props.orgId)}/jobs/${pendingJobId}`
      : undefined,
    null,
  );
  useEffect(() => {
    if (!pendingJobId) return;
    const timer = setInterval(job.reload, 2000);
    return () => clearInterval(timer);
  }, [pendingJobId, job.reload]);
  useEffect(() => {
    if (
      !pendingJobId ||
      job.data?.id !== pendingJobId ||
      ["queued", "running", "snapshotting", "uploading", "verifying"].includes(
        job.data.state,
      )
    )
      return;
    setPendingJobId(undefined);
    schema.reload();
    props.onChanged?.();
    if (job.data.state === "succeeded") {
      setFormOpen(false);
      toast.success("Unique rule created.");
    } else {
      toast.danger(
        typeof job.data.error === "string"
          ? job.data.error
          : (job.data.error?.message ??
              "The unique rule could not be created."),
      );
    }
  }, [pendingJobId, job.data, schema.reload, props.onChanged]);
  const confirmation = useConfirmation();
  const [formOpen, setFormOpen] = useState(false);
  const [fieldIds, setFieldIds] = useState<string[]>([]);
  const [conditional, setConditional] = useState(false);
  const [conditionField, setConditionField] = useState("");
  const [conditionOp, setConditionOp] =
    useState<UniqueRuleCondition["op"]>("eq");
  const [conditionValue, setConditionValue] = useState("");
  const [conditionError, setConditionError] = useState<string>();
  const predicateField = schema.data.fields.find(
    (field) => field.id === conditionField,
  );
  const fields = schema.data.fields.filter((field) => field.type !== "json");
  const busy = mutation.busy || Boolean(pendingJobId);
  const disabled = busy || schema.loading || Boolean(schema.error);
  const actions = useMemo(
    () => (
      <Button
        isDisabled={disabled || !fields.length}
        onPress={() => {
          setFieldIds([]);
          setConditional(false);
          setConditionField("");
          setConditionOp("eq");
          setConditionValue("");
          setConditionError(undefined);
          setFormOpen(true);
        }}
      >
        <Plus />
        Create unique rule
      </Button>
    ),
    [disabled, fields.length],
  );
  if (!schema.path)
    return <Empty>Select a table to manage unique rules.</Empty>;
  return (
    <>
      <PageSelectionTitle label="Unique rules" actions={actions} />
      <Loading {...schema} retry={schema.reload} />
      <Loading {...job} retry={job.reload} />
      {(!schema.loading || schema.data.uniqueRules.length > 0) &&
        !schema.error && (
          <ResourceTable
            ariaLabel="Unique rules"
            items={schema.data.uniqueRules}
            getRowKey={(rule) => rule.id}
            tableClassName="min-w-2xl"
            emptyTitle="No unique rules yet"
            emptyDescription="Create a rule to prevent duplicate values in a field or combination of fields."
            emptyAction={actions}
            columns={[
              {
                key: "fields",
                header: "Fields",
                cell: (rule) =>
                  (rule.fieldIds ?? rule.fields ?? [])
                    .map(
                      (id) =>
                        schema.data.fields.find((field) => field.id === id)
                          ?.name ?? id,
                    )
                    .join(", "),
              },
              {
                key: "condition",
                header: "Applies to",
                cell: (rule) => {
                  const condition = uniqueRuleConditionLabel(
                    rule.where,
                    schema.data.fields,
                  );
                  return (
                    <TooltipText
                      tooltip={condition}
                      className="block max-w-80 truncate"
                    >
                      {condition}
                    </TooltipText>
                  );
                },
              },
              {
                key: "status",
                header: "Status",
                cell: (rule) => {
                  const status = rule.state ?? rule.status ?? "unknown";
                  return (
                    <Chip color={statusColor(status)}>
                      <HugeiconsIcon
                        aria-hidden="true"
                        size={14}
                        icon={statusIcon(status)}
                      />
                      <Chip.Label>{statusLabel(status)}</Chip.Label>
                    </Chip>
                  );
                },
              },
              {
                key: "actions",
                header: "Actions",
                headerClassName: "text-right",
                cell: (rule) => (
                  <div className="field-edit-actions">
                    <Button
                      variant="danger-soft"
                      isDisabled={disabled}
                      onPress={async () => {
                        if (
                          await confirmation.confirm(
                            "Remove unique rule?",
                            "Future writes will no longer enforce this uniqueness rule.",
                            "Remove",
                          )
                        ) {
                          const result = await mutation.run(
                            () =>
                              write(
                                `${schema.path}/unique-rules/${rule.id}`,
                                "DELETE",
                                {
                                  expectedSchemaVersion:
                                    schema.data.table.schemaVersion,
                                },
                              ),
                            "Unique rule removed.",
                          );
                          if (result.ok) {
                            schema.reload();
                            props.onChanged?.();
                          }
                        }
                      }}
                    >
                      <Trash2 />
                      Remove
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      {formOpen && (
        <Dialog
          title="Create unique rule"
          onClose={() => setFormOpen(false)}
          closeDisabled={busy}
        >
          <Form
            noValidate
            busy={busy}
            submit="Create unique rule"
            submitIcon={<Plus />}
            onCancel={() => setFormOpen(false)}
            onSubmit={async () => {
              if (!fieldIds.length) {
                toast.danger("Choose at least one field.");
                return;
              }
              let where: UniqueRuleCondition | undefined;
              try {
                where = conditional
                  ? parseUniqueRuleCondition(
                      schema.data.fields,
                      conditionField,
                      conditionOp,
                      conditionValue,
                    )
                  : undefined;
                setConditionError(undefined);
              } catch (error) {
                setConditionError(
                  error instanceof Error
                    ? error.message
                    : "Check the condition value.",
                );
                return;
              }
              if (
                schema.data.uniqueRules.some((rule) => {
                  const existingFields = rule.fieldIds ?? rule.fields ?? [];
                  return (
                    existingFields.length === fieldIds.length &&
                    fieldIds.every((id) => existingFields.includes(id)) &&
                    canonicalJson(rule.where ?? null) ===
                      canonicalJson(where ?? null)
                  );
                })
              ) {
                toast.danger(
                  "A unique rule already exists for these fields and condition.",
                );
                return;
              }
              const result = await mutation.run(() =>
                write<{ jobId?: string }>(
                  `${schema.path}/unique-rules`,
                  "POST",
                  {
                    fieldIds,
                    ...(where ? { where } : {}),
                    expectedSchemaVersion: schema.data.table.schemaVersion,
                  },
                ),
              );
              if (result.ok) {
                if (result.value.jobId) setPendingJobId(result.value.jobId);
                else {
                  schema.reload();
                  props.onChanged?.();
                  setFormOpen(false);
                  toast.success("Unique rule created.");
                }
              }
            }}
          >
            <p className="settings-muted">
              Matching rows must have a unique combination of the selected
              fields. Rows containing NULL in any selected unique field are
              excluded.
            </p>
            <Choice
              label="Apply to"
              value={conditional ? "matching" : "all"}
              disabled={busy}
              options={[
                { value: "all", label: "All rows" },
                { value: "matching", label: "Rows matching a condition" },
              ]}
              onChange={(value) => {
                setConditional(value === "matching");
                setConditionError(undefined);
              }}
            />
            {conditional && (
              <>
                <Choice
                  label="Condition field"
                  value={conditionField}
                  required
                  disabled={busy}
                  options={fields.map((field) => ({
                    value: field.id,
                    label: field.name,
                  }))}
                  error={!conditionField ? conditionError : undefined}
                  onChange={(value) => {
                    setConditionField(value);
                    setConditionValue("");
                    setConditionError(undefined);
                  }}
                />
                <Choice
                  label="Condition"
                  value={conditionOp}
                  disabled={busy}
                  options={(["eq", "ne", "isNull", "isNotNull"] as const).map(
                    (op) => ({ value: op, label: operatorLabels[op] }),
                  )}
                  onChange={(value) => {
                    setConditionOp(value as UniqueRuleCondition["op"]);
                    setConditionError(undefined);
                  }}
                />
                {(conditionOp === "eq" || conditionOp === "ne") &&
                  (predicateField?.type === "boolean" ? (
                    <Choice
                      label="Condition value"
                      value={conditionValue}
                      disabled={busy}
                      required
                      error={conditionField ? conditionError : undefined}
                      options={["true", "false"]}
                      onChange={(value) => {
                        setConditionValue(value);
                        setConditionError(undefined);
                      }}
                    />
                  ) : (
                    <Field
                      label="Condition value"
                      value={conditionValue}
                      readOnly={busy}
                      error={conditionField ? conditionError : undefined}
                      description={
                        predicateField?.type === "date-time"
                          ? "Use an ISO date-time in UTC, for example 2026-01-01T00:00:00Z."
                          : predicateField?.type === "time"
                            ? "Use UTC time, for example 09:30:00Z."
                            : predicateField?.type === "date"
                              ? "Use YYYY-MM-DD."
                              : undefined
                      }
                      onChange={(value) => {
                        setConditionValue(value);
                        setConditionError(undefined);
                      }}
                    />
                  ))}
                <p className="settings-muted">
                  NULL condition values match only “is NULL”. Text matches
                  exactly, including case and spaces.
                </p>
              </>
            )}
            <Select
              variant="secondary"
              className="settings-field"
              selectionMode="multiple"
              placeholder="Choose fields"
              value={fieldIds}
              isRequired
              isDisabled={busy}
              onChange={(keys) => {
                const next = keys.map(String);
                if (next.length > limits.maxUniqueFields) {
                  toast.danger(
                    `Choose up to ${limits.maxUniqueFields} fields.`,
                  );
                  return;
                }
                setFieldIds(next);
              }}
            >
              <Label>Fields</Label>
              <Select.Trigger>
                <Select.Value>
                  {fieldIds
                    .map(
                      (id) =>
                        fields.find((field) => field.id === id)?.name ?? id,
                    )
                    .join(", ") || "Choose fields"}
                </Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {fields.map((field) => (
                    <ListBox.Item
                      key={field.id}
                      id={field.id}
                      textValue={field.name}
                    >
                      <span className="flex items-center gap-2">
                        <FieldTypeIcon type={field.type} />
                        {field.name}
                      </span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </Form>
        </Dialog>
      )}
      {confirmation.dialog}
    </>
  );
}
