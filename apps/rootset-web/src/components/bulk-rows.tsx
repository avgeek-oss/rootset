"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { I18nProvider } from "react-aria-components";
import { Label, ListBox, Select } from "@heroui/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { ApiError, client } from "@rootset/web-client";
import type {
  BulkRowsInput,
  BulkRowsPreview,
  BulkRowsResult,
  FieldDefinition,
  Preferences,
  Row,
  TableSchemaResult,
} from "@rootset/contracts";
import {
  createRecordDraft,
  recordErrorFields,
  recordValues,
  type RecordDraft,
} from "../lib/record-draft";
import type { SelectedRecord } from "../lib/row-selection";
import { MutationAttempt } from "../lib/mutation-attempt";
import { RecordField } from "./record-field";
import { RecordForeignKey } from "./record-foreign-key";
import { FieldTypeIcon } from "./settings/field-type-options";
import { useConfirmation } from "./settings/ui";
import { formatCellValue } from "./cells";
import "./record-editor.css";

interface Props {
  target: { orgId: string; databaseId: string; tableId: string };
  tableName: string;
  selected: SelectedRecord[];
  action: BulkRowsInput["action"]["type"];
  preferences: Preferences;
  canEdit: boolean;
  onClose(): void;
  onApplied(result: BulkRowsResult): void;
  onSelectionReload(records: SelectedRecord[]): void;
  onAccessLost(): void;
}
function bulkDraft(fields: FieldDefinition[], timeZone: string): RecordDraft {
  return Object.fromEntries(
    Object.entries(createRecordDraft(fields, undefined, timeZone)).map(
      ([id, draft]) => [
        id,
        { ...draft, mode: draft.mode === "default" ? "value" : draft.mode },
      ],
    ),
  );
}
export function BulkRows(props: Props) {
  const schema = useQuery({
    queryKey: ["bulk-rows-schema", props.target.tableId],
    queryFn: ({ signal }) =>
      client.operation<TableSchemaResult>(
        "getTableSchema",
        { ...props.target },
        { signal },
      ),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [busy, setBusy] = useState<"preview" | "apply" | "reload" | null>(null);
  const [dirty, setDirty] = useState(false);
  const pending = useRef(false),
    closing = useRef(false);
  const stop = useRef<AbortController | null>(null);
  const confirmation = useConfirmation();
  useEffect(() => () => stop.current?.abort(), []);
  useEffect(() => {
    if (
      schema.error instanceof ApiError &&
      [401, 403, 404].includes(schema.error.status)
    )
      props.onAccessLost();
  }, [schema.error, props.onAccessLost]);
  async function close() {
    if (pending.current || closing.current) return;
    closing.current = true;
    try {
      if (
        !dirty ||
        (await confirmation.confirm(
          "Discard bulk changes?",
          "The values you entered and this preview will be discarded.",
          "Discard changes",
        ))
      )
        props.onClose();
    } finally {
      closing.current = false;
    }
  }
  const heading =
    props.action === "set"
      ? "Set field values"
      : props.action === "duplicate"
        ? "Duplicate records"
        : "Delete records";
  return (
    <>
      <Drawer
        isOpen
        onOpenChange={(open) => {
          if (!open) void close();
        }}
      >
        <Drawer.Backdrop
          isDismissable={false}
          isKeyboardDismissDisabled={Boolean(busy)}
        >
          <Drawer.Content placement="right">
            <Drawer.Dialog className="record-editor-drawer">
              <Drawer.Header className="record-editor-header">
                <div>
                  <Drawer.Heading>{heading}</Drawer.Heading>
                  <p className="text-sm text-muted">{props.tableName}</p>
                </div>
                <Drawer.CloseTrigger
                  aria-label="Close bulk action"
                  isDisabled={Boolean(busy)}
                />
              </Drawer.Header>
              {schema.isPending ? (
                <Drawer.Body className="record-editor-body">
                  <p role="status">Loading fields…</p>
                </Drawer.Body>
              ) : schema.isError && !schema.data ? (
                <Drawer.Body className="record-editor-body">
                  <p role="alert">{schema.error.message}</p>
                  <Button
                    variant="secondary"
                    onPress={() => void schema.refetch()}
                  >
                    Retry loading fields
                  </Button>
                </Drawer.Body>
              ) : schema.data ? (
                <I18nProvider locale={props.preferences.locale}>
                  <BulkForm
                    {...props}
                    schema={schema.data}
                    busy={busy}
                    onBusy={(value) => {
                      pending.current = Boolean(value);
                      setBusy(value);
                    }}
                    onDirty={setDirty}
                    onRequestClose={() => void close()}
                    onReloadSchema={async () => {
                      const result = await schema.refetch();
                      if (result.error) throw result.error;
                      return result.data!;
                    }}
                    stop={stop}
                  />
                </I18nProvider>
              ) : null}
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
      {confirmation.dialog}
    </>
  );
}
function BulkForm(
  props: Props & {
    schema: TableSchemaResult;
    busy: "preview" | "apply" | "reload" | null;
    onBusy(value: "preview" | "apply" | "reload" | null): void;
    onDirty(value: boolean): void;
    onRequestClose(): void;
    onReloadSchema(): Promise<TableSchemaResult>;
    stop: React.RefObject<AbortController | null>;
  },
) {
  const [records, setRecords] = useState(props.selected);
  const [fieldId, setFieldId] = useState(
    () =>
      props.schema.fields.find(
        (field) => !(field.type === "integer" && field.autoIncrement),
      )?.id ??
      props.schema.fields[0]?.id ??
      "",
  );
  const [initialDrafts] = useState(() =>
    bulkDraft(props.schema.fields, props.preferences.timezone),
  );
  const [drafts, setDrafts] = useState(initialDrafts);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<BulkRowsPreview | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [status, setStatus] = useState("");
  const lock = useRef(false),
    attempt = useRef(new MutationAttempt());
  const form = useRef<HTMLFormElement>(null),
    focusAfterBusy = useRef<string | null>(null);
  const previewInput = useRef<BulkRowsInput | null>(null);
  const statusElement = useRef<HTMLParagraphElement>(null);
  const focusStatus = useRef(false);
  const field = props.schema.fields.find((field) => field.id === fieldId);
  const rule = props.schema.foreignKeys.find((rule) =>
    rule.fieldIds.includes(fieldId),
  );
  const fields = rule
    ? props.schema.fields.filter((field) => rule.fieldIds.includes(field.id))
    : field
      ? [field]
      : [];
  const dirty =
    props.action === "set" &&
    JSON.stringify(initialDrafts) !== JSON.stringify(drafts);
  useEffect(() => props.onDirty(dirty), [dirty, props.onDirty]);
  useEffect(() => {
    if (!props.busy && focusAfterBusy.current) {
      focusField(focusAfterBusy.current);
      focusAfterBusy.current = null;
    }
  }, [props.busy, errors]);
  useEffect(() => {
    if (!props.busy && focusStatus.current) {
      focusStatus.current = false;
      statusElement.current?.focus();
    }
  }, [props.busy, status]);
  function focusField(id: string) {
    if (id === "$submit" || id === "$reload") {
      form.current
        ?.querySelector<HTMLElement>(
          id === "$reload" ? "[data-reload-records]" : 'button[type="submit"]',
        )
        ?.focus();
      return;
    }
    const first =
      props.schema.foreignKeys.find((rule) => rule.fieldIds.includes(id))
        ?.fieldIds[0] ?? id;
    const target =
      form.current?.querySelector<HTMLElement>(
        `[data-field-id="${first}"] :is(input,textarea,[role="spinbutton"],[data-slot="select-trigger"])`,
      ) ??
      form.current?.querySelector<HTMLElement>("[data-field-select] button");
    target?.focus();
  }
  function invalidate() {
    setPreview(null);
    previewInput.current = null;
    setStatus("");
  }
  function change(patch: RecordDraft) {
    setDrafts((current) => ({ ...current, ...patch }));
    setErrors({});
    invalidate();
  }
  function payload(): BulkRowsInput | null {
    if (props.action !== "set")
      return {
        expectedSchemaVersion: props.schema.table.schemaVersion,
        rows: records,
        action: { type: props.action },
      };
    if (!fields.length) {
      toast.danger("Choose a field that still exists in this table.");
      form.current
        ?.querySelector<HTMLElement>("[data-field-select] button")
        ?.focus();
      return null;
    }
    const result = recordValues(
      fields,
      Object.fromEntries(
        fields.map((field) => [
          field.id,
          drafts[field.id] ??
            bulkDraft([field], props.preferences.timezone)[field.id]!,
        ]),
      ),
      undefined,
      props.preferences.timezone,
    );
    const invalid = Object.keys(result.errors)[0];
    if (invalid) {
      setErrors(result.errors);
      toast.danger(result.errors[invalid]!);
      focusField(invalid);
      return null;
    }
    return {
      expectedSchemaVersion: props.schema.table.schemaVersion,
      rows: records,
      action: { type: "set", values: result.values },
    };
  }
  function failure(error: unknown) {
    focusAfterBusy.current = "$submit";
    if (error instanceof ApiError) {
      const ids = recordErrorFields(error.details, props.schema);
      if (ids.length) {
        setErrors(Object.fromEntries(ids.map((id) => [id, error.message])));
        focusAfterBusy.current = ids[0]!;
      }
      if ([401, 403].includes(error.status)) props.onAccessLost();
      if (
        [
          "ROW_VERSION_CONFLICT",
          "SCHEMA_VERSION_CONFLICT",
          "SCHEMA_MAINTENANCE",
          "RESOURCE_NOT_FOUND",
        ].includes(error.code)
      ) {
        setNeedsReload(true);
        focusAfterBusy.current = "$reload";
      }
    }
    toast.danger(
      error instanceof Error
        ? error.message
        : "The bulk action could not be completed.",
    );
  }
  async function prepare() {
    if (lock.current || !records.length || !props.canEdit || needsReload)
      return;
    let input: BulkRowsInput | null;
    try {
      input = payload();
    } catch (error) {
      failure(error);
      return;
    }
    if (!input) return;
    lock.current = true;
    props.onBusy("preview");
    setPreview(null);
    setStatus("");
    const controller = new AbortController();
    props.stop.current = controller;
    try {
      const result = await client.operation<BulkRowsPreview>(
        "previewBulkRows",
        { ...props.target, ...input },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setPreview(result);
      previewInput.current = input;
      if (
        result.issues.some((issue) =>
          ["ROW_VERSION_CONFLICT", "RESOURCE_NOT_FOUND"].includes(issue.code),
        )
      )
        setNeedsReload(true);
      focusStatus.current = true;
      setStatus(
        result.issues.length
          ? `${result.issues.length} ${result.issues.length === 1 ? "record has a conflict" : "records have conflicts"}. No records have been changed.`
          : `Preview ready for ${result.total} ${result.total === 1 ? "record" : "records"}. No records have been changed.`,
      );
    } catch (error) {
      if (!controller.signal.aborted) failure(error);
      else {
        focusStatus.current = true;
        setStatus("Preview canceled. No records have been changed.");
      }
    } finally {
      props.stop.current = null;
      lock.current = false;
      props.onBusy(null);
    }
  }
  async function apply() {
    if (
      lock.current ||
      !props.canEdit ||
      needsReload ||
      !preview ||
      preview.issues.length ||
      !previewInput.current
    )
      return;
    lock.current = true;
    props.onBusy("apply");
    const input = { ...props.target, ...previewInput.current };
    try {
      const result = await client.operation<BulkRowsResult>("bulkRows", input, {
        idempotencyKey: attempt.current.forInput(input),
      });
      attempt.current.clear();
      props.onApplied(result);
      toast.success(
        `${result.action === "duplicate" ? "Duplicated" : result.action === "delete" ? "Deleted" : "Updated"} ${result.affected.toLocaleString(props.preferences.locale)} ${result.affected === 1 ? "record" : "records"}`,
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      )
        invalidate();
      else setStatus("");
      failure(error);
    } finally {
      lock.current = false;
      props.onBusy(null);
    }
  }
  async function reload() {
    if (lock.current) return;
    lock.current = true;
    props.onBusy("reload");
    invalidate();
    try {
      await props.onReloadSchema();
      const next: SelectedRecord[] = [];
      for (let offset = 0; offset < records.length; offset += 4) {
        const results = await Promise.allSettled(
          records.slice(offset, offset + 4).map((record) =>
            client.operation<Row>("getRow", {
              ...props.target,
              rowId: record.rowId,
            }),
          ),
        );
        for (const result of results) {
          if (result.status === "fulfilled")
            next.push({
              rowId: result.value.id,
              expectedVersion: result.value.version,
            });
          else if (!(
            result.reason instanceof ApiError && result.reason.status === 404
          ))
            throw result.reason;
        }
      }
      setRecords(next);
      props.onSelectionReload(next);
      setNeedsReload(false);
      setErrors({});
      invalidate();
      setStatus(
        next.length
          ? "Selected records reloaded. Your entered values are kept. Preview again before applying."
          : "These records no longer exist. Close this panel and select records again.",
      );
    } catch (error) {
      failure(error);
    } finally {
      lock.current = false;
      props.onBusy(null);
    }
  }
  return (
    <form
      ref={form}
      className="record-editor-form"
      noValidate
      aria-label="Bulk records"
      aria-busy={Boolean(props.busy)}
      onSubmit={(event) => {
        event.preventDefault();
        void (preview && !preview.issues.length ? apply() : prepare());
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          if (event.repeat) return;
          void (preview && !preview.issues.length ? apply() : prepare());
        }
      }}
    >
      <Drawer.Body className="record-editor-body">
        <p className="tabular-nums">
          {records.length.toLocaleString(props.preferences.locale)}{" "}
          {records.length === 1 ? "record selected" : "records selected"}.
        </p>
        {props.action === "set" ? (
          <>
            <Select
              data-field-select
              variant="secondary"
              value={fieldId || null}
              isDisabled={Boolean(props.busy)}
              onChange={(id) => {
                if (typeof id === "string") {
                  setFieldId(id);
                  setErrors({});
                  invalidate();
                }
              }}
            >
              <Label>Field</Label>
              <Select.Trigger>
                <Select.Value>
                  {field && (
                    <span className="flex min-w-0 items-center gap-2">
                      <FieldTypeIcon type={field.type} />
                      <span className="truncate">{field.name}</span>
                    </span>
                  )}
                </Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {props.schema.fields.map((field) => (
                    <ListBox.Item
                      key={field.id}
                      id={field.id}
                      textValue={field.name}
                    >
                      <FieldTypeIcon type={field.type} />
                      {field.name}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            {rule ? (
              <RecordForeignKey
                key={rule.id}
                target={props.target}
                rule={rule}
                fields={props.schema.fields}
                drafts={{
                  ...bulkDraft(props.schema.fields, props.preferences.timezone),
                  ...drafts,
                }}
                preferences={props.preferences}
                errors={errors}
                disabled={Boolean(props.busy)}
                readOnly={!props.canEdit}
                creating={false}
                onChange={change}
              />
            ) : (
              field && (
                <RecordField
                  key={field.id}
                  field={field}
                  label="New value"
                  draft={
                    drafts[field.id] ??
                    bulkDraft([field], props.preferences.timezone)[field.id]!
                  }
                  creating={false}
                  timeZone={props.preferences.timezone}
                  hourCycle={
                    props.preferences.timeFormat.startsWith("12-hour") ? 12 : 24
                  }
                  invalid={Boolean(errors[field.id])}
                  disabled={Boolean(props.busy)}
                  readOnly={!props.canEdit}
                  onChange={(draft) => change({ [field.id]: draft })}
                />
              )
            )}
          </>
        ) : (
          <p className="text-sm text-muted">
            {props.action === "duplicate"
              ? "Copy the selected records into new records. Automatic IDs will be generated again. Existing unique rules still apply."
              : "Delete the selected records and their history and comments. This cannot be undone."}
          </p>
        )}
        {!props.canEdit && (
          <p role="status" className="text-sm text-muted">
            You no longer have permission to change these records.
          </p>
        )}
        {props.schema.table.state !== "active" && (
          <p role="status" className="text-sm text-muted">
            This table is in maintenance. Reload records after maintenance
            finishes.
          </p>
        )}
        {status && (
          <p
            ref={statusElement}
            tabIndex={-1}
            role="status"
            className="text-sm text-muted"
          >
            {status}
          </p>
        )}
        {preview && (
          <BulkPreview
            preview={preview}
            fields={props.action === "set" ? fields : props.schema.fields}
            records={records}
            schema={props.schema}
            preferences={props.preferences}
          />
        )}
      </Drawer.Body>
      <Drawer.Footer className="record-editor-footer">
        {(needsReload || props.schema.table.state !== "active") && (
          <Button
            variant="secondary"
            isDisabled={Boolean(props.busy)}
            data-reload-records
            onPress={() => void reload()}
          >
            Reload records
          </Button>
        )}
        {props.busy === "preview" ? (
          <Button
            variant="secondary"
            onPress={() => props.stop.current?.abort()}
          >
            Stop preview
          </Button>
        ) : (
          <Button
            variant="secondary"
            isDisabled={Boolean(props.busy)}
            onPress={props.onRequestClose}
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant={
            preview && !preview.issues.length && props.action === "delete"
              ? "danger"
              : "primary"
          }
          isPending={Boolean(props.busy)}
          isDisabled={
            Boolean(props.busy) ||
            needsReload ||
            !records.length ||
            !props.canEdit ||
            props.schema.table.state !== "active"
          }
        >
          {props.busy === "reload"
            ? "Reloading…"
            : preview && !preview.issues.length
              ? `${props.action === "delete" ? "Delete" : props.action === "duplicate" ? "Duplicate" : "Update"} ${records.length.toLocaleString(props.preferences.locale)} ${records.length === 1 ? "record" : "records"}`
              : "Preview changes"}
        </Button>
      </Drawer.Footer>
    </form>
  );
}
function BulkPreview({
  preview,
  fields,
  preferences,
  records,
  schema,
}: {
  schema: TableSchemaResult;
  records: SelectedRecord[];
  preview: BulkRowsPreview;
  fields: FieldDefinition[];
  preferences: Preferences;
}) {
  const format = (
    field: FieldDefinition,
    value: Row["values"][string] | undefined,
  ) => (
    <span className="block max-w-56 truncate">
      {formatCellValue(field, value ?? null, {
        timeZone: preferences.timezone,
        locale: preferences.locale,
        dateFormat: preferences.dateFormat,
        timeFormat: preferences.timeFormat,
      })}
    </span>
  );
  const recordIndex = new Map(records.map((row, index) => [row.rowId, index]));
  const patchRows = preview.sample.flatMap((row) =>
    fields.map((field) => ({
      id: `${row.rowId}:${field.id}`,
      row,
      field,
      index: recordIndex.get(row.rowId)!,
    })),
  );
  return (
    <div className="min-w-0 space-y-4">
      {preview.issues.length > 0 && (
        <ResourceTable
          ariaLabel="Bulk action conflicts"
          items={preview.issues}
          getRowKey={(issue) => issue.rowId}
          tableClassName="min-w-md"
          emptyTitle="No conflicts"
          emptyDescription=""
          columns={[
            {
              key: "record",
              header: "Record",
              cell: (issue) => (
                <div>
                  <span className="tabular-nums">
                    Selection {issue.index + 1}
                  </span>
                  <code className="block max-w-28 truncate text-xs">
                    {issue.rowId}
                  </code>
                </div>
              ),
            },
            {
              key: "field",
              header: "Field",
              cell: (issue) =>
                recordErrorFields(issue, schema)
                  .map(
                    (id) =>
                      schema.fields.find((field) => field.id === id)?.name,
                  )
                  .filter(Boolean)
                  .join(", ") || "—",
            },
            {
              key: "message",
              header: "Conflict",
              cell: (issue) => {
                const names = recordErrorFields(issue, schema)
                  .map(
                    (id) =>
                      schema.fields.find((field) => field.id === id)?.name,
                  )
                  .filter(Boolean);
                const message =
                  issue.code === "UNIQUE_CONFLICT" && names.length
                    ? names.length === 1
                      ? `This ${names[0]} value would duplicate another record.`
                      : `This combination of ${names.join(", ")} already exists.`
                    : issue.message;
                return <span className="block max-w-sm">{message}</span>;
              },
            },
          ]}
        />
      )}
      <p className="text-sm text-muted tabular-nums">
        Showing {preview.sample.length} of {preview.total} selected records.{" "}
        {preview.valid} {preview.valid === 1 ? "record passes" : "records pass"}{" "}
        validation.{" "}
        {preview.issues.length > 0
          ? "Resolve conflicts and preview again before applying."
          : "Review the values before applying."}
      </p>
      {preview.action === "set" ? (
        <ResourceTable
          ariaLabel="Bulk value preview"
          items={patchRows}
          getRowKey={(item) => item.id}
          tableClassName="min-w-md"
          emptyTitle="No records to preview"
          emptyDescription="Resolve the conflicts above and preview again."
          columns={[
            {
              key: "record",
              header: "Record",
              cell: (item) => (
                <div>
                  <span className="tabular-nums">
                    Selection {item.index + 1}
                  </span>
                  <code className="block max-w-28 truncate text-xs">
                    {item.row.rowId}
                  </code>
                </div>
              ),
            },
            { key: "field", header: "Field", cell: (item) => item.field.name },
            {
              key: "before",
              header: "Current value",
              cell: (item) =>
                format(item.field, item.row.before[item.field.name]!),
            },
            {
              key: "after",
              header: "New value",
              cell: (item) =>
                format(item.field, item.row.after?.[item.field.name]),
            },
          ]}
        />
      ) : (
        <ResourceTable
          ariaLabel="Selected record preview"
          items={preview.sample}
          getRowKey={(row) => row.rowId}
          tableClassName="min-w-md"
          emptyTitle="No records to preview"
          emptyDescription="Resolve the conflicts above and preview again."
          columns={[
            {
              key: "record",
              header: "Record",
              cell: (row) => (
                <div>
                  <span className="tabular-nums">
                    Selection {recordIndex.get(row.rowId)! + 1}
                  </span>
                  <code className="block max-w-28 truncate text-xs">
                    {row.rowId}
                  </code>
                </div>
              ),
            } as ResourceTableColumn<BulkRowsPreview["sample"][number]>,
            ...fields.map(
              (
                field,
              ): ResourceTableColumn<BulkRowsPreview["sample"][number]> => ({
                key: field.id,
                header: field.name,
                cell: (row) =>
                  preview.action === "duplicate" && field.autoIncrement ? (
                    <span className="text-muted italic">Generated</span>
                  ) : (
                    format(field, (row.after ?? row.before)[field.name]!)
                  ),
              }),
            ),
          ]}
        />
      )}
    </div>
  );
}
