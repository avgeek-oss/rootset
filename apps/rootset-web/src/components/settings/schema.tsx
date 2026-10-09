"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { useEffect, useState } from "react";
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
      <Feedback {...mutation} />
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
        <p role="status" className="settings-feedback">
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
      <Feedback {...mutation} />
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
}: {
  field?: TableField;
  busy: boolean;
  submit: (input: Record<string, unknown>) => Promise<void>;
}) {
  const [value, setValue] = useState(() => fieldDraft(field));
  const [errors, setErrors] = useState<FieldDraftErrors>({});
  const [error, setError] = useState<string>();
  function patch<K extends keyof FieldDraft>(key: K, next: FieldDraft[K]) {
    const updated = { ...value, [key]: next };
    setValue(updated);
    if (Object.keys(errors).length) {
      const nextErrors = parseFieldDraft(updated).errors ?? {};
      setErrors(
        Object.fromEntries(
          Object.keys(errors).map((field) => [
            field,
            nextErrors[field as keyof FieldDraft],
          ]),
        ),
      );
    }
  }
  function validate(...keys: (keyof FieldDraft)[]) {
    const nextErrors = parseFieldDraft(value).errors ?? {};
    setErrors((previous) => ({
      ...previous,
      ...Object.fromEntries(keys.map((key) => [key, nextErrors[key]])),
    }));
  }
  return (
    <Form
      busy={busy}
      submit={field ? "Preview and apply changes" : "Create field"}
      onSubmit={async () => {
        setError(undefined);
        const parsed = parseFieldDraft(value);
        setErrors(parsed.errors ?? {});
        if (!parsed.input) return;
        try {
          await submit(parsed.input);
        } catch (reason) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Check the field definition.",
          );
        }
      }}
    >
      <Field
        label="Name"
        value={value.name}
        onChange={(next) => patch("name", next)}
        onBlur={() => validate("name")}
        required
        minLength={1}
        maxLength={64}
        pattern="[A-Za-z_]+"
        description="Use 1–64 letters or underscores. Reserved system names are unavailable. This name is the column label and the key used by API requests."
        error={errors.name}
      />
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
          error={errors.charLimit}
          label="Maximum characters"
          type="number"
          value={value.charLimit}
          onChange={(next) => patch("charLimit", next)}
          onBlur={() => validate("charLimit")}
          min={1}
          max={65536}
          required
        />
      )}
      {["integer", "float", "date", "date-time"].includes(value.type) && (
        <div className="settings-inline">
          <Field
            error={errors.min}
            label="Minimum (inclusive)"
            value={value.min}
            onChange={(next) => patch("min", next)}
            onBlur={() => validate("min", "max")}
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
            error={errors.max}
            label="Maximum (inclusive)"
            value={value.max}
            onChange={(next) => patch("max", next)}
            onBlur={() => validate("min", "max")}
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
        error={errors.defaultMode}
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
            onBlur={() => validate("defaultValue")}
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
            error={errors.defaultValue}
          />
        ))}
      {errors.defaultValue && value.type === "boolean" && (
        <p role="alert" className="settings-feedback-error">
          {errors.defaultValue}
        </p>
      )}
      {error && (
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
        title={editing ? `Edit ${editing.name}` : "Create field"}
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
              title={field.name}
              description={
                <>
                  {field.type} · {field.required ? "required" : "nullable"}
                  {field.charLimit && <> · {field.charLimit} characters</>}
                  {field.min !== undefined && <> · min {field.min}</>}
                  {field.max !== undefined && <> · max {field.max}</>}
                </>
              }
            >
              <Button
                variant="ghost"

                isDisabled={mutation.busy || position === 0}
                onPress={() => move(field, -1)}
              >
                Move up
              </Button>
              <Button
                variant="ghost"

                isDisabled={
                  mutation.busy || position === schema.data.fields.length - 1
                }
                onPress={() => move(field, 1)}
              >
                Move down
              </Button>
              <Button
                variant="secondary"

                onPress={() => {
                  setEditing(field);
                  setPreview(undefined);
                }}
              >
                Edit
              </Button>
              <Button
                variant="danger-soft"

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
                      `${field.name} will be removed from the active table. ${dependencies.length ? `${dependencies.length} dependent rules/indexes will also be removed. ` : ""}Its cell changelogs are permanently removed.`,
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
