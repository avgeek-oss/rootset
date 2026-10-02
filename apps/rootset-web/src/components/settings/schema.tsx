"use client";

import { Button } from "@heroui/react";
import { useEffect, useState } from "react";
import { HistoryRetentionSettings } from "./history-retention";
import {
  performAction,
  tablePath,
  useMutation,
  useResource,
  write,
} from "./api";
import {
  Choice,
  Empty,
  Feedback,
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
  type TableField,
  type TableSchemaResult,
} from "./types";

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
  const confirmation = useConfirmation();
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
      <Feedback {...mutation} />
      <Section
        title="Table details"
        description={`Schema revision ${schema.data.table.schemaVersion} · ${schema.data.table.state ?? "active"}`}
      >
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
        <p role="status" className="settings-feedback">
          This table is in read-only maintenance. Existing data remains visible
          while the schema job runs.
        </p>
      )}
      <Section
        title="Delete table"
        description="Deleting a table starts a durable job and requires identity approval. Field metadata and history are retained according to the configured policy."
      >
        <Button
          variant="danger-soft"
          isDisabled={mutation.busy}
          onPress={async () => {
            if (
              await confirmation.confirm(
                "Delete this table?",
                `Delete ${name || "this table"}? This removes normal data access and cannot be undone without a restore.`,
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
                "Table deletion requested. Check Jobs for its terminal state.",
              );
          }}
        >
          Delete table
        </Button>
      </Section>
      {confirmation.dialog}
      <HistoryRetentionSettings {...props} />
    </>
  );
}

interface FieldDraft {
  label: string;
  apiKey: string;
  type: TableField["type"];
  required: boolean;
  charLimit: string;
  min: string;
  max: string;
  defaultMode: string;
  defaultValue: string;
  defaultBoolean: boolean;
}
function draft(field?: TableField): FieldDraft {
  return {
    label: field?.label ?? "",
    apiKey: field?.apiKey ?? "",
    type: field?.type ?? "text",
    required: field?.required ?? false,
    charLimit: String(field?.charLimit ?? 4096),
    min: String(field?.min ?? ""),
    max: String(field?.max ?? ""),
    defaultMode:
      field && Object.hasOwn(field, "default")
        ? field.default === null
          ? "null"
          : "value"
        : "none",
    defaultValue:
      field && field.default !== undefined && field.default !== null
        ? field.type === "json"
          ? JSON.stringify(field.default, null, 2)
          : String(field.default)
        : "",
    defaultBoolean: field?.default === true,
  };
}
function fieldInput(value: FieldDraft) {
  const result: Record<string, unknown> = {
    apiKey: value.apiKey,
    label: value.label,
    type: value.type,
    required: value.required,
  };
  if (value.type === "text") result.charLimit = Number(value.charLimit);
  if (["integer", "float", "date", "date-time"].includes(value.type))
    for (const bound of ["min", "max"] as const)
      if (value[bound] !== "")
        result[bound] = ["integer", "float"].includes(value.type)
          ? Number(value[bound])
          : value[bound];
  if (value.defaultMode === "null") result.default = null;
  if (value.defaultMode === "value")
    result.default =
      value.type === "json"
        ? JSON.parse(value.defaultValue)
        : value.type === "boolean"
          ? value.defaultBoolean
          : ["integer", "float"].includes(value.type)
            ? Number(value.defaultValue)
            : value.defaultValue;
  return result;
}

