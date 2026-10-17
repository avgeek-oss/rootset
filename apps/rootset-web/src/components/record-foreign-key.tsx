"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Description,
  Dropdown,
  Header,
  Label,
  ListBox,
  Select,
} from "@heroui/react";
import {
  Autocomplete,
  SearchField,
} from "@avgeek-oss/design-system/pickers/autocomplete";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { client } from "@rootset/web-client";
import type {
  FieldDefinition,
  ForeignKey,
  Preferences,
  QueryResult,
  Row,
  TableSchemaResult,
  ViewPreferences,
} from "@rootset/contracts";
import type { RecordDraft } from "../lib/record-draft";
import {
  foreignKeyDrafts,
  foreignKeyQuery,
  foreignKeyValues,
} from "../lib/foreign-key-picker";
import { MutationAttempt } from "../lib/mutation-attempt";
import { formatCellValue } from "./cells";
import { RecordField } from "./record-field";
import { FieldTypeIcon } from "./settings/field-type-options";
import {
  Link,
  MoreHorizontal,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from "./ui/icons";

export function RecordForeignKey({
  target,
  rule,
  fields,
  drafts,
  preferences,
  errors,
  disabled,
  readOnly,
  creating,
  focus = false,
  onChange,
}: {
  target: { orgId: string; databaseId: string; tableId: string };
  rule: ForeignKey;
  fields: FieldDefinition[];
  drafts: RecordDraft;
  preferences: Preferences;
  errors: Record<string, string>;
  disabled: boolean;
  readOnly: boolean;
  creating: boolean;
  focus?: boolean;
  onChange: (drafts: RecordDraft) => void;
}) {
  const labelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const pageChanged = useRef(false);
  const pageStatus = useRef<HTMLDivElement>(null);
  const [savingLabel, setSavingLabel] = useState(false);
  const labelLock = useRef(false);
  const attempt = useRef(new MutationAttempt());
  const queryClient = useQueryClient();
  const source = rule.fieldIds.map((id) =>
    fields.find((field) => field.id === id)!,
  );
  const name = source.map((field) => field.name).join(" + ");
  const linkedTarget = { ...target, tableId: rule.referencedTableId };
  const schema = useQuery({
    queryKey: ["foreign-key-schema", target.orgId, rule.referencedTableId],
    queryFn: ({ signal }) =>
      client.operation<TableSchemaResult>("getTableSchema", linkedTarget, {
        signal,
      }),
    refetchOnWindowFocus: true,
    retry: false,
  });
  const view = useQuery({
    queryKey: ["view-preferences", target.tableId],
    queryFn: ({ signal }) =>
      client.operation<{ preferences: ViewPreferences }>(
        "getViewPreferences",
        { tableId: target.tableId },
        { signal },
      ),
    retry: false,
  });
  const targetFields = schema.isError ? [] : (schema.data?.fields ?? []);
  const labelFields = targetFields.filter((field) => field.type !== "json");
  const displayField =
    labelFields.find(
      (field) =>
        field.id === view.data?.preferences.foreignKeyDisplayFields?.[rule.id],
    ) ??
    labelFields.find(
      (field) =>
        field.type === "text" && !rule.referencedFieldIds.includes(field.id),
    ) ??
    labelFields.find((field) => field.type === "text") ??
    labelFields[0];
  const keys = rule.referencedFieldIds.flatMap((id) =>
    targetFields.filter((field) => field.id === id),
  );
  const values = foreignKeyValues(rule, fields, drafts, preferences.timezone);
  const ready =
    !schema.isError && keys.length === rule.referencedFieldIds.length;
  useEffect(() => {
    if (
      ready &&
      focus &&
      !disabled &&
      !readOnly &&
      !focused.current &&
      window.matchMedia("(pointer: fine)").matches
    ) {
      trigger.current?.focus();
      focused.current = true;
    }
  }, [ready, focus, disabled, readOnly]);
  const query = ready ? foreignKeyQuery(keys, displayField, term) : undefined;
  const showKey = keys.length > 1 || displayField?.id !== keys[0]?.id;
  useEffect(() => {
    setCursor(null);
    setPrevious([]);
  }, [displayField?.id, schema.data?.table.schemaVersion]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setTerm(search);
      setCursor(null);
      setPrevious([]);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  const options = useQuery({
    queryKey: [
      "foreign-key-options",
      target.orgId,
      rule.id,
      schema.data?.table.schemaVersion,
      query,
      cursor,
    ],
    queryFn: ({ signal }) =>
      client.operation<QueryResult>(
        "queryRows",
        { ...linkedTarget, query: { ...query, cursor } },
        { signal },
      ),
    enabled: open && ready,
    retry: false,
    gcTime: 0,
  });
  const selected = useQuery({
    queryKey: [
      "foreign-key-selection",
      target.orgId,
      rule.id,
      schema.data?.table.schemaVersion,
      displayField?.id,
      values,
    ],
    queryFn: ({ signal }) =>
      client.operation<QueryResult>(
        "queryRows",
        {
          ...linkedTarget,
          query: {
            select: query!.select,
            where: {
              and: keys.map((field, index) => ({
                field: field.id,
                op: "eq",
                value: values![index],
              })),
            },
            limit: 1,
          },
        },
        { signal },
      ),
    enabled: ready && Boolean(values),
    retry: false,
    gcTime: 0,
  });
  const selectedRow =
    !selected.isError &&
    values &&
    selected.data?.schemaVersion === schema.data?.table.schemaVersion
      ? selected.data?.data[0]
      : undefined;
  const rows =
    options.isError ||
    (options.data &&
      options.data.schemaVersion !== schema.data?.table.schemaVersion)
      ? []
      : (options.data?.data ?? []);
  useEffect(() => {
    if (
      (selected.data &&
        selected.data.schemaVersion !== schema.data?.table.schemaVersion) ||
      (options.data &&
        options.data.schemaVersion !== schema.data?.table.schemaVersion)
    )
      void schema.refetch();
  }, [
    selected.data,
    options.data,
    schema.data?.table.schemaVersion,
    schema.refetch,
  ]);
  useEffect(() => {
    if (options.data && pageChanged.current) {
      pageChanged.current = false;
      pageStatus.current?.focus();
    }
  }, [options.data]);
  const items = [
    ...new Map(
      [...(selectedRow ? [selectedRow] : []), ...rows].map((row) => [
        row.id,
        row,
      ]),
    ).values(),
  ];
  function keyText(row: Row) {
    return keys
      .map((field) => String(row.values[field.name] ?? "NULL"))
      .join(" · ");
  }
  function label(row: Row) {
    if (!displayField) return keyText(row);
    const value = row.values[displayField.name];
    return value === null || value === undefined
      ? "NULL"
      : String(formatCellValue(displayField, value, preferences)) ||
          "(empty text)";
  }
  async function changeDisplayField(displayFieldId: string) {
    if (labelLock.current || disabled) return;
    labelLock.current = true;
    setSavingLabel(true);
    const input = {
      tableId: target.tableId,
      foreignKeyId: rule.id,
      displayFieldId,
    };
    try {
      const result = await client.operation<{ preferences: ViewPreferences }>(
        "updateForeignKeyDisplayField",
        input,
        { idempotencyKey: attempt.current.forInput(input) },
      );
      attempt.current.clear();
      setCursor(null);
      setPrevious([]);
      queryClient.setQueryData(["view-preferences", target.tableId], result);
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "The display field could not be saved.",
      );
    } finally {
      labelLock.current = false;
      setSavingLabel(false);
    }
  }
  function choose(id: string) {
    if (disabled || readOnly || search !== term) return;
    if (id === "null") {
      onChange(
        Object.fromEntries(
          source
            .filter((field) => !field.required)
            .map((field) => [
              field.id,
              { ...drafts[field.id]!, mode: "null", isNull: true },
            ]),
        ),
      );
      return;
    }
    const row = items.find((row) => row.id === id);
    if (row) {
      try {
        onChange(
          foreignKeyDrafts(
            rule,
            fields,
            targetFields,
            row,
            preferences.timezone,
          ),
        );
      } catch (error) {
        toast.danger(
          error instanceof Error
            ? error.message
            : "This linked key is not valid for these fields.",
        );
      }
    }
  }
  const required = source.every((field) => field.required);
  const invalid = source.some((field) => errors[field.id]);
  const rawKeys = values?.map(String).join(" · ");
  return (
    <div
      className="grid gap-3"
      role="group"
      aria-labelledby={labelId}
      data-field-id={source[0]!.id}
      data-foreign-key-id={rule.id}
    >
      <div className="record-field-heading">
        <Label id={labelId}>
          <span className="record-field-label">
            <Link size={18} />
            {name}
            {required && (
              <span aria-hidden="true" className="text-danger">
                *
              </span>
            )}
          </span>
        </Label>
        <Dropdown>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`Options for ${name} link`}
            isDisabled={disabled || savingLabel}
          >
            <MoreHorizontal size={18} />
          </Button>
          <Dropdown.Popover>
            <Dropdown.Menu
              aria-label={`Options for ${name} link`}
              onAction={(key) => {
                if (key === "manual") setManual((value) => !value);
                else if (typeof key === "string" && key.startsWith("display:"))
                  void changeDisplayField(key.slice(8));
              }}
            >
              {!readOnly && (
                <Dropdown.Item id="manual">
                  {manual ? "Choose a linked record" : "Enter keys manually"}
                </Dropdown.Item>
              )}
              <Dropdown.Section>
                <Header>Display field</Header>
                {labelFields.map((field) => (
                  <Dropdown.Item
                    key={field.id}
                    id={`display:${field.id}`}
                    textValue={field.name}
                  >
                    <FieldTypeIcon type={field.type} />
                    {field.name}
                    {field.id === displayField?.id ? " · Selected" : ""}
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
      {!manual && (
        <Select
          aria-labelledby={labelId}
          variant="secondary"
          className="settings-field"
          value={selectedRow?.id ?? (values || required ? null : "null")}
          onChange={(id) => {
            if (typeof id === "string") choose(id);
          }}
          isOpen={open}
          onOpenChange={(value) => {
            setOpen(value);
            if (value) {
              setSearch("");
              setTerm("");
              setCursor(null);
              setPrevious([]);
            }
          }}
          isDisabled={disabled || readOnly || !ready}
          isInvalid={invalid}
          isRequired={required}
          validationBehavior="aria"
          placeholder={
            rawKeys ?? (required ? "Choose a linked record" : "NULL")
          }
        >
          <Select.Trigger ref={trigger}>
            <Select.Value className="min-w-0 flex-1">
              {selectedRow ? (
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  <span
                    className={
                      displayField &&
                      selectedRow.values[displayField.name] == null
                        ? "truncate null-value"
                        : "truncate"
                    }
                  >
                    {label(selectedRow)}
                  </span>
                  {showKey && (
                    <span
                      title={keyText(selectedRow)}
                      className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-xs text-muted"
                    >
                      {keyText(selectedRow)}
                    </span>
                  )}
                </span>
              ) : (
                <span
                  className={values ? "truncate" : required ? "" : "null-value"}
                >
                  {rawKeys ?? (required ? "Choose a linked record" : "NULL")}
                </span>
              )}
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover className="flex w-(--trigger-width) max-w-[calc(100vw-2rem)] flex-col overflow-hidden">
            <Autocomplete.Filter
              filter={() => true}
              inputValue={search}
              onInputChange={setSearch}
            >
              <SearchField
                aria-label={`Search ${rule.referencedTableName}`}
                variant="secondary"
                className="shrink-0 px-2 pt-2 pb-2"
              >
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input
                    className="text-base sm:text-sm"
                    placeholder="Search by label or key…"
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={
                      typeof window !== "undefined" &&
                      window.matchMedia("(pointer: fine)").matches
                    }
                  />
                  <SearchField.ClearButton aria-label="Clear linked record search" />
                </SearchField.Group>
              </SearchField>
              <ListBox
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                renderEmptyState={() =>
                  options.isError
                    ? "Records could not be loaded"
                    : options.isPending || search !== term
                      ? "Loading records…"
                      : "No matching records"
                }
              >
                {!required && (
                  <ListBox.Item
                    id="null"
                    textValue="NULL"
                    isDisabled={search !== term}
                  >
                    <span className="null-value">NULL</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                )}
                {items.map((row) => (
                  <ListBox.Item
                    key={row.id}
                    id={row.id}
                    textValue={`${label(row)} ${keyText(row)}`}
                    isDisabled={search !== term}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-3">
                      <span
                        className={
                          displayField && row.values[displayField.name] == null
                            ? "truncate null-value"
                            : "truncate"
                        }
                      >
                        {label(row)}
                      </span>
                      {showKey && (
                        <span
                          title={keyText(row)}
                          className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-xs text-muted"
                        >
                          {keyText(row)}
                        </span>
                      )}
                    </span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Autocomplete.Filter>
            {(search !== term ||
              options.isPending ||
              (!options.isError && !rows.length)) && (
              <p role="status" className="px-3 py-2 text-sm text-muted">
                {search !== term || options.isPending
                  ? "Loading records…"
                  : "No matching records"}
              </p>
            )}
            {options.isError ? (
              <Button
                slot={null}
                variant="secondary"
                onPress={() => void options.refetch()}
              >
                <RefreshCw />
                Retry loading records
              </Button>
            ) : null}
            {(cursor || options.data?.page.hasMore || previous.length > 0) && (
              <div
                className="flex items-center justify-between gap-3 px-2 py-2"
                ref={pageStatus}
                role="status"
                tabIndex={-1}
              >
                <Button
                  slot={null}
                  variant="secondary"
                  size="sm"
                  isDisabled={
                    !previous.length || options.isFetching || search !== term
                  }
                  onPress={() => {
                    pageChanged.current = true;
                    setCursor(previous.at(-1) ?? null);
                    setPrevious(previous.slice(0, -1));
                  }}
                >
                  <ChevronLeft />
                  Previous
                </Button>
                <span className="text-xs text-muted tabular-nums">
                  {options.isFetching ? "Loading…" : `${rows.length} records`}
                </span>
                <Button
                  slot={null}
                  variant="secondary"
                  size="sm"
                  isDisabled={
                    !options.data?.page.hasMore ||
                    options.isFetching ||
                    search !== term
                  }
                  onPress={() => {
                    if (!options.data?.page.nextCursor) return;
                    pageChanged.current = true;
                    setPrevious([...previous, cursor]);
                    setCursor(options.data.page.nextCursor);
                  }}
                >
                  Next
                  <ChevronRight />
                </Button>
              </div>
            )}
          </Select.Popover>
          <Description>
            {rule.referencedTableName}
            {savingLabel ? " · Saving display field…" : ""}
          </Description>
        </Select>
      )}
      {(schema.isError || selected.isError) && (
        <div className="grid justify-items-start gap-2">
          <p role="alert" className="text-sm text-muted">
            {schema.error?.message ?? selected.error?.message}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onPress={() => void (schema.isError ? schema : selected).refetch()}
          >
            <RefreshCw />
            Retry loading link
          </Button>
        </div>
      )}
      {schema.isPending && (
        <p role="status" className="text-sm text-muted">
          Loading linked fields…
        </p>
      )}
      {manual && (
        <p className="text-sm text-muted">{rule.referencedTableName}</p>
      )}
      {manual &&
        source.map((field) => (
          <RecordField
            key={field.id}
            field={field}
            draft={drafts[field.id]!}
            onChange={(draft) => onChange({ [field.id]: draft })}
            creating={creating}
            timeZone={preferences.timezone}
            hourCycle={preferences.timeFormat.startsWith("12-hour") ? 12 : 24}
            invalid={Boolean(errors[field.id])}
            disabled={disabled}
            readOnly={readOnly}
          />
        ))}
    </div>
  );
}
