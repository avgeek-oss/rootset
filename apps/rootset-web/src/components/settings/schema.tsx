"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { useEffect, useMemo, useState } from "react";
import {
  ResourceName,
  ResourceTable,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { Dialog } from "../dialog";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { Check, ChevronDown, ChevronUp } from "../ui/icons";
import { PageSelectionTitle } from "./account/page-selection-title";
import { fieldConstraints } from "./field-constraints";
import {
  organisationPath,
  performAction,
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
  RecordList,
  Section,
  Status,
  Toggle,
  useConfirmation,
} from "./ui";
import {
  FIELD_TYPES,
  type SettingsPanelProps,
  type Job,
  type TableField,
  type TableSchemaResult,
} from "./types";

import { fieldDraft, parseFieldDraft, type FieldDraft } from "./field-draft";

const EMPTY_SCHEMA: TableSchemaResult = {
  table: { name: "", schemaVersion: 1 },
  fields: [],
  uniqueRules: [],
  indexes: [],
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

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
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
        description="Deleting this table removes access to its rows and fields in Rootset, the API and MCP, and deletes their cell changelogs. You will need to confirm your identity before deletion. This cannot be undone in Rootset."
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
                  performAction("deleteTable", {
                    orgId: props.orgId,
                    databaseId: props.databaseId,
                    tableId: props.tableId,
                    expectedSchemaVersion: schema.data.table.schemaVersion,
                  }),
                "Table deletion requested.",
              );
          }}
        >
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
  function patch<K extends keyof FieldDraft>(key: K, next: FieldDraft[K]) {
    setValue((previous) => ({ ...previous, [key]: next }));
  }
  return (
    <Form
      busy={busy}
      submit={field ? "Preview and apply changes" : "Add field"}
      onCancel={onCancel}
      onSubmit={async () => {
        const parsed = parseFieldDraft(value);
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
        options={FIELD_TYPES}
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
      {["integer", "float", "date", "date-time"].includes(value.type) && (
        <div className="settings-inline">
          <Field
            label="Minimum (inclusive)"
            value={value.min}
            onChange={(next) => patch("min", next)}
            type={
              value.type === "date"
                ? "date"
                : ["integer", "float"].includes(value.type)
                  ? "number"
                  : "text"
            }
            step={value.type === "float" ? "any" : 1}
            description={
              value.type === "date-time"
                ? "UTC instant, for example 2026-01-01T00:00:00.000Z."
                : undefined
            }
          />
          <Field
            label="Maximum (inclusive)"
            value={value.max}
            onChange={(next) => patch("max", next)}
            type={
              value.type === "date"
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
        onChange={(next) => patch("defaultMode", next)}
        options={[
          { value: "none", label: "No explicit default" },
          { value: "null", label: "Null" },
          { value: "value", label: "A literal value" },
        ]}
      />
      {value.defaultMode === "value" &&
        (value.type === "boolean" ? (
          <Toggle
            label="Default value"
            selected={value.defaultBoolean}
            onChange={(next) => patch("defaultBoolean", next)}
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
      <div className="settings-inline">
        <Toggle
          label="Required"
          selected={value.required}
          onChange={(next) => patch("required", next)}
        />
        <Toggle
          label="Nullable"
          selected={!value.required}
          onChange={(next) => patch("required", !next)}
        />
      </div>
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
    const changes = { ...input };
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
        description: check.value.conflicts
          ?.map(
            (conflict) =>
              conflict.message ??
              "Existing data violates the field definition.",
          )
          .join(" "),
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
  async function move(field: TableField, direction: number) {
    const ids = schema.data.fields.map((item) => item.id);
    const position = ids.indexOf(field.id);
    const next = position + direction;
    if (next < 0 || next >= ids.length) return;
    [ids[position], ids[next]] = [ids[next]!, ids[position]!];
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
        <ResourceTable
          ariaLabel="Fields"
          items={schema.data.fields}
          getRowKey={(field) => field.id}
          mobileLayout="stacked"
          tableClassName="rootset-fields-table"
          emptyTitle="No fields yet"
          emptyDescription="Add a field to define the columns and values this table can store."
          emptyAction={actions}
          columns={[
            {
              key: "name",
              header: "Column name",
              cell: (field) => {
                const position = schema.data.fields.indexOf(field);
                return (
                  <div className="field-name-cell">
                    <div className="field-order-actions">
                      <Button
                        isIconOnly
                        variant="ghost"
                        aria-label={`Move ${field.name} up`}
                        isDisabled={disabled || position === 0}
                        onPress={() => move(field, -1)}
                      >
                        <ChevronUp />
                      </Button>
                      <Button
                        isIconOnly
                        variant="ghost"
                        aria-label={`Move ${field.name} down`}
                        isDisabled={
                          disabled || position === schema.data.fields.length - 1
                        }
                        onPress={() => move(field, 1)}
                      >
                        <ChevronDown />
                      </Button>
                    </div>
                    <ResourceName name={field.name} description={field.type} />
                  </div>
                );
              },
            },
            {
              key: "required",
              header: "Required",
              cell: (field) => <FieldCheck checked={Boolean(field.required)} />,
            },
            {
              key: "nullable",
              header: "Nullable",
              cell: (field) => <FieldCheck checked={!field.required} />,
            },
            {
              key: "constraints",
              header: "Constraints",
              className: "field-constraints",
              cell: (field) => (
                <span>{fieldConstraints(field).join(", ") || "—"}</span>
              ),
            },
            {
              key: "actions",
              header: "Actions",
              mobileFullWidth: true,
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
                    Edit
                  </Button>
                  <Button
                    variant="danger-soft"
                    isDisabled={disabled}
                    onPress={async () => {
                      const dependencies = [
                        ...schema.data.uniqueRules,
                        ...schema.data.indexes,
                      ].filter((rule) =>
                        (rule.fieldIds ?? rule.fields ?? []).includes(field.id),
                      );
                      if (
                        await confirmation.confirm(
                          "Remove this field?",
                          `${field.name} will be removed from the active table. ${dependencies.length ? `${dependencies.length} dependent rules/indexes will also be removed. ` : ""}Its cell changelogs are permanently removed.`,
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
        <span className="field-check-no" aria-hidden="true">
          —
        </span>
      )}
    </span>
  );
}

export function RulesIndexesSettings(
  props: SettingsPanelProps & { indexes?: boolean },
) {
  const schema = useSchema(props);
  const mutation = useMutation(() => {
    schema.reload();
    props.onChanged?.();
  });
  const confirmation = useConfirmation();
  const [fieldIds, setFieldIds] = useState<string[]>([]);
  const [kind, setKind] = useState("btree");
  const [selected, setSelected] = useState("");
  if (!schema.path)
    return (
      <Empty>
        Select a table to manage {props.indexes ? "indexes" : "unique rules"}.
      </Empty>
    );
  const entries = props.indexes ? schema.data.indexes : schema.data.uniqueRules;
  const suffix = props.indexes ? "indexes" : "unique-rules";
  return (
    <>
      <Loading {...schema} retry={schema.reload} />
      <Section
        title={props.indexes ? "Create search index" : "Create unique rule"}
        description={
          props.indexes
            ? "Indexes support specific operators and consume the 16-index budget. Build status must be active before Rootset advertises the index as ready."
            : "Single-field and composite uniqueness are opt-in. Tuples containing null do not participate. JSON uniqueness is outside v1."
        }
      >
        <Form
          busy={mutation.busy}
          submit={props.indexes ? "Build index" : "Build unique rule"}
          onSubmit={async () => {
            const result = await mutation.run(
              () =>
                write(`${schema.path}/${suffix}`, "POST", {
                  fieldIds,
                  expectedSchemaVersion: schema.data.table.schemaVersion,
                  ...(props.indexes ? { kind } : {}),
                }),
              "Build requested. Existing data and physical enforcement must validate before activation.",
            );
            if (result.ok) setFieldIds([]);
          }}
        >
          {props.indexes && (
            <Choice
              label="Index type"
              value={kind}
              onChange={setKind}
              options={[
                { value: "btree", label: "Exact values and ranges (B-tree)" },
                { value: "trigram", label: "Text contains (trigram)" },
                { value: "jsonb", label: "JSON paths and containment (GIN)" },
              ]}
            />
          )}
          <Choice
            label="Add field"
            value={selected}
            onChange={setSelected}
            options={schema.data.fields
              .filter((field) => props.indexes || field.type !== "json")
              .filter((field) => !fieldIds.includes(field.id))
              .map((field) => ({
                value: field.id,
                label: `${field.name} (${field.type})`,
              }))}
          />
          <Button
            variant="secondary"
            isDisabled={!selected || fieldIds.length >= 8}
            onPress={() => {
              if (selected) setFieldIds((previous) => [...previous, selected]);
              setSelected("");
            }}
          >
            Add field
          </Button>
          <RecordList>
            {fieldIds.map((id) => (
              <Record
                key={id}
                title={
                  schema.data.fields.find((field) => field.id === id)?.name ??
                  id
                }
              >
                <Button
                  variant="ghost"
                  onPress={() =>
                    setFieldIds((previous) =>
                      previous.filter((value) => value !== id),
                    )
                  }
                >
                  Remove
                </Button>
              </Record>
            ))}
          </RecordList>
          {!fieldIds.length && (
            <p className="settings-muted">
              Choose at least one field before submitting.
            </p>
          )}
        </Form>
      </Section>
      <Section title={props.indexes ? "Indexes" : "Unique rules"}>
        <RecordList>
          {entries.map((entry) => (
            <Record
              key={entry.id}
              title={(entry.fieldIds ?? entry.fields ?? [])
                .map(
                  (id) =>
                    schema.data.fields.find((field) => field.id === id)?.name ??
                    id,
                )
                .join(" + ")}
              description={
                <Status value={entry.state ?? entry.status ?? "unknown"} />
              }
            >
              <Button
                variant="danger-soft"

                isDisabled={mutation.busy}
                onPress={async () => {
                  if (
                    await confirmation.confirm(
                      props.indexes ? "Remove index?" : "Remove unique rule?",
                      props.indexes
                        ? "Queries remain available but may be slower after this index is removed."
                        : "Future writes will no longer enforce this uniqueness rule.",
                      "Remove",
                    )
                  )
                    await mutation.run(
                      () =>
                        write(
                          `${schema.path}/${suffix}/${entry.id}`,
                          "DELETE",
                          {
                            expectedSchemaVersion:
                              schema.data.table.schemaVersion,
                          },
                        ),
                      "Removal requested.",
                    );
                }}
              >
                Remove
              </Button>
            </Record>
          ))}
        </RecordList>
        {!schema.loading && !schema.error && !entries.length && (
          <Empty>No {props.indexes ? "indexes" : "unique rules"}.</Empty>
        )}
      </Section>
      {confirmation.dialog}
    </>
  );
}