function FieldForm({
  field,
  busy,
  submit,
}: {
  field?: TableField;
  busy: boolean;
  submit: (input: Record<string, unknown>) => Promise<void>;
}) {
  const [value, setValue] = useState(() => draft(field));
  const [error, setError] = useState<string>();
  function patch<K extends keyof FieldDraft>(key: K, next: FieldDraft[K]) {
    setValue((previous) => ({ ...previous, [key]: next }));
  }
  return (
    <Form
      busy={busy}
      submit={field ? "Preview and apply changes" : "Create field"}
      onSubmit={async () => {
        setError(undefined);
        try {
          await submit(fieldInput(value));
        } catch (reason) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Check the field definition.",
          );
        }
      }}
    >
      <div className="settings-inline">
        <Field
          label="Label"
          value={value.label}
          onChange={(next) => patch("label", next)}
          required
        />
        <Field
          label="API key"
          value={value.apiKey}
          onChange={(next) => patch("apiKey", next)}
          required
          readOnly={Boolean(field)}
          pattern="[A-Za-z][A-Za-z0-9_]{0,63}"
          description="Stable identifier used by API and MCP. It cannot be renamed."
        />
      </div>
      <Choice
        label="Field type"
        value={value.type}
        onChange={(next) => patch("type", next as TableField["type"])}
        options={FIELD_TYPES}
      />
      <Toggle
        label="Required"
        selected={value.required}
        onChange={(next) => patch("required", next)}
        description="Required fields cannot contain null."
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
            error={error}
          />
        ))}
      {error && value.defaultMode !== "value" && (
        <p role="alert" className="settings-feedback-error">
          {error}
        </p>
      )}
    </Form>
  );
}

