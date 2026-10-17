"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { I18nProvider } from "react-aria-components";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { ApiError, client } from "@rootset/web-client";
import type { Preferences, Row, TableSchemaResult } from "@rootset/contracts";
import {
  createRecordDraft,
  recordValues,
  recordErrorFields,
  type RecordFieldDraft,
  type RecordDraft,
} from "../lib/record-draft";
import { MutationAttempt } from "../lib/mutation-attempt";
import { RecordField } from "./record-field";
import { RecordForeignKey } from "./record-foreign-key";
import { useConfirmation } from "./settings/ui";
import { RefreshCw, Save, Plus } from "./ui/icons";
import "./record-editor.css";

interface RecordTarget {
  orgId: string;
  databaseId: string;
  tableId: string;
}
interface RecordEditorProps {
  target: RecordTarget;
  tableName: string;
  rowId?: string;
  focusFieldId?: string;
  preferences: Preferences;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (row: Row, created: boolean) => void;
  onAccessLost: () => void;
}

export function RecordEditor(props: RecordEditorProps) {
  const confirmation = useConfirmation();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const closing = useRef(false);
  const setPending = useCallback((value: boolean) => {
    pending.current = value;
    setBusy(value);
  }, []);
  const record = useQuery({
    queryKey: ["record-editor", props.target.tableId, props.rowId ?? "new"],
    queryFn: async ({ signal }) => {
      const [schema, row] = await Promise.all([
        client.operation<TableSchemaResult>(
          "getTableSchema",
          { ...props.target },
          {
            signal,
          },
        ),
        props.rowId
          ? client.operation<Row>(
              "getRow",
              { ...props.target, rowId: props.rowId },
              { signal },
            )
          : Promise.resolve(undefined),
      ]);
      return { schema, row };
    },
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  async function close() {
    if (pending.current || closing.current) return;
    closing.current = true;
    try {
      if (
        !dirty ||
        (await confirmation.confirm(
          "Discard record changes?",
          "Your unsaved changes will be discarded.",
          "Discard changes",
        ))
      )
        props.onClose();
    } finally {
      closing.current = false;
    }
  }
  async function reload() {
    if (pending.current || record.isFetching) return;
    if (
      dirty &&
      !(await confirmation.confirm(
        "Reload record?",
        "Replace your unsaved changes with the latest saved record and field definitions.",
        "Reload record",
      ))
    )
      return;
    const result = await record.refetch();
    if (result.isError) toast.danger(result.error.message);
  }
  return (
    <>
      <Drawer
        isOpen
        onOpenChange={(open) => {
          if (!open) void close();
        }}
      >
        <Drawer.Backdrop isDismissable={false} isKeyboardDismissDisabled={busy}>
          <Drawer.Content placement="right">
            <Drawer.Dialog className="record-editor-drawer">
              <Drawer.Header className="record-editor-header">
                <div>
                  <Drawer.Heading>
                    {props.rowId
                      ? props.canEdit
                        ? "Edit record"
                        : "Record"
                      : "Add record"}
                  </Drawer.Heading>
                  <p className="text-sm text-muted">{props.tableName}</p>
                </div>
                <Drawer.CloseTrigger
                  aria-label="Close record"
                  isDisabled={busy}
                />
              </Drawer.Header>
              {record.isPending ? (
                <Drawer.Body className="record-editor-body">
                  <p role="status" className="text-muted">
                    Loading record…
                  </p>
                </Drawer.Body>
              ) : record.isError && !record.data ? (
                <Drawer.Body className="record-editor-body">
                  <p role="alert">{record.error.message}</p>
                  <Button
                    variant="secondary"
                    onPress={() => void record.refetch()}
                  >
                    <RefreshCw />
                    Retry loading record
                  </Button>
                </Drawer.Body>
              ) : record.data ? (
                <I18nProvider locale={props.preferences.locale}>
                  <RecordForm
                    key={record.dataUpdatedAt}
                    {...props}
                    schema={record.data.schema}
                    row={record.data.row}
                    busy={busy}
                    reloading={record.isFetching}
                    onPendingChange={setPending}
                    onDirtyChange={setDirty}
                    onRequestClose={() => void close()}
                    onReload={() => void reload()}
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

function RecordForm({
  target,
  schema,
  row,
  preferences,
  canEdit,
  focusFieldId,
  busy,
  reloading,
  onClose,
  onSaved,
  onAccessLost,
  onPendingChange,
  onDirtyChange,
  onRequestClose,
  onReload,
}: RecordEditorProps & {
  schema: TableSchemaResult;
  row?: Row;
  busy: boolean;
  reloading: boolean;
  onPendingChange: (pending: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRequestClose: () => void;
  onReload: () => void;
}) {
  const [initial] = useState(() =>
    createRecordDraft(schema.fields, row, preferences.timezone),
  );
  const [drafts, setDrafts] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [needsReload, setNeedsReload] = useState(false);
  const submitted = useRef(false);
  const attempt = useRef(new MutationAttempt());
  const form = useRef<HTMLFormElement>(null);
  const serverErrorFocus = useRef<string | undefined>(undefined);
  const serverErrorFieldIds = useRef<string[]>([]);
  const readOnly = !canEdit || schema.table.state !== "active";
  useEffect(() => {
    if (busy || reloading || !serverErrorFocus.current) return;
    const id = serverErrorFocus.current;
    serverErrorFocus.current = undefined;
    const focusId =
      schema.foreignKeys.find((rule) => rule.fieldIds.includes(id))
        ?.fieldIds[0] ?? id;
    form.current
      ?.querySelector<HTMLElement>(
        `[data-field-id="${focusId}"] :is(input,textarea,[contenteditable="true"][role="textbox"],[role="spinbutton"],[data-slot="select-trigger"])`,
      )
      ?.focus();
  }, [busy, reloading, schema.foreignKeys, errors]);
  useEffect(() => {
    const fieldId =
      schema.foreignKeys.find((rule) =>
        rule.fieldIds.includes(focusFieldId ?? ""),
      )?.fieldIds[0] ?? focusFieldId;
    const container = fieldId
      ? form.current?.querySelector<HTMLElement>(`[data-field-id="${fieldId}"]`)
      : form.current;
    const firstField =
      !readOnly && window.matchMedia("(pointer: fine)").matches
        ? container?.querySelector<HTMLElement>(
            'input:not([type="hidden"]):not([readonly]):not([disabled]),textarea:not([readonly]):not([disabled]),[contenteditable="true"][role="textbox"],[role="spinbutton"]:not([aria-disabled="true"]),[data-slot="select-trigger"]:not([disabled])',
          )
        : null;
    (
      firstField ?? form.current?.closest<HTMLElement>('[role="dialog"]')
    )?.focus();
  }, [readOnly, focusFieldId, schema.foreignKeys]);
  const dirty = Object.keys(drafts).some((id) => {
    const before = initial[id]!;
    const after = drafts[id]!;
    return (
      before.mode !== after.mode ||
      before.text !== after.text ||
      before.selectedInstant !== after.selectedInstant
    );
  });
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  function change(id: string, draft: RecordFieldDraft) {
    changeFields({ [id]: draft });
  }
  function changeFields(patch: RecordDraft) {
    setDrafts((current) => ({ ...current, ...patch }));
    const changed = Object.keys(patch);
    const clear = serverErrorFieldIds.current.some((id) => changed.includes(id))
      ? [...changed, ...serverErrorFieldIds.current]
      : changed;
    if (clear.length > changed.length) serverErrorFieldIds.current = [];
    setErrors((current) => {
      const next = { ...current };
      for (const id of clear) delete next[id];
      return next;
    });
  }
  async function submit() {
    if (submitted.current || busy || reloading || readOnly || needsReload)
      return;
    const result = recordValues(
      schema.fields,
      drafts,
      row,
      preferences.timezone,
    );
    setErrors(result.errors);
    serverErrorFieldIds.current = [];
    const invalid = Object.keys(result.errors)[0];
    if (invalid) {
      const field = schema.fields.find((field) => field.id === invalid)!;
      const focusId =
        schema.foreignKeys.find((rule) => rule.fieldIds.includes(invalid))
          ?.fieldIds[0] ?? invalid;
      toast.danger(`${field.name}: ${result.errors[invalid]}`);
      form.current
        ?.querySelector<HTMLElement>(
          `[data-field-id="${focusId}"] :is(input,textarea,[contenteditable="true"][role="textbox"],[role="spinbutton"],[data-slot="select-trigger"])`,
        )
        ?.focus();
      return;
    }
    if (row && !Object.keys(result.values).length) {
      onClose();
      return;
    }
    submitted.current = true;
    onPendingChange(true);
    const input = {
      ...target,
      ...(row ? { rowId: row.id, expectedVersion: row.version } : {}),
      expectedSchemaVersion: schema.table.schemaVersion,
      values: result.values,
    };
    try {
      const saved = await client.operation<{ row: Row }>(
        row ? "updateRow" : "createRow",
        input,
        {
          idempotencyKey: attempt.current.forInput(input),
        },
      );
      attempt.current.clear();
      onSaved(saved.row, !row);
      toast.success(row ? "Record saved" : "Record added");
      onClose();
    } catch (error) {
      if (error instanceof ApiError) {
        const fieldIds = recordErrorFields(error.details, schema);
        if (fieldIds.length) {
          serverErrorFieldIds.current = fieldIds;
          setErrors(
            Object.fromEntries(fieldIds.map((id) => [id, error.message])),
          );
          serverErrorFocus.current = fieldIds[0];
        }
        if ([401, 403, 404].includes(error.status)) onAccessLost();
        else if (
          ["ROW_VERSION_CONFLICT", "SCHEMA_VERSION_CONFLICT"].includes(
            error.code,
          )
        )
          setNeedsReload(true);
      }
      toast.danger(
        error instanceof Error
          ? error.message
          : "The record could not be saved.",
      );
    } finally {
      submitted.current = false;
      onPendingChange(false);
    }
  }
  return (
    <form
      ref={form}
      className="record-editor-form"
      noValidate
      aria-label={readOnly ? "Record" : row ? "Edit record" : "Add record"}
      aria-busy={busy || reloading}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDownCapture={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }
      }}
    >
      <Drawer.Body className="record-editor-body">
        {schema.table.state !== "active" && (
          <p className="text-muted">
            This table is in maintenance. Reload the record after maintenance
            finishes.
          </p>
        )}
        {schema.fields.map((field) => {
          const links = schema.foreignKeys.filter(
            (rule) => rule.fieldIds[0] === field.id,
          );
          if (links.length)
            return links.map((rule) => (
              <RecordForeignKey
                key={rule.id}
                target={target}
                rule={rule}
                fields={schema.fields}
                drafts={drafts}
                preferences={preferences}
                errors={errors}
                disabled={busy || reloading}
                readOnly={readOnly}
                creating={!row}
                focus={rule.fieldIds.includes(focusFieldId ?? "")}
                onChange={changeFields}
              />
            ));
          if (
            schema.foreignKeys.some((rule) => rule.fieldIds.includes(field.id))
          )
            return null;
          return (
            <RecordField
              key={field.id}
              field={field}
              draft={drafts[field.id]!}
              onChange={(draft) => change(field.id, draft)}
              creating={!row}
              timeZone={preferences.timezone}
              hourCycle={preferences.timeFormat.startsWith("12-hour") ? 12 : 24}
              invalid={Boolean(errors[field.id])}
              disabled={busy || reloading}
              readOnly={readOnly}
            />
          );
        })}
      </Drawer.Body>
      <Drawer.Footer className="record-editor-footer">
        {needsReload && (
          <Button
            variant="secondary"
            isDisabled={busy || reloading}
            onPress={onReload}
          >
            <RefreshCw />
            Reload record
          </Button>
        )}
        <Button variant="secondary" isDisabled={busy} onPress={onRequestClose}>
          {canEdit ? "Cancel" : "Close"}
        </Button>
        {canEdit && (
          <Button
            type="submit"
            isPending={busy}
            isDisabled={
              busy ||
              reloading ||
              readOnly ||
              needsReload ||
              !schema.fields.length ||
              Boolean(row && !dirty)
            }
          >
            {row ? <Save /> : <Plus />}
            {busy ? "Saving…" : row ? "Save changes" : "Add record"}
          </Button>
        )}
      </Drawer.Footer>
    </form>
  );
}
