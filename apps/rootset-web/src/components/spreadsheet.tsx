"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import {
  DataGrid,
  Row as DataGridRow,
  type Column,
  type DataGridHandle,
  type CellKeyDownArgs,
  type CellKeyboardEvent,
} from "react-data-grid";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { NumberField, Label, Dropdown, Checkbox, Tooltip } from "@heroui/react";
import { CellInput } from "./cells/CellInput";
import {
  createCellDraft,
  parseCellDraft,
  validateCellDraft,
  type CellDraft as InputDraft,
} from "./cells/drafts";
import { Filter, Plus, Columns3 } from "./ui/icons";
import { client, ApiError, resourcePath } from "@rootset/web-client";
import {
  limits,
  type FilterNode,
  type FieldDefinition,
  type Row,
  type JsonValue,
  type Preferences,
  type QuerySpec,
  type QueryResult,
  type Table,
  type TableSchemaResult,
} from "@rootset/contracts";
import { RowWindowCache } from "../lib/window-cache";
import { parseTsvCells, type TsvCell } from "../lib/clipboard";
import { parsePastedCell } from "../lib/pasted-cell";
import {
  copySelectedRows,
  readSelectedWindow,
} from "../lib/clipboard-selection";
import { MutationAttempt } from "../lib/mutation-attempt";
import { DebouncedSave } from "../lib/debounced-save";
import { CellEditor, formatCellValue } from "./cells";
import { Dialog } from "./dialog";
import { PasteImport } from "./paste-import";
import { TableFilterDialog } from "./table-filter-dialog";
import type { FilterCombination, FilterCondition } from "../lib/table-filters";

interface WindowResult extends QueryResult {
  window?: {
    sessionId: string;
    start: number;
    total?: number | null;
    previousCursor?: string | null;
  };
}
interface CellSelection {
  row: number;
  column: number;
  endRow: number;
  endColumn: number;
}
interface CellDraft {
  row: Row;
  field: FieldDefinition;
  initialInput?: string;
  initialValue?: JsonValue;
  error?: string;
  conflict?: string;
  schemaConflict?: boolean;
  notice?: string;
}
const rowHeight = 32;
const windowLimit = 200;
const preferencesEmpty = {
  columnOrder: [] as string[],
  columnWidths: {} as Record<string, number>,
  frozenColumns: 0,
  hiddenColumns: [] as string[],
};