export function FieldsSettings(props: SettingsPanelProps) {
  const schema = useSchema(props);
  const mutation = useMutation(() => {
    schema.reload();
    props.onChanged?.();
  });
  const confirmation = useConfirmation();
  const [editing, setEditing] = useState<TableField>();
  const [preview, setPreview] = useState<{
    valid?: boolean;
    conflicts?: { message?: string; rowId?: string; fieldId?: string }[];
    requiresJob?: boolean;
    rowCount?: number;
    reportArtifactId?: string;
  }>();
  if (!schema.path) return <Empty>Select a table to manage fields.</Empty>;
  async function apply(input: Record<string, unknown>) {
    if (!editing) {
      const result = await mutation.run(
        () =>
          write(`${schema.path}/fields`, "POST", {
            field: input,
            expectedSchemaVersion: schema.data.table.schemaVersion,
          }),
        "Field creation committed or queued. Check the schema and Jobs for completion.",
      );
      if (result.ok) setEditing(undefined);
      return;
    }
    const changes = { ...input };
    delete changes.apiKey;
    const change = {
      kind: "update_field",
      fieldId: editing.id,
      changes,
      conversion: "explicit",
    };
    const check = await mutation.run(
      () =>
        write<NonNullable<typeof preview>>(
          `${schema.path}/schema/preview`,
          "POST",
          { expectedSchemaVersion: schema.data.table.schemaVersion, change },
        ),
      "Schema preview complete.",
    );
    if (!check.ok) return;
    setPreview(check.value);
    if (check.value.valid === false || check.value.conflicts?.length) return;
    if (
      await confirmation.confirm(
        "Apply this field change?",
        `${check.value.rowCount ?? "Existing"} rows will be checked. ${check.value.requiresJob ? "The table will enter read-only maintenance while the job runs." : "Rootset validates existing data before activating the change."}`,
        "Apply change",
      )
    ) {
      const result = await mutation.run(
        () =>
          write(`${schema.path}/fields/${editing.id}`, "PATCH", {
            field: input,
            conversion: "explicit",
            expectedSchemaVersion: schema.data.table.schemaVersion,
          }),
        "Field change committed or queued.",
      );
      if (result.ok) {
        setEditing(undefined);
        setPreview(undefined);
      }
    }
  }
  async function move(field: TableField, direction: number) {
    const ids = schema.data.fields.map((item) => item.id);
    const position = ids.indexOf(field.id);
    const next = position + direction;
    if (next < 0 || next >= ids.length) return;
    [ids[position], ids[next]] = [ids[next]!, ids[position]!];
    await mutation.run(
      () =>
        write(`${schema.path}/field-order`, "PUT", {
          fieldIds: ids,
          expectedSchemaVersion: schema.data.table.schemaVersion,
        }),
      "Field order updated.",
    );
  }
  return (
    <>
      <Loading {...schema} retry={schema.reload} />
      <Feedback {...mutation} />
      <Section
        title={editing ? `Edit ${editing.label}` : "Create field"}
        description="Every cell has a declared type. Constraints, defaults, row size, and existing values are checked before a schema change activates."
      >
        <FieldForm
          key={editing?.id ?? `new:${schema.data.table.schemaVersion}`}
          field={editing}
          busy={mutation.busy}
          submit={apply}
        />
        {editing && (
          <Button
            variant="ghost"
            onPress={() => {
              setEditing(undefined);
              setPreview(undefined);
            }}
          >
            Cancel editing
          </Button>
        )}
        {preview && (
          <div className="settings-preview">
            <p>
              {preview.valid === false
                ? "The change cannot activate."
                : preview.requiresJob
                  ? "This change requires a background job."
                  : "Preview completed."}
            </p>
            {preview.conflicts?.map((conflict, index) => (
              <p key={index}>
                {conflict.message ??
                  "Existing row violates the proposed field definition."}{" "}
                {conflict.rowId && <>Row: {conflict.rowId}</>}
              </p>
            ))}
            {preview.reportArtifactId && (
              <p>Conflict report artifact: {preview.reportArtifactId}</p>
            )}
          </div>
        )}
      </Section>
      <Section
        title="Existing fields"
        description={`${schema.data.fields.length} of 200 active fields · schema revision ${schema.data.table.schemaVersion}`}
      >
        <RecordList>
          {schema.data.fields.map((field, position) => (
            <Record
              key={field.id}
              title={field.label}
              description={
                <>
                  {field.apiKey} · {field.type} ·{" "}
                  {field.required ? "required" : "nullable"}
                  {field.charLimit && <> · {field.charLimit} characters</>}
                  {field.min !== undefined && <> · min {field.min}</>}
                  {field.max !== undefined && <> · max {field.max}</>}
                </>
              }
            >
              <Button
                variant="ghost"
                size="sm"
                isDisabled={mutation.busy || position === 0}
                onPress={() => move(field, -1)}
              >
                Move up
              </Button>
              <Button
                variant="ghost"
                size="sm"
                isDisabled={
                  mutation.busy || position === schema.data.fields.length - 1
                }
                onPress={() => move(field, 1)}
              >
                Move down
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onPress={() => {
                  setEditing(field);
                  setPreview(undefined);
                }}
              >
                Edit
              </Button>
              <Button
                variant="danger-soft"
                size="sm"
                isDisabled={mutation.busy}
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
                      `${field.label} will be removed from the active table. ${dependencies.length ? `${dependencies.length} dependent rules/indexes will also be removed. ` : ""}Its retained history remains interpretable.`,
                      "Remove field",
                    )
                  )
                    await mutation.run(
                      () =>
                        write(`${schema.path}/fields/${field.id}`, "DELETE", {
                          expectedSchemaVersion:
                            schema.data.table.schemaVersion,
                          removeDependencies: dependencies.length > 0,
                        }),
                      "Field removal committed or queued.",
                    );
                }}
              >
                Remove
              </Button>
            </Record>
          ))}
        </RecordList>
        {!schema.loading && !schema.error && !schema.data.fields.length && (
          <Empty>This table has no fields yet.</Empty>
        )}
      </Section>
      {confirmation.dialog}
    </>
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
      <Feedback {...mutation} />
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
                label: `${field.label} (${field.type})`,
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
                  schema.data.fields.find((field) => field.id === id)?.label ??
                  id
                }
              >
                <Button
                  size="sm"
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
                    schema.data.fields.find((field) => field.id === id)
                      ?.label ?? id,
                )
                .join(" + ")}
              description={
                <Status value={entry.state ?? entry.status ?? "unknown"} />
              }
            >
              <Button
                variant="danger-soft"
                size="sm"
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
