"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { I18nProvider } from "react-aria-components";
import { Label, ListBox, Select } from "@heroui/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { ApiError, client } from "@rootset/web-client";
import type {
  BulkRowsInput,
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
import { RefreshCw, Trash2, Copy, Pencil } from "./ui/icons";
import "./record-editor.css";

interface Props {
  target: { orgId: string; databaseId: string; tableId: string };
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
  const [records, setRecords] = useState(props.selected);
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
  const [busy, setBusy] = useState<"apply" | "reload" | null>(null);
  const [dirty, setDirty] = useState(false);
  const pending = useRef(false),
    closing = useRef(false);
  const confirmation = useConfirmation();
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
          "The field values you entered will be discarded.",
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
        : "Delete records?";
  const deleting = props.action === "delete";
  const Header = deleting ? Modal.Header : Drawer.Header;
  const Heading = deleting ? Modal.Heading : Drawer.Heading;
  const CloseTrigger = deleting ? Modal.CloseTrigger : Drawer.CloseTrigger;
  const Body = deleting ? Modal.Body : Drawer.Body;
  const content = (
    <>
      <Header className={deleting ? "mb-4" : "record-editor-header"}>
        <div>
          <Heading>{heading}</Heading>
          <p className="text-sm text-muted tabular-nums">
            {records.length.toLocaleString(props.preferences.locale)}{" "}
            {records.length === 1 ? "record selected" : "records selected"}
          </p>
        </div>
        <CloseTrigger
          aria-label="Close bulk action"
          isDisabled={Boolean(busy)}
        />
      </Header>
      {schema.isPending ? (
        <Body className={deleting ? undefined : "record-editor-body"}>
          <p role="status">Loading fields…</p>
        </Body>
      ) : schema.isError && !schema.data ? (
        <Body className={deleting ? "space-y-4" : "record-editor-body"}>
          <p role="alert">{schema.error.message}</p>
          <Button variant="secondary" onPress={() => void schema.refetch()}>
            <RefreshCw />
            Retry loading fields
          </Button>
        </Body>
      ) : schema.data ? (
        <I18nProvider locale={props.preferences.locale}>
          <BulkForm
            {...props}
            selected={records}
            onSelectionReload={(next) => {
              setRecords(next);
              props.onSelectionReload(next);
            }}
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
          />
        </I18nProvider>
      ) : null}
    </>
  );
  return (
    <>
      {deleting ? (
        <Modal
          isOpen
          onOpenChange={(open) => {
            if (!open) void close();
          }}
        >
          <Modal.Backdrop
            isDismissable={false}
            isKeyboardDismissDisabled={Boolean(busy)}
          >
            <Modal.Container placement="center">
              <Modal.Dialog role="alertdialog">{content}</Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : (
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
                {content}
              </Drawer.Dialog>
            </Drawer.Content>
          </Drawer.Backdrop>
        </Drawer>
      )}
      {confirmation.dialog}
    </>
  );
}
function BulkForm(
  props: Props & {
    schema: TableSchemaResult;
    busy: "apply" | "reload" | null;
    onBusy(value: "apply" | "reload" | null): void;
    onDirty(value: boolean): void;
    onRequestClose(): void;
    onReloadSchema(): Promise<TableSchemaResult>;
  },
) {
  const records = props.selected;
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
  const [needsReload, setNeedsReload] = useState(false);
  const [status, setStatus] = useState("");
  const lock = useRef(false),
    attempt = useRef(new MutationAttempt());
  const form = useRef<HTMLFormElement>(null),
    focusAfterBusy = useRef<string | null>(null);
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
        `[data-field-id="${first}"] :is(input,textarea,[contenteditable="true"][role="textbox"],[role="spinbutton"],[data-slot="select-trigger"])`,
      ) ??
      form.current?.querySelector<HTMLElement>("[data-field-select] button");
    target?.focus();
  }
  function change(patch: RecordDraft) {
    setDrafts((current) => ({ ...current, ...patch }));
    setErrors({});
    setStatus("");
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
  async function apply() {
    if (
      lock.current ||
      !props.canEdit ||
      needsReload ||
      !records.length ||
      props.schema.table.state !== "active"
    )
      return;
    let actionInput: BulkRowsInput | null;
    try {
      actionInput = payload();
    } catch (error) {
      failure(error);
      return;
    }
    if (!actionInput) return;
    lock.current = true;
    props.onBusy("apply");
    const input = { ...props.target, ...actionInput };
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
      setStatus("");
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
    setStatus("");
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
      props.onSelectionReload(next);
      setNeedsReload(false);
      setErrors({});
      focusAfterBusy.current = "$submit";
      setStatus(
        next.length
          ? props.action === "duplicate"
            ? "Selected records reloaded. You can duplicate them now."
            : props.action === "set"
              ? "Selected records reloaded. Your entered values are kept. You can update them now."
              : "Selected records reloaded. Confirm deletion to delete them."
          : "These records no longer exist. Close this dialog and select records again.",
      );
    } catch (error) {
      failure(error);
    } finally {
      lock.current = false;
      props.onBusy(null);
    }
  }
  const deleting = props.action === "delete";
  const Body = deleting ? Modal.Body : Drawer.Body;
  const Footer = deleting ? Modal.Footer : Drawer.Footer;
  return (
    <form
      ref={form}
      className="record-editor-form"
      noValidate
      aria-label="Bulk records"
      aria-busy={Boolean(props.busy)}
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
      onKeyDownCapture={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat) return;
          void apply();
        }
      }}
    >
      <Body className={deleting ? "space-y-4" : "record-editor-body"}>
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
                  setStatus("");
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
        ) : props.action === "duplicate" ? (
          <ul className="list-disc space-y-2 pl-5 text-sm text-muted">
            <li>
              Each selected record creates a new record in this table. Your
              original records stay unchanged.
            </li>
            <li>
              Field values and foreign key links are copied. Auto-increment
              fields receive newly generated values.
            </li>
            <li>Comments and cell history are not copied.</li>
            <li>
              Every copy must pass field validation, foreign key checks and
              unique rules. A copied unique value can prevent duplication.
            </li>
            <li>
              Choose Duplicate to create the copies. If any copy fails
              validation, none are saved.
            </li>
          </ul>
        ) : (
          <p className="text-sm text-muted">
            Delete the selected records and their history and comments. This
            cannot be undone.
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
          <p role="status" className="text-sm text-muted">
            {status}
          </p>
        )}
      </Body>
      <Footer className={deleting ? "mt-5" : "record-editor-footer"}>
        {(needsReload || props.schema.table.state !== "active") && (
          <Button
            variant="secondary"
            isDisabled={Boolean(props.busy)}
            data-reload-records
            onPress={() => void reload()}
          >
            <RefreshCw />
            Reload records
          </Button>
        )}
        <Button
          variant="secondary"
          autoFocus={deleting}
          isDisabled={Boolean(props.busy)}
          onPress={props.onRequestClose}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant={deleting ? "danger" : "primary"}
          isPending={Boolean(props.busy)}
          isDisabled={
            Boolean(props.busy) ||
            needsReload ||
            !records.length ||
            !props.canEdit ||
            props.schema.table.state !== "active"
          }
        >
          {deleting ? (
            <Trash2 />
          ) : props.action === "duplicate" ? (
            <Copy />
          ) : (
            <Pencil />
          )}
          {props.busy === "reload"
            ? "Reloading…"
            : `${deleting ? "Delete" : props.action === "duplicate" ? "Duplicate" : "Update"} ${records.length.toLocaleString(props.preferences.locale)} ${records.length === 1 ? "record" : "records"}`}
        </Button>
      </Footer>
    </form>
  );
}