export function Spreadsheet({
  orgId,
  databaseId,
  table,
  preferences,
  canEdit,
  canManage,
  onSettings,
  onChanged,
}: {
  orgId: string;
  databaseId: string;
  table: Table;
  preferences: Preferences;
  canEdit: boolean;
  canManage: boolean;
  onSettings: (section: string) => void;
  onChanged: () => void;
}) {
  const tablePath = resourcePath(orgId, databaseId, table.id);
  const queryClient = useQueryClient();
  const schema = useQuery({
    queryKey: ["schema", table.id],
    queryFn: ({ signal }) =>
      client.request<TableSchemaResult>(`${tablePath}/schema`, { signal }),
  });
  const view = useQuery({
    queryKey: ["view-preferences", table.id],
    queryFn: ({ signal }) =>
      client.operation<{ preferences: typeof preferencesEmpty }>(
        "getViewPreferences",
        { tableId: table.id },
        { signal },
      ),
  });
  const [viewPrefs, setViewPrefs] = useState(preferencesEmpty);
  const latestViewPrefs = useRef(preferencesEmpty);
  const mounted = useRef(true);
  const viewSaveToast = useRef<string | undefined>(undefined);
  const [rows, setRows] = useState<Row[]>([]);
  const [query, setQuery] = useState<QuerySpec>({ limit: windowLimit });
  const [windowStart, setWindowStart] = useState(0);
  const [windowInfo, setWindowInfo] = useState<WindowResult | null>(null);
  const [displayedNavigation, setDisplayedNavigation] = useState("");
  const [loading, setLoading] = useState(false);
  const [accessRevoked, setAccessRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const [draft, setDraft] = useState<CellDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [history, setHistory] = useState<{
    row: Row;
    field: FieldDefinition;
  } | null>(null);
  const [pastePreview, setPastePreview] = useState<{
    cells: string[][];
    operations: {
      kind: "update";
      rowId: string;
      expectedVersion: string;
      values: Record<string, JsonValue>;
    }[];
    errors: string[];
    larger: boolean;
    values: Record<string, JsonValue>[];
    start: number;
  } | null>(null);
  const [filterVisible, setFilterVisible] = useState(false);
  const [addRow, setAddRow] = useState(false);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>(
    [],
  );
  const [filterCombination, setFilterCombination] =
    useState<FilterCombination>("and");
  const [jump, setJump] = useState(1);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    row?: Row;
    field?: FieldDefinition;
  } | null>(null);
  const contextAnchor = useRef<Element | null>(null);
  const gridRef = useRef<DataGridHandle>(null);
  const closeEditor = useRef<(() => void) | null>(null);
  const submitEditor = useRef<(() => Promise<boolean>) | null>(null);
  const extendSelection = useRef(false);
  const cache = useRef(new RowWindowCache());
  const abort = useRef<AbortController | null>(null);
  const copyAbort = useRef<AbortController | null>(null);
  const sessionId = useRef<string | undefined>(undefined);
  const cellAttempt = useRef(new MutationAttempt());
  const pasteAttempt = useRef(new MutationAttempt());
  const viewportTiming = useRef<{
    context: string;
    startedAt: number;
    emitted: boolean;
  } | null>(null);
  const previousFilter = useRef("");
  const previousSchemaVersion = useRef<number | undefined>(undefined);
  const currentStart = useRef(0);
  const currentRows = useRef<Row[]>([]);
  const currentSelection = useRef<CellSelection | null>(null);
  const viewSave: DebouncedSave<typeof preferencesEmpty> = useMemo(
    () =>
      new DebouncedSave<typeof preferencesEmpty>(
        async (next) => {
          const result = await client.operation<{
            preferences: typeof preferencesEmpty;
          }>("updateViewPreferences", { tableId: table.id, preferences: next });
          queryClient.setQueryData(["view-preferences", table.id], result);
          if (viewSaveToast.current) {
            toast.close(viewSaveToast.current);
            viewSaveToast.current = undefined;
          }
        },
        (failure) => {
          if (!mounted.current) return;
          const revoked =
            failure instanceof ApiError &&
            [401, 403, 404].includes(failure.status);
          if (revoked) {
            cache.current.clear();
            setRows([]);
            setWindowInfo(null);
            setSelection(null);
            setAccessRevoked(true);
          }
          if (viewSaveToast.current) toast.close(viewSaveToast.current);
          viewSaveToast.current = toast.danger(
            "Column widths could not be saved",
            {
              description:
                failure instanceof Error
                  ? failure.message
                  : "Try again in a moment.",
              timeout: 0,
              ...(!revoked && {
                actionProps: {
                  children: "Retry",
                  onPress: () => {
                    if (mounted.current) void viewSave.flush();
                  },
                },
              }),
            },
          );
        },
      ),
    [table.id, queryClient],
  );
  const queryDigest = JSON.stringify(query);
  const copyContext = `${tablePath}:${schema.data?.table.schemaVersion}:${queryDigest}:${JSON.stringify(selection)}:${rows.map((row) => `${row.id}:${row.version}`).join("|")}`;
  const navigationDigest = JSON.stringify({
    where: query.where,
    orderBy: query.orderBy,
  });
  const staleResults = !!windowInfo && displayedNavigation !== navigationDigest;
  const fields = useMemo(() => schema.data?.fields ?? [], [schema.data]);
  const currentTotal =
    windowInfo?.window?.total ?? (!query.where ? table.rowCount : undefined);
  const canJump =
    Number.isSafeInteger(jump) &&
    jump >= 1 &&
    (currentTotal === undefined || jump <= currentTotal);
  const writable =
    canEdit &&
    !accessRevoked &&
    !staleResults &&
    (!windowInfo ||
      windowInfo.schemaVersion === schema.data?.table.schemaVersion) &&
    (schema.data?.table.state ?? table.state) === "active";

  useEffect(() => {
    if (view.data && !viewSave.hasPending) {
      latestViewPrefs.current = view.data.preferences;
      setViewPrefs(view.data.preferences);
    }
  }, [view.data, viewSave]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (viewSaveToast.current) toast.close(viewSaveToast.current);
      void viewSave.flush();
    };
  }, [viewSave]);
  useEffect(() => {
    viewportTiming.current = {
      context: tablePath,
      startedAt: performance.now(),
      emitted: false,
    };
  }, [tablePath]);
  useEffect(() => {
    const timing = viewportTiming.current;
    if (
      !timing ||
      timing.context !== tablePath ||
      timing.emitted ||
      loading ||
      staleResults ||
      accessRevoked ||
      !rows.length
    )
      return;
    let frame: number;
    frame = requestAnimationFrame(() => {
      // The second frame follows a populated DOM's paint opportunity.
      frame = requestAnimationFrame(() => {
        const element = gridRef.current?.element;
        const cells = element?.querySelectorAll('[role="gridcell"]');
        if (
          !element ||
          !cells?.length ||
          !element.getClientRects().length ||
          element.querySelector('[data-cell-loaded="false"]') !== null
        )
          return;
        timing.emitted = true;
        performance.clearMarks("rootset:grid:usable");
        performance.clearMeasures("rootset:grid:navigation-viewport");
        performance.clearMeasures("rootset:grid:context-viewport");
        performance.mark("rootset:grid:usable", {
          detail: {
            orgId,
            databaseId,
            tableId: table.id,
            schemaVersion: schema.data?.table.schemaVersion,
            rows: rows.length,
            columns: fields.length,
          },
        });
        performance.measure("rootset:grid:navigation-viewport", {
          start: 0,
          end: "rootset:grid:usable",
        });
        performance.measure("rootset:grid:context-viewport", {
          start: timing.startedAt,
          end: "rootset:grid:usable",
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    tablePath,
    orgId,
    databaseId,
    table.id,
    schema.data?.table.schemaVersion,
    rows,
    fields.length,
    loading,
    staleResults,
    accessRevoked,
  ]);
  const loadWindow = useCallback(
    async (
      position: number | "first" | "middle" | "last" = "first",
      cursor?: string | null,
    ) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const key = `${table.id}:${schema.data?.table.schemaVersion}:${queryDigest}:${String(position)}:${cursor ?? ""}`;
      const cached = cache.current.get(key);
      if (cached && typeof position === "number") {
        setRows(cached.rows);
        setWindowStart(cached.start);
      }
      setLoading(true);
      setError(null);
      try {
        const response = await client.request<WindowResult>(
          `/tables/${table.id}/windows/query`,
          {
            method: "POST",
            body: {
              orgId,
              databaseId,
              query: {
                ...query,
                limit: windowLimit,
                ...(cursor ? { cursor } : {}),
              },
              position: position === 0 ? "first" : position,
              ...(sessionId.current ? { sessionId: sessionId.current } : {}),
            },
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) return;
        setAccessRevoked(false);
        const start =
          response.window?.start ??
          (typeof position === "number" ? position : 0);
        sessionId.current = response.window?.sessionId;
        setRows(response.data);
        setWindowStart(start);
        setJump(start + 1);
        setWindowInfo(response);
        if (response.schemaVersion !== schema.data?.table.schemaVersion)
          void schema.refetch();
        setDisplayedNavigation(
          JSON.stringify({ where: query.where, orderBy: query.orderBy }),
        );
        const selected = currentSelection.current;
        if (selected) {
          const firstId = currentRows.current[selected.row]?.id;
          const lastId = currentRows.current[selected.endRow]?.id;
          const first = response.data.findIndex((row) => row.id === firstId);
          const last = response.data.findIndex((row) => row.id === lastId);
          const nextSelection =
            first < 0 || last < 0
              ? null
              : { ...selected, row: first, endRow: last };
          if (!closeEditor.current)
            gridRef.current?.setActivePosition(
              {
                rowIdx: nextSelection?.row ?? -1,
                idx: nextSelection ? nextSelection.column + 1 : 0,
              },
              { shouldFocus: false },
            );
          setSelection(nextSelection);
        } else if (!closeEditor.current) {
          gridRef.current?.setActivePosition(
            { rowIdx: -1, idx: 0 },
            { shouldFocus: false },
          );
        }
        cache.current.set({
          key,
          start,
          rows: response.data,
          nextCursor: response.page.nextCursor,
        });
        gridRef.current?.scrollToCell({ rowIdx: 0 });
        setAnnouncement(
          `Loaded ${response.data.length} rows starting at row ${start + 1}. Results are live.`,
        );
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === "CURSOR_INVALID") {
          sessionId.current = undefined;
          cache.current.clear();
          void schema.refetch();
        }
        if (
          failure instanceof ApiError &&
          [401, 403, 404].includes(failure.status)
        ) {
          cache.current.clear();
          setRows([]);
          setWindowInfo(null);
          setSelection(null);
          setAccessRevoked(true);
          setDraft((previous) =>
            previous
              ? {
                  ...previous,
                  error:
                    "Your access changed. This draft has not been saved; restore access before retrying.",
                }
              : null,
          );
        }
        if (!(failure instanceof Error && failure.name === "AbortError"))
          setError(
            failure instanceof Error
              ? failure.message
              : "Rows could not be loaded",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [
      table.id,
      schema.data?.table.schemaVersion,
      queryDigest,
      orgId,
      databaseId,
    ],
  );

  useEffect(() => {
    cache.current.clear();
    const navigationQuery = JSON.stringify({
      where: query.where,
      orderBy: query.orderBy,
    });
    const sameNavigation =
      previousFilter.current === navigationQuery &&
      previousSchemaVersion.current === schema.data?.table.schemaVersion;
    if (!sameNavigation) sessionId.current = undefined;
    const position = sameNavigation ? currentStart.current : 0;
    previousFilter.current = navigationQuery;
    previousSchemaVersion.current = schema.data?.table.schemaVersion;
    if (schema.data) void loadWindow(position);
    return () => abort.current?.abort();
  }, [loadWindow, schema.data?.table.schemaVersion]);

  useEffect(() => {
    currentStart.current = windowStart;
  }, [windowStart]);
  useEffect(() => {
    currentRows.current = rows;
    currentSelection.current = selection;
  }, [rows, selection]);
  useEffect(() => () => copyAbort.current?.abort(), [copyContext]);
  async function leaveEditor(action: () => void) {
    if (saving) return;
    if (draft && !(await submitEditor.current?.())) return;
    action();
  }

  function focusCell(row: number, column: number) {
    gridRef.current?.setActivePosition(
      { rowIdx: row, idx: column + 1 },
      { shouldFocus: true },
    );
  }

  function beginEdit(row: Row, field: FieldDefinition, initialInput?: string) {
    if (!writable || saving || !Object.hasOwn(row.values, field.name)) return;
    setDraft({
      row,
      field,
      ...(initialInput !== undefined ? { initialInput } : {}),
    });
  }

  async function commitCell(value: JsonValue, target = draft) {
    const draft = target;
    if (!draft || saving || draft.schemaConflict) return false;
    if (!writable) {
      setDraft({
        ...draft,
        error: "This table is currently read-only. Your draft is still here.",
      });
      return false;
    }
    if (
      !draft.error &&
      rows.find((row) => row.id === draft.row.id)?.version ===
        draft.row.version &&
      JSON.stringify(value) ===
        JSON.stringify(draft.row.values[draft.field.name] ?? null)
    ) {
      setDraft(null);
      return true;
    }
    setSaving(true);
    try {
      const input = {
        orgId,
        databaseId,
        tableId: table.id,
        rowId: draft.row.id,
        values: { [draft.field.name]: value },
        expectedVersion: draft.row.version,
        expectedSchemaVersion: schema.data!.table.schemaVersion,
      };
      const outcome = await client.operation<{ row: Row }>("updateRow", input, {
        idempotencyKey: cellAttempt.current.forInput(input),
      });
      const updated = outcome.row;
      setRows((previous) =>
        previous.map((row) => (row.id === updated.id ? updated : row)),
      );
      cache.current.clear();
      setDraft(null);
      cellAttempt.current.clear();
      setAnnouncement(`${draft.field.name} saved.`);
      onChanged();
      if (
        query.where ||
        query.orderBy?.some(
          (sort) =>
            sort.field === draft.field.name || sort.field === draft.field.id,
        )
      )
        void loadWindow(windowStart);
      return true;
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        [401, 403, 404].includes(failure.status)
      ) {
        cache.current.clear();
        setRows([]);
        setWindowInfo(null);
        setSelection(null);
        setAccessRevoked(true);
      }
      const details =
        failure instanceof ApiError
          ? (failure.details as
              | {
                  current?: Row;
                  currentRow?: Row;
                  values?: Record<string, JsonValue>;
                }
              | undefined)
          : undefined;
      let current = details?.current ?? details?.currentRow;
      if (
        failure instanceof ApiError &&
        failure.code === "ROW_VERSION_CONFLICT" &&
        !current
      ) {
        try {
          current = await client.operation<Row>("getRow", {
            orgId,
            databaseId,
            tableId: table.id,
            rowId: draft.row.id,
          });
        } catch {
          /* The original mutation error remains visible if access has been revoked. */
        }
      }
      setDraft((retained) => {
        const previous = retained ?? draft;
        return {
          ...previous,
          error:
            failure instanceof Error
              ? failure.message
              : "The value could not be saved",
          schemaConflict:
            failure instanceof ApiError &&
            failure.code === "SCHEMA_VERSION_CONFLICT",
          ...(current
            ? {
                conflict: formatCellValue(
                  previous.field,
                  current.values[previous.field.name] ?? null,
                  {
                    timeZone: preferences.timezone,
                    locale: preferences.locale,
                  },
                ),
                row: current,
              }
            : {}),
        };
      });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function setCellNull(row: Row, field: FieldDefinition) {
    const saved = await commitCell(null, { row, field, initialValue: null });
    if (saved) return;
    const rowIdx = rows.findIndex((candidate) => candidate.id === row.id);
    const idx = fields.findIndex((candidate) => candidate.id === field.id) + 1;
    if (rowIdx >= 0 && idx > 0)
      gridRef.current?.setActivePosition(
        { rowIdx, idx },
        { enableEditor: true },
      );
  }

  function onKey(args: CellKeyDownArgs<Row>, event: CellKeyboardEvent) {
    if (args.mode === "EDIT") {
      event.preventGridDefault();
      return;
    }
    const { row, column, rowIdx } = args;
    if (!row || !column || rowIdx < 0) return;
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      event.preventGridDefault();
      contextAnchor.current =
        event.target instanceof Element
          ? event.target.closest('[role="gridcell"]')
          : null;
      setContextMenu(
        column.key === "__row_number"
          ? {}
          : { row, field: fields.find((field) => field.id === column.key) },
      );
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c"
    ) {
      event.preventDefault();
      event.preventGridDefault();
      void copySelection();
    } else if (
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
    ) {
      extendSelection.current = event.shiftKey;
    } else if (
      event.key === "Enter" ||
      event.key === "F2" ||
      (event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey)
    ) {
      const field = fields.find((field) => field.id === column.key);
      if (field) {
        event.preventDefault();
        event.preventGridDefault();
        if (saving) return;
        beginEdit(row, field, event.key.length === 1 ? event.key : undefined);
        args.setActivePosition(
          { rowIdx, idx: column.idx },
          { enableEditor: true },
        );
      }
    }
  }

  async function copySelection() {
    if (!selection || copying || accessRevoked || staleResults) return;
    if (loading) {
      setError("Wait for the current rows to load, then copy the selection.");
      return;
    }
    const controller = new AbortController();
    copyAbort.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.requestTimeoutMs);
    setCopying(true);
    setAnnouncement("Preparing selection for copy…");
    let preparationFailure: unknown;
    try {
      const firstRow = Math.min(selection.row, selection.endRow);
      const selectedRows = rows.slice(
        firstRow,
        Math.max(selection.row, selection.endRow) + 1,
      );
      const selectedFields = fields.slice(
        Math.min(selection.column, selection.endColumn),
        Math.max(selection.column, selection.endColumn) + 1,
      );
      const querySnapshot: QuerySpec = {
        ...query,
        select: selectedFields.map((field) => field.name),
        cursor: null,
      };
      const needsRead = selectedRows.some((row) =>
        selectedFields.some((field) => !Object.hasOwn(row.values, field.name)),
      );
      const preparedRows = needsRead
        ? readSelectedWindow(
            selectedRows,
            firstRow,
            schema.data!.table.schemaVersion,
            (cursor, limit, signal) =>
              cursor
                ? client.operation<QueryResult>(
                    "queryRows",
                    {
                      orgId,
                      databaseId,
                      tableId: table.id,
                      query: { ...querySnapshot, limit, cursor },
                    },
                    { signal },
                  )
                : client.request<WindowResult>(
                    `/tables/${table.id}/windows/query`,
                    {
                      method: "POST",
                      body: {
                        orgId,
                        databaseId,
                        query: { ...querySnapshot, limit },
                        position: windowStart === 0 ? "first" : windowStart,
                        ...(sessionId.current
                          ? { sessionId: sessionId.current }
                          : {}),
                      },
                      signal,
                    },
                  ),
            controller.signal,
          )
        : Promise.resolve(selectedRows);
      const text = preparedRows.then((current) =>
        copySelectedRows(
          current,
          selectedFields,
          () => {
            throw new Error(
              "A selected field is unavailable. Refresh its schema and rows before copying.",
            );
          },
          controller.signal,
        ),
      );
      const content = text.then(
        (value) => {
          controller.signal.throwIfAborted();
          return new Blob([value], { type: "text/plain" });
        },
        (failure: unknown) => {
          preparationFailure = failure;
          throw failure;
        },
      );
      // Native permission refusal can precede consumption of the pending data.
      void content.catch(() => undefined);
      // Begin the browser permission call inside the copy gesture, including Safari.
      if (!navigator.clipboard || typeof ClipboardItem !== "function")
        throw new Error(
          "Clipboard access is unavailable in this browser. Use a secure connection or export the selected data.",
        );
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": content }),
      ]);
      setAnnouncement("Selection copied.");
    } catch (writeFailure) {
      const failure = preparationFailure ?? writeFailure;
      if (timedOut)
        setError(
          "Copy timed out. Your clipboard has not changed. Retry the selection.",
        );
      else if (!controller.signal.aborted) {
        if (
          failure instanceof ApiError &&
          [401, 403, 404].includes(failure.status)
        ) {
          cache.current.clear();
          setRows([]);
          setWindowInfo(null);
          setSelection(null);
          setAccessRevoked(true);
        }
        setError(
          failure instanceof DOMException && failure.name === "NotAllowedError"
            ? "Clipboard access was denied. Allow clipboard access and retry."
            : failure instanceof Error
              ? failure.message
              : "The selection could not be copied. Your clipboard has not changed.",
        );
      } else setAnnouncement("Copy cancelled; your clipboard has not changed.");
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (copyAbort.current === controller) copyAbort.current = null;
      setCopying(false);
    }
  }

  function previewPaste(text: string) {
    if (!selection || !writable) return;
    let parsedCells: TsvCell[][];
    try {
      parsedCells = parseTsvCells(text);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Clipboard data could not be parsed",
      );
      return;
    }
    const cells = parsedCells.map((line) => line.map((cell) => cell.value));
    const errors: string[] = [];
    const parsedValues: Record<string, JsonValue>[] = [];
    const operations: {
      kind: "update";
      rowId: string;
      expectedVersion: string;
      values: Record<string, JsonValue>;
    }[] = [];
    if (cells.some((line) => line.length !== cells[0]?.length))
      errors.push("The pasted selection must be rectangular.");
    let larger =
      cells.length > 1000 || cells.length + selection.row > rows.length;
    cells.forEach((line, index) => {
      const row = rows[selection.row + index];
      const values: Record<string, JsonValue> = {};
      line.forEach((value, column) => {
        const field = fields[selection.column + column];
        if (!field) {
          errors.push(`Row ${index + 1} extends beyond the selected columns.`);
          return;
        }
        try {
          values[field.name] = parsePastedCell(
            field,
            value,
            parsedCells[index]![column]!.quoted,
          );
        } catch (failure) {
          errors.push(
            `Row ${index + 1}: ${failure instanceof Error ? failure.message : "Invalid value"}`,
          );
        }
      });
      parsedValues.push(values);
      if (row && !larger)
        operations.push({
          kind: "update",
          rowId: row.id,
          expectedVersion: row.version,
          values,
        });
    });
    if (!larger) {
      const input = {
        orgId,
        databaseId,
        tableId: table.id,
        mutations: operations.map(({ kind, ...mutation }) => ({
          ...mutation,
          type: kind,
        })),
        expectedSchemaVersion: schema.data!.table.schemaVersion,
      };
      larger =
        new TextEncoder().encode(JSON.stringify(input)).byteLength >
        limits.requestBytes;
    }
    setPastePreview({
      cells,
      errors: errors.slice(0, 50),
      operations,
      larger,
      values: parsedValues,
      start: windowStart + selection.row,
    });
  }

  async function confirmPaste() {
    if (!pastePreview || pastePreview.errors.length) return;
    setSaving(true);
    try {
      const input = {
        orgId,
        databaseId,
        tableId: table.id,
        mutations: pastePreview.operations.map(({ kind, ...mutation }) => ({
          ...mutation,
          type: kind,
        })),
        expectedSchemaVersion: schema.data!.table.schemaVersion,
      };
      await client.operation("mutateRows", input, {
        idempotencyKey: pasteAttempt.current.forInput(input),
      });
      setPastePreview(null);
      pasteAttempt.current.clear();
      cache.current.clear();
      void loadWindow(windowStart);
      setAnnouncement("Paste committed atomically.");
      onChanged();
    } catch (failure) {
      setPastePreview((previous) =>
        previous
          ? {
              ...previous,
              errors: [
                failure instanceof Error ? failure.message : "Paste failed",
              ],
            }
          : null,
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelectedRow() {
    if (!selection || !writable) return;
    const row = rows[selection.row];
    if (!row) return;
    if (!confirm("Delete the selected row? Its cell history will be retained."))
      return;
    setSaving(true);
    try {
      await client.request(`${tablePath}/rows/${row.id}`, {
        method: "DELETE",
        headers: { "If-Match": `\"${row.id}:${row.version}\"` },
        body: { expectedSchemaVersion: schema.data!.table.schemaVersion },
      });
      cache.current.clear();
      void loadWindow(windowStart);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Deletion failed");
    } finally {
      setSaving(false);
    }
  }

  function applyFilters(
    conditions: FilterCondition[],
    combination: FilterCombination,
    where: FilterNode | undefined,
  ) {
    leaveEditor(() => {
      setQuery({ limit: windowLimit, ...(where ? { where } : {}) });
      setFilterConditions(conditions);
      setFilterCombination(combination);
      setFilterVisible(false);
    });
  }

  function renderEditor(onClose?: () => void) {
    return draft ? (
      <div
        className="inline-cell-editor"
        role="group"
        aria-label={`Edit ${draft.field.name}`}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <CellEditor
          submitRef={submitEditor}
          field={draft.field}
          value={
            draft.initialValue !== undefined
              ? draft.initialValue
              : (draft.row.values[draft.field.name] ?? null)
          }
          initialInput={draft.initialInput}
          timeZone={preferences.timezone}
          locale={preferences.locale}
          onCommit={async (value, move) => {
            const saved = await commitCell(value);
            if (saved) {
              onClose?.();
              if (move) {
                let row = editingRow;
                let column =
                  fields.findIndex((field) => field.id === draft.field.id) +
                  move;
                if (column < 0) {
                  row--;
                  column = fields.length - 1;
                } else if (column === fields.length) {
                  row++;
                  column = 0;
                }
                if (row >= 0 && row < rows.length) focusCell(row, column);
              }
            }
            return saved;
          }}
          onCancel={() => {
            setDraft(null);
            onClose?.();
          }}
          pending={saving}
          commitDisabled={draft.schemaConflict}
          error={draft.error}
          conflict={draft.conflict}
        />
        {draft.conflict !== undefined && (
          <Button
            variant="secondary"
            onPress={() =>
              setDraft((previous) =>
                previous
                  ? { ...previous, conflict: undefined, error: undefined }
                  : null,
              )
            }
          >
            Keep my draft and retry against the current version
          </Button>
        )}
        {draft.notice && (
          <p className="notice" role="status">
            {draft.notice}
          </p>
        )}
        {draft.schemaConflict && (
          <Button
            variant="secondary"
            isDisabled={saving || schema.isFetching}
            onPress={() => {
              void schema.refetch().then((result) => {
                const current = result.data?.fields.find(
                  (field) => field.id === draft.field.id,
                );
                if (!current || current.type !== draft.field.type) {
                  setDraft((previous) =>
                    previous
                      ? {
                          ...previous,
                          error: current
                            ? `This field now uses ${current.type}. Your draft remains here. Cancel explicitly and reopen the cell to use its new editor.`
                            : "This field has been removed. Your draft remains here; cancel explicitly after copying any values you need.",
                        }
                      : null,
                  );
                  return;
                }
                setDraft((previous) =>
                  previous
                    ? {
                        ...previous,
                        field: current,
                        schemaConflict: false,
                        notice:
                          "The current schema is loaded. Review its validation, then save your retained draft.",
                        error: undefined,
                      }
                    : null,
                );
              });
            }}
          >
            Reload schema and review draft
          </Button>
        )}
      </div>
    ) : null;
  }
  const editingRow = draft
    ? rows.findIndex((row) => row.id === draft.row.id)
    : -1;
  const gridColumns: Column<Row>[] = [
    {
      key: "__row_number",
      name: "#",
      width: 52,
      frozen: true,
      resizable: false,
      renderHeaderCell: ({ tabIndex }) => (
        <button
          type="button"
          aria-label="Row navigation"
          aria-haspopup="menu"
          tabIndex={tabIndex}
          onContextMenu={(event) => {
            event.preventDefault();
            const anchor = event.currentTarget;
            leaveEditor(() => {
              contextAnchor.current = anchor;
              setContextMenu({});
            });
          }}
          onClick={(event) => {
            const anchor = event.currentTarget;
            leaveEditor(() => {
              contextAnchor.current = anchor;
              setContextMenu({});
            });
          }}
          onKeyDown={(event) => {
            if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              event.stopPropagation();
              const anchor = event.currentTarget;
              leaveEditor(() => {
                contextAnchor.current = anchor;
                setContextMenu({});
              });
            }
          }}
        >
          #
        </button>
      ),
      renderCell: ({ rowIdx }) => windowStart + rowIdx + 1,
    },
    ...fields.map((field, index): Column<Row> => ({
      key: field.id,
      name: field.name,
      width:
        viewPrefs.columnWidths[field.id] ??
        (field.type === "date-time"
          ? 340
          : field.type === "json"
            ? 240
            : field.type === "date"
              ? 200
              : 180),
      frozen: index < viewPrefs.frozenColumns,
      maxWidth: 2000,
      editable: (row) => writable && Object.hasOwn(row.values, field.name),
      renderHeaderCell: ({ tabIndex }) => (
        <Tooltip delay={250} closeDelay={0}>
          <Tooltip.Trigger tabIndex={tabIndex}>{field.name}</Tooltip.Trigger>
          <Tooltip.Content placement="top">
            {field.type === "time" ? "UTC time" : field.type}
            {field.required ? " · required" : ""}
          </Tooltip.Content>
        </Tooltip>
      ),
      cellClass: (row) => {
        if (!selection) return undefined;
        const rowIdx = rows.findIndex((candidate) => candidate.id === row.id);
        return rowIdx >= Math.min(selection.row, selection.endRow) &&
          rowIdx <= Math.max(selection.row, selection.endRow) &&
          index >= Math.min(selection.column, selection.endColumn) &&
          index <= Math.max(selection.column, selection.endColumn)
          ? "range-selected"
          : undefined;
      },
      renderCell: ({ row }) => (
        <span data-cell-loaded={Object.hasOwn(row.values, field.name)}>
          {!Object.hasOwn(row.values, field.name)
            ? "Loading…"
            : formatCellValue(field, row.values[field.name] ?? null, {
                timeZone: preferences.timezone,
                locale: preferences.locale,
                dateFormat: preferences.dateFormat,
                timeFormat: preferences.timeFormat,
              })}
        </span>
      ),
      renderEditCell: ({ onClose }) => (
        <GridEditorBridge closeRef={closeEditor} onClose={onClose}>
          {renderEditor(onClose)}
        </GridEditorBridge>
      ),
      editorOptions: {
        commitOnOutsideClick: false,
        closeOnExternalRowChange: false,
      },
    })),
  ];

  return (
    <section className="spreadsheet-pane" aria-label={table.name}>
      <div
        className="table-floating-actions"
        role="toolbar"
        aria-label="Table actions"
      >
        <Tooltip delay={250} closeDelay={0}>
          <Button
            isIconOnly
            size="lg"
            variant={query.where ? "primary" : "secondary"}
            aria-label="Filter"
            aria-pressed={!!query.where}
            isDisabled={!fields.length || saving}
            onPress={() => leaveEditor(() => setFilterVisible(true))}
          >
            <Filter size={20} />
          </Button>
          <Tooltip.Content placement="top">
            {query.where ? "Filter · active" : "Filter"}
          </Tooltip.Content>
        </Tooltip>
        {writable && (
          <Tooltip delay={250} closeDelay={0}>
            <Button
              isIconOnly
              size="lg"
              aria-label="Add row"
              isDisabled={saving}
              onPress={() => leaveEditor(() => setAddRow(true))}
            >
              <Plus size={22} />
            </Button>
            <Tooltip.Content placement="top">Add row</Tooltip.Content>
          </Tooltip>
        )}
      </div>
      {filterVisible && (
        <TableFilterDialog
          fields={fields}
          value={filterConditions}
          combination={filterCombination}
          onApply={applyFilters}
          onClear={() => applyFilters([], "and", undefined)}
          onClose={() => setFilterVisible(false)}
        />
      )}
      {schema.isError && (
        <p className="error-banner" role="alert">
          {schema.error.message}
          <button onClick={() => void schema.refetch()}>Retry</button>
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
          <button onClick={() => void loadWindow(windowStart)}>Retry</button>
        </p>
      )}
      {staleResults && (
        <p className="notice" role="status">
          These are previous results. Editing resumes when the current filter
          loads.
        </p>
      )}
      {(schema.data?.table.state ?? table.state) !== "active" && canEdit && (
        <p className="notice" role="status">
          This table is in maintenance. Drafts are retained; writes resume when
          the schema job finishes.
        </p>
      )}
      {accessRevoked ? (
        <div className="empty-state">
          <h2>Table access changed</h2>
          <p>
            The cached rows have been cleared. Ask your administrator to restore
            access or choose another table.
          </p>
          <Button
            onPress={() => {
              onChanged();
              void loadWindow();
            }}
          >
            Check access again
          </Button>
        </div>
      ) : schema.isPending ? (
        <div className="grid-skeleton" role="status">
          Loading table schema…
        </div>
      ) : !fields.length ? (
        <div className="empty-state">
          <Columns3 size={30} />
          <h2>{canManage ? "Define this table’s fields" : "No fields yet"}</h2>
          <p>
            {canManage
              ? "Choose typed columns and validation before entering data."
              : "An admin can define this table’s fields before you enter data."}
          </p>
          {canManage && (
            <Button onPress={() => onSettings("fields")}>Add a field</Button>
          )}
        </div>
      ) : (
        <>
          <div className="sr-only" id="grid-instructions">
            Double-click a cell to edit. Right-click for cell actions. Arrow
            keys navigate; Enter or F2 edits; Tab moves across columns; Escape
            cancels. Hold Shift to select a rectangle. Times are UTC. Date-times
            display in {preferences.timezone}.
            {copying && (
              <span role="status"> Preparing selection for copy…</span>
            )}
          </div>
          <div
            className="grid-container"
            onMouseDownCapture={(event) => {
              if (
                draft &&
                event.target instanceof Element &&
                event.target.closest('[role="columnheader"]')
              ) {
                if (saving) {
                  event.preventDefault();
                  event.stopPropagation();
                } else leaveEditor(() => {});
              }
            }}
            onPaste={(event) => {
              if (!draft) {
                event.preventDefault();
                previewPaste(event.clipboardData.getData("text/plain"));
              }
            }}
          >
            <DataGrid
              ref={gridRef}
              columns={gridColumns}
              rows={rows}
              rowKeyGetter={(row) => row.id}
              rowHeight={rowHeight}
              className="rootset-grid"
              aria-label={`${table.name} spreadsheet`}
              aria-describedby="grid-instructions"
              defaultColumnOptions={{
                resizable: view.isSuccess && !accessRevoked,
              }}
              onCellMouseDown={(args, event) => {
                extendSelection.current = event.shiftKey;
                if (draft) {
                  event.preventGridDefault();
                  leaveEditor(() => args.setActivePosition());
                }
              }}
              onCellDoubleClick={({ row, column }, event) => {
                const field = fields.find((field) => field.id === column.key);
                if (draft || saving || !field || !writable)
                  event.preventGridDefault();
                else beginEdit(row, field);
              }}
              onCellContextMenu={({ row, column, rowIdx }, event) => {
                event.preventDefault();
                event.preventGridDefault();
                const anchor = event.currentTarget;
                leaveEditor(() => {
                  focusCell(rowIdx, column.idx - 1);
                  contextAnchor.current = anchor;
                  setContextMenu(
                    column.key === "__row_number"
                      ? {}
                      : {
                          row,
                          field: fields.find(
                            (field) => field.id === column.key,
                          ),
                        },
                  );
                });
              }}
              onActivePositionChange={({ rowIdx, column }) => {
                if (rowIdx < 0 || !column || column.idx === 0) {
                  setSelection(null);
                  return;
                }
                const index = column.idx - 1;
                const extend = extendSelection.current;
                setSelection((previous) =>
                  extend && previous
                    ? { ...previous, endRow: rowIdx, endColumn: index }
                    : {
                        row: rowIdx,
                        column: index,
                        endRow: rowIdx,
                        endColumn: index,
                      },
                );
                extendSelection.current = false;
              }}
              onCellKeyDown={onKey}
              onColumnResize={(column, width) => {
                const next = {
                  ...latestViewPrefs.current,
                  columnWidths: {
                    ...latestViewPrefs.current.columnWidths,
                    [column.key]: width,
                  },
                };
                latestViewPrefs.current = next;
                viewSave.schedule(next);
              }}
              renderers={{
                renderRow: (key, props) => (
                  <DataGridRow
                    key={key}
                    {...props}
                    data-row-id={props.row.id}
                  />
                ),
                noRowsFallback: (
                  <div className="empty-state">
                    {loading
                      ? "Loading rows…"
                      : query.where
                        ? "No rows match this filter."
                        : "This table has no rows yet."}
                  </div>
                ),
              }}
            />
          </div>
        </>
      )}
      {draft && editingRow < 0 && (
        <div className="retained-cell-draft">{renderEditor()}</div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {contextMenu && (
        <Dropdown
          isOpen
          onOpenChange={(open) => {
            if (!open) setContextMenu(null);
          }}
        >
          <Dropdown.Popover triggerRef={contextAnchor} placement="bottom start">
            <Dropdown.Menu
              aria-label={contextMenu.field ? "Cell actions" : "Row navigation"}
              autoFocus="first"
              onAction={(key) => {
                const current = contextMenu;
                setContextMenu(null);
                if (key === "jump") setJumpVisible(true);
                else if (
                  key === "null" &&
                  current.row &&
                  current.field &&
                  !current.field.required &&
                  writable
                )
                  void setCellNull(current.row, current.field);
                else if (key === "history" && current.row && current.field)
                  setHistory({ row: current.row, field: current.field });
                else if (key === "delete") void deleteSelectedRow();
              }}
            >
              {contextMenu.field ? (
                <>
                  <Dropdown.Item
                    id="null"
                    isDisabled={
                      !writable || saving || contextMenu.field.required
                    }
                  >
                    Set to null
                  </Dropdown.Item>
                  <Dropdown.Item id="history">View cell history</Dropdown.Item>
                  {writable && (
                    <Dropdown.Item id="delete" isDisabled={saving}>
                      Delete row
                    </Dropdown.Item>
                  )}
                </>
              ) : (
                <Dropdown.Item
                  id="jump"
                  isDisabled={loading || currentTotal === 0}
                >
                  Go to row
                </Dropdown.Item>
              )}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
      {jumpVisible && (
        <Dialog title="Go to row" onClose={() => setJumpVisible(false)}>
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canJump || loading) return;
              setJumpVisible(false);
              void loadWindow(jump - 1);
            }}
          >
            <NumberField
              variant="secondary"
              value={jump}
              onChange={setJump}
              minValue={1}
              maxValue={
                currentTotal === undefined
                  ? undefined
                  : Math.max(1, currentTotal)
              }
              step={1}
              formatOptions={{ useGrouping: false }}
            >
              <Label>Row number</Label>
              <NumberField.Group>
                <NumberField.Input autoComplete="off" autoFocus />
              </NumberField.Group>
            </NumberField>
            <div className="action-row">
              <Button variant="secondary" onPress={() => setJumpVisible(false)}>
                Cancel
              </Button>
              <Button type="submit" isDisabled={loading || !canJump}>
                Go to row
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {history && (
        <CellHistory
          tablePath={tablePath}
          row={history.row}
          field={history.field}
          onClose={() => setHistory(null)}
          preferences={preferences}
        />
      )}
      {addRow && (
        <AddRowDialog
          fields={schema.data?.fields ?? []}
          schemaVersion={schema.data!.table.schemaVersion}
          tablePath={tablePath}
          onClose={() => setAddRow(false)}
          onCreated={() => {
            setAddRow(false);
            cache.current.clear();
            void loadWindow("last");
            onChanged();
          }}
          preferences={preferences}
        />
      )}
      {pastePreview && (
        <Dialog
          title="Review paste"
          onClose={() => {
            if (!saving) setPastePreview(null);
          }}
          wide
        >
          <p>
            {pastePreview.cells.length.toLocaleString()} rows ×{" "}
            {pastePreview.cells[0]?.length ?? 0} columns. Small pastes commit as
            one atomic batch.
          </p>
          <p>
            An unquoted empty TSV cell means null; required fields refuse it. A
            quoted empty cell preserves empty text. JSON cells use JSON values,
            including quotes around scalar strings. Review before committing.
          </p>
          <div className="paste-preview">
            <table>
              <tbody>
                {pastePreview.cells.slice(0, 10).map((line, row) => (
                  <tr key={row}>
                    {line.slice(0, 12).map((value, column) => (
                      <td key={column}>{value.slice(0, 120)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pastePreview.errors.length > 0 && (
            <ul className="error-message" role="alert">
              {pastePreview.errors.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          )}
          {pastePreview.larger ? (
            pastePreview.errors.length === 0 && (
              <PasteImport
                orgId={orgId}
                databaseId={databaseId}
                tableId={table.id}
                schemaVersion={schema.data!.table.schemaVersion}
                values={pastePreview.values}
                query={query}
                start={pastePreview.start}
                onCommitted={() => {
                  cache.current.clear();
                  void loadWindow(windowStart);
                  onChanged();
                }}
              />
            )
          ) : (
            <Button
              isDisabled={saving || pastePreview.errors.length > 0}
              onPress={() => void confirmPaste()}
            >
              {saving ? "Committing…" : "Commit paste"}
            </Button>
          )}
        </Dialog>
      )}
    </section>
  );
}

function CellHistory({
  tablePath,
  row,
  field,
  onClose,
  preferences,
}: {
  tablePath: string;
  row: Row;
  field: FieldDefinition;
  onClose: () => void;
  preferences: Preferences;
}) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const history = useQuery({
    queryKey: ["cell-history", row.id, field.id, cursor],
    queryFn: ({ signal }) =>
      client.request<{
        data: {
          id: string;
          timestamp: string;
          before: JsonValue;
          after: JsonValue;
          actor: { kind: string; id: string };
          operation: string;
        }[];
        retentionGaps: { from: string; to: string; archiveId?: string }[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(
        `${tablePath}/rows/${row.id}/cells/${field.id}/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal },
      ),
  });
  return (
    <Dialog title={`${field.name} history`} onClose={onClose} wide>
      {history.isPending ? (
        <p role="status">Loading cell history…</p>
      ) : history.isError ? (
        <p className="error-message" role="alert">
          {history.error.message}
        </p>
      ) : (
        <>
          <p>
            Values below use canonical storage values. History belongs to the
            selected cell.
          </p>
          {history.data.data.length ? (
            <ol className="history-list">
              {history.data.data.map((change) => (
                <li key={change.id}>
                  <header>
                    <time dateTime={change.timestamp}>
                      {new Intl.DateTimeFormat(preferences.locale, {
                        timeZone: preferences.timezone,
                        dateStyle: "medium",
                        timeStyle: "medium",
                      }).format(new Date(change.timestamp))}
                    </time>
                    <span>
                      {change.actor.kind} · {change.operation}
                    </span>
                  </header>
                  <div className="history-values">
                    <pre>{JSON.stringify(change.before, null, 2)}</pre>
                    <span aria-label="changed to">→</span>
                    <pre>{JSON.stringify(change.after, null, 2)}</pre>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p>No retained changes for this cell.</p>
          )}
          {history.data.retentionGaps?.map((gap, index) => (
            <p className="notice" key={index}>
              {gap.archiveId ? "Archived history" : "Retention gap"}: {gap.from}{" "}
              to {gap.to}.
              {gap.archiveId && (
                <>
                  {" "}
                  Retained archive {gap.archiveId}. Review its manifest in Table
                  settings.
                </>
              )}
            </p>
          ))}
          <footer>
            <Button
              variant="secondary"
              isDisabled={cursors.length === 1 || history.isFetching}
              onPress={() => setCursors((previous) => previous.slice(0, -1))}
            >
              Previous changes
            </Button>
            <Button
              variant="secondary"
              isDisabled={
                !history.data.hasMore ||
                !history.data.nextCursor ||
                history.isFetching
              }
              onPress={() =>
                setCursors((previous) => [...previous, history.data.nextCursor])
              }
            >
              More changes
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  );
}

function AddRowDialog({
  fields,
  schemaVersion,
  tablePath,
  onClose,
  onCreated,
  preferences,
}: {
  fields: FieldDefinition[];
  schemaVersion: number;
  tablePath: string;
  onClose: () => void;
  onCreated: () => void;
  preferences: Preferences;
}) {
  const [drafts, setDrafts] = useState<Record<string, InputDraft>>(() =>
    Object.fromEntries(
      fields.map((field) => [
        field.name,
        createCellDraft(field, field.default ?? null, preferences.timezone),
      ]),
    ),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<Record<string, string>>({});
  const attempt = useRef(new MutationAttempt());
  const submitted = useRef(false);
  async function create() {
    if (submitted.current) return;
    const errors: Record<string, string> = {};
    const values: Record<string, JsonValue> = {};
    for (const field of fields) {
      const draft = drafts[field.name]!;
      const message = validateCellDraft(field, draft, preferences.timezone);
      if (message) errors[field.name] = message;
      else
        values[field.name] = parseCellDraft(field, draft, preferences.timezone);
    }
    setValidation(errors);
    if (Object.keys(errors).length) return;
    submitted.current = true;
    setPending(true);
    setError(null);
    try {
      await client.request(`${tablePath}/rows`, {
        method: "POST",
        body: { values, expectedSchemaVersion: schemaVersion },
        idempotencyKey: attempt.current.forInput({
          values,
          expectedSchemaVersion: schemaVersion,
        }),
      });
      onCreated();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Row could not be added",
      );
    } finally {
      submitted.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog title="Add row" closeDisabled={pending} onClose={onClose} wide>
      <form
        className="form-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.ctrlKey || event.metaKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void create();
          }
        }}
      >
        <div className="add-row-fields">
          {fields.map((field, index) => {
            const draft = drafts[field.name]!;
            const feedbackId = `add-row-${field.id}-error`;
            function change(next: InputDraft) {
              setDrafts((previous) => ({ ...previous, [field.name]: next }));
              setValidation((previous) => {
                const result = { ...previous };
                delete result[field.name];
                return result;
              });
            }
            return (
              <div className="add-row-input" key={field.id}>
                <CellInput
                  field={field}
                  draft={draft}
                  onChange={change}
                  timeZone={preferences.timezone}
                  autoFocus={
                    index === 0 &&
                    typeof window !== "undefined" &&
                    window.matchMedia("(pointer: fine)").matches
                  }
                  disabled={pending}
                  invalid={!!validation[field.name]}
                  describedBy={validation[field.name] ? feedbackId : undefined}
                />
                {!field.required && field.type !== "boolean" && (
                  <Checkbox
                    aria-label={`Set ${field.name} to null`}
                    isSelected={draft.isNull}
                    isDisabled={pending}
                    onChange={(selected) =>
                      change({ ...draft, isNull: selected })
                    }
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      Set to null
                    </Checkbox.Content>
                  </Checkbox>
                )}
                {validation[field.name] && (
                  <p id={feedbackId} className="error-message" role="alert">
                    {validation[field.name]}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="action-row">
          <Button variant="secondary" isDisabled={pending} onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" isDisabled={pending}>
            {pending ? "Adding…" : error ? "Retry add row" : "Add row"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function GridEditorBridge({
  children,
  onClose,
  closeRef,
}: {
  children: ReactNode;
  onClose: () => void;
  closeRef: RefObject<(() => void) | null>;
}) {
  useEffect(() => {
    closeRef.current = onClose;
    return () => {
      closeRef.current = null;
    };
  }, [onClose, closeRef]);
  return children;
}
