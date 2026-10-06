"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { NumberField, Label } from "@heroui/react";
import { Filter, Plus, Columns3, History, Trash2 } from "./ui/icons";
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
import {
  RowWindowCache,
  columnLayout,
  visibleRange,
} from "../lib/window-cache";
import { parseTsvCells, type TsvCell } from "../lib/clipboard";
import { parsePastedCell } from "../lib/pasted-cell";
import {
  copySelectedRows,
  readSelectedWindow,
} from "../lib/clipboard-selection";
import { MutationAttempt } from "../lib/mutation-attempt";
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
  error?: string;
  conflict?: string;
  schemaConflict?: boolean;
  notice?: string;
}
const rowHeight = 44;
const windowLimit = 200;
const preferencesEmpty = {
  columnOrder: [] as string[],
  columnWidths: {} as Record<string, number>,
  frozenColumns: 0,
  hiddenColumns: [] as string[],
};

function copyCell(value: JsonValue | undefined): string {
  return value === undefined || value === null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}

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
  const [rows, setRows] = useState<Row[]>([]);
  const [query, setQuery] = useState<QuerySpec>({ limit: windowLimit });
  const [windowStart, setWindowStart] = useState(0);
  const [windowInfo, setWindowInfo] = useState<WindowResult | null>(null);
  const [displayedNavigation, setDisplayedNavigation] = useState("");
  const [loading, setLoading] = useState(false);
  const [accessRevoked, setAccessRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [viewport, setViewport] = useState({
    top: 0,
    height: 600,
    width: 1000,
  });
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
  const [draftExit, setDraftExit] = useState<(() => void) | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cache = useRef(new RowWindowCache());
  const abort = useRef<AbortController | null>(null);
  const copyAbort = useRef<AbortController | null>(null);
  const sessionId = useRef<string | undefined>(undefined);
  const cellAttempt = useRef(new MutationAttempt());
  const pasteAttempt = useRef(new MutationAttempt());
  const scrollFrame = useRef<number | null>(null);
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
  const queryDigest = JSON.stringify(query);
  const copyContext = `${tablePath}:${schema.data?.table.schemaVersion}:${queryDigest}:${JSON.stringify(selection)}:${rows.map((row) => `${row.id}:${row.version}`).join("|")}`;
  const navigationDigest = JSON.stringify({
    where: query.where,
    orderBy: query.orderBy,
  });
  const staleResults = !!windowInfo && displayedNavigation !== navigationDigest;
  const fields = useMemo(() => schema.data?.fields ?? [], [schema.data]);
  const widths = useMemo(
    () =>
      fields.map(
        (field) =>
          viewPrefs.columnWidths[field.id] ??
          (field.type === "json" ? 240 : 180),
      ),
    [fields, viewPrefs.columnWidths],
  );
  const visible = visibleRange(
    viewport.top,
    viewport.height,
    rowHeight,
    rows.length,
  );
  const columns = useMemo(
    () => columnLayout(widths, viewPrefs.frozenColumns),
    [widths, viewPrefs.frozenColumns],
  );
  const gridWidth = widths.reduce((total, width) => total + width, 52);
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
    if (view.data) setViewPrefs(view.data.preferences);
  }, [view.data]);
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
        const element = gridRef.current;
        const cells = element?.querySelectorAll('[role="gridcell"]');
        if (
          !element ||
          !cells?.length ||
          !element.getClientRects().length ||
          Array.from(cells).some(
            (cell) => cell.getAttribute("data-cell-loaded") !== "true",
          )
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
            columns: columns.length,
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
    columns.length,
    loading,
    staleResults,
    accessRevoked,
  ]);
  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setViewport((previous) => ({
          ...previous,
          height: entry.contentRect.height,
          width: entry.contentRect.width,
        }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [schema.data?.fields.length]);

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
          setSelection(
            first < 0 || last < 0
              ? null
              : { ...selected, row: first, endRow: last },
          );
        }
        cache.current.set({
          key,
          start,
          rows: response.data,
          nextCursor: response.page.nextCursor,
        });
        if (gridRef.current) {
          gridRef.current.scrollTop = 0;
          setViewport((previous) => ({ ...previous, top: 0 }));
        }
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
  useEffect(
    () => () => {
      if (scrollFrame.current !== null)
        cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );

  async function saveView(next: typeof preferencesEmpty) {
    setViewPrefs(next);
    try {
      await client.operation("updateViewPreferences", {
        tableId: table.id,
        preferences: next,
      });
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
      setError(
        failure instanceof Error
          ? failure.message
          : "View preferences could not be saved",
      );
    }
  }

  function preserveDraft(action: () => void) {
    if (draft) setDraftExit(() => action);
    else action();
  }

  function focusCell(row: number, column: number, extend = false) {
    if (!rows.length || !fields.length) return;
    const nextRow = Math.max(0, Math.min(rows.length - 1, row));
    const nextColumn = Math.max(0, Math.min(fields.length - 1, column));
    setSelection((previous) =>
      extend && previous
        ? { ...previous, endRow: nextRow, endColumn: nextColumn }
        : {
            row: nextRow,
            column: nextColumn,
            endRow: nextRow,
            endColumn: nextColumn,
          },
    );
    const field = fields[nextColumn]!;
    setAnnouncement(
      `Row ${windowStart + nextRow + 1}, ${field.name}, ${formatCellValue(field, rows[nextRow]!.values[field.name] ?? null, { timeZone: preferences.timezone, locale: preferences.locale, dateFormat: preferences.dateFormat, timeFormat: preferences.timeFormat })}`,
    );
    const element = gridRef.current;
    if (element) {
      const top = nextRow * rowHeight;
      const left = widths
        .slice(0, nextColumn)
        .reduce((sum, width) => sum + width, 52);
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + rowHeight > element.scrollTop + element.clientHeight - 38)
        element.scrollTop = top + rowHeight - element.clientHeight + 38;
      if (nextColumn >= viewPrefs.frozenColumns) {
        const pinnedWidth = widths
          .slice(0, viewPrefs.frozenColumns)
          .reduce((sum, width) => sum + width, 52);
        if (left < element.scrollLeft + pinnedWidth)
          element.scrollLeft = left - pinnedWidth;
        else if (
          left + widths[nextColumn]! >
          element.scrollLeft + element.clientWidth
        )
          element.scrollLeft = left + widths[nextColumn]! - element.clientWidth;
      }
      element.focus();
    }
  }

  function editCell(row: number, column: number, initialInput?: string) {
    const selectedRow = rows[row],
      field = fields[column];
    if (!selectedRow || !field || !writable) return;
    if (!Object.hasOwn(selectedRow.values, field.name)) {
      setError(
        "This column is loading. Wait for the current window, then edit the cell.",
      );
      return;
    }
    setDraft({
      row: selectedRow,
      field,
      ...(initialInput !== undefined ? { initialInput } : {}),
    });
    focusCell(row, column);
  }

  async function commitCell(value: JsonValue) {
    if (!draft || saving) return;
    if (draft.schemaConflict) return;
    if (!writable) {
      setDraft((previous) =>
        previous
          ? {
              ...previous,
              error:
                "This table is currently read-only. Your draft is still here.",
            }
          : null,
      );
      return;
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
      gridRef.current?.focus();
      onChanged();
      if (
        query.where ||
        query.orderBy?.some(
          (sort) =>
            sort.field === draft.field.name || sort.field === draft.field.id,
        )
      )
        void loadWindow(windowStart);
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
      setDraft((previous) =>
        previous
          ? {
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
            }
          : null,
      );
    } finally {
      setSaving(false);
    }
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (draft) return;
    const current = selection ?? { row: 0, column: 0, endRow: 0, endColumn: 0 };
    if (
      ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab"].includes(
        event.key,
      )
    ) {
      event.preventDefault();
      let row = current.endRow,
        column = current.endColumn;
      if (event.key === "ArrowDown") row++;
      if (event.key === "ArrowUp") row--;
      if (event.key === "ArrowLeft") column--;
      if (event.key === "ArrowRight") column++;
      if (event.key === "Tab") {
        column += event.shiftKey ? -1 : 1;
        if (column >= fields.length) {
          column = 0;
          row++;
        }
        if (column < 0) {
          column = fields.length - 1;
          row--;
        }
      }
      focusCell(row, column, event.shiftKey && event.key !== "Tab");
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      editCell(current.row, current.column);
    } else if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      editCell(current.row, current.column, event.key);
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c"
    ) {
      event.preventDefault();
      void copySelection();
    } else if (event.key === "Home") {
      event.preventDefault();
      focusCell(event.ctrlKey || event.metaKey ? 0 : current.row, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusCell(
        event.ctrlKey || event.metaKey ? rows.length - 1 : current.row,
        fields.length - 1,
      );
    } else if (event.key === "Escape") setSelection(null);
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
    preserveDraft(() => {
      setQuery({ limit: windowLimit, ...(where ? { where } : {}) });
      setFilterConditions(conditions);
      setFilterCombination(combination);
      setFilterVisible(false);
    });
  }

  return (
    <section className="spreadsheet-pane" aria-labelledby="table-title">
      <header className="table-header">
        <div>
          <h1 id="table-title">{table.name}</h1>
        </div>
        <div className="action-row" role="toolbar" aria-label="Table actions">
          <Button
            variant="secondary"
            isDisabled={!fields.length}
            onPress={() => preserveDraft(() => setFilterVisible(true))}
          >
            <Filter size={15} />
            Filter{query.where ? " · active" : ""}
          </Button>
          {writable && (
            <Button onPress={() => setAddRow(true)}>
              <Plus size={17} />
              Add row
            </Button>
          )}
        </div>
      </header>
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
            Tap a cell to edit. Arrow keys navigate; Enter or F2 edits; Tab
            moves across columns; Escape cancels. Hold Shift to select a
            rectangle. Times are UTC. Date-times display in{" "}
            {preferences.timezone}.
            {copying && (
              <span role="status"> Preparing selection for copy…</span>
            )}
          </div>
          <div
            className="grid-viewport"
            ref={gridRef}
            role="grid"
            aria-label={`${table.name} spreadsheet`}
            aria-rowcount={currentTotal === undefined ? -1 : currentTotal + 1}
            aria-colcount={fields.length}
            aria-describedby="grid-instructions"
            aria-busy={loading}
            tabIndex={0}
            aria-activedescendant={
              selection
                ? `cell-${rows[selection.endRow]?.id}-${fields[selection.endColumn]?.id}`
                : undefined
            }
            onKeyDown={onKey}
            data-cache-windows={cache.current.size}
            data-cache-bytes={cache.current.byteSize}
            onPaste={(event) => {
              if (!draft) {
                event.preventDefault();
                previewPaste(event.clipboardData.getData("text/plain"));
              }
            }}
            onScroll={(event) => {
              const element = event.currentTarget;
              if (
                element.scrollTop === viewport.top ||
                scrollFrame.current !== null
              )
                return;
              scrollFrame.current = requestAnimationFrame(() => {
                scrollFrame.current = null;
                setViewport((previous) => ({
                  ...previous,
                  top: element.scrollTop,
                }));
              });
            }}
          >
            <div
              className="grid-canvas"
              style={{
                width: Math.max(gridWidth, viewport.width),
                height: 38 + rows.length * rowHeight,
              }}
            >
              <div
                className="grid-header"
                role="row"
                aria-rowindex={1}
                style={{ width: Math.max(gridWidth, viewport.width) }}
              >
                <div className="row-header column-number" aria-hidden="true">
                  #
                </div>
                {columns.map(({ index, left, width, frozen }) => {
                  const field = fields[index]!;
                  return (
                    <div
                      className={`column-header ${frozen ? "frozen" : ""}`}
                      key={field.id}
                      role="columnheader"
                      aria-colindex={index + 1}
                      style={{
                        left: frozen ? 52 + left : undefined,
                        width,
                      }}
                    >
                      <span title={`${field.name} · ${field.type}`}>
                        {field.name}
                        <small>
                          {field.type === "time" ? "UTC time" : field.type}
                        </small>
                      </span>
                      <span
                        className="column-resizer"
                        role="separator"
                        aria-label={`Resize ${field.name}`}
                        aria-orientation="vertical"
                        aria-valuenow={width}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (
                            event.key === "ArrowLeft" ||
                            event.key === "ArrowRight"
                          ) {
                            event.preventDefault();
                            void saveView({
                              ...viewPrefs,
                              columnWidths: {
                                ...viewPrefs.columnWidths,
                                [field.id]: Math.max(
                                  80,
                                  Math.min(
                                    2000,
                                    width +
                                      (event.key === "ArrowRight" ? 20 : -20),
                                  ),
                                ),
                              },
                            });
                          }
                        }}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.currentTarget.setPointerCapture(
                            event.pointerId,
                          );
                          const startX = event.clientX;
                          const target = event.currentTarget;
                          let nextWidth = width;
                          function move(pointer: PointerEvent) {
                            nextWidth = Math.max(
                              80,
                              Math.min(2000, width + pointer.clientX - startX),
                            );
                            setViewPrefs((previous) => ({
                              ...previous,
                              columnWidths: {
                                ...previous.columnWidths,
                                [field.id]: nextWidth,
                              },
                            }));
                          }
                          function end() {
                            target.removeEventListener("pointermove", move);
                            target.removeEventListener("pointerup", end);
                            void saveView({
                              ...viewPrefs,
                              columnWidths: {
                                ...viewPrefs.columnWidths,
                                [field.id]: nextWidth,
                              },
                            });
                          }
                          target.addEventListener("pointermove", move);
                          target.addEventListener("pointerup", end, {
                            once: true,
                          });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              {rows.slice(visible.start, visible.end).map((row, index) => {
                const rowIndex = visible.start + index;
                return (
                  <div
                    className="grid-row"
                    key={row.id}
                    role="row"
                    aria-rowindex={windowStart + rowIndex + 2}
                    style={{
                      top: 38 + rowIndex * rowHeight,
                      width: Math.max(gridWidth, viewport.width),
                      height: rowHeight,
                    }}
                  >
                    <div className="row-header" role="rowheader">
                      {windowStart + rowIndex + 1}
                    </div>
                    {columns.map(
                      ({ index: columnIndex, left, width, frozen }) => {
                        const field = fields[columnIndex]!;
                        const selected =
                          selection &&
                          rowIndex >=
                            Math.min(selection.row, selection.endRow) &&
                          rowIndex <=
                            Math.max(selection.row, selection.endRow) &&
                          columnIndex >=
                            Math.min(selection.column, selection.endColumn) &&
                          columnIndex <=
                            Math.max(selection.column, selection.endColumn);
                        const value = row.values[field.name] ?? null;
                        return (
                          <div
                            id={`cell-${row.id}-${field.id}`}
                            className={`grid-cell ${selected ? "selected" : ""} ${frozen ? "frozen" : ""} ${field.type === "integer" || field.type === "float" ? "numeric" : ""} ${value === null ? "null-cell" : ""}`}
                            key={field.id}
                            role="gridcell"
                            data-cell-loaded={Object.hasOwn(
                              row.values,
                              field.name,
                            )}
                            aria-colindex={columnIndex + 1}
                            aria-selected={!!selected}
                            aria-readonly={!writable}
                            style={{
                              left: frozen ? 52 + left : undefined,
                              width,
                              height: rowHeight,
                            }}
                            onClick={(event) => {
                              if (event.shiftKey)
                                focusCell(rowIndex, columnIndex, true);
                              else if (writable)
                                editCell(rowIndex, columnIndex);
                              else focusCell(rowIndex, columnIndex);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              focusCell(rowIndex, columnIndex);
                              setHistory({ row, field });
                            }}
                          >
                            {!Object.hasOwn(row.values, field.name)
                              ? "Loading…"
                              : formatCellValue(field, value, {
                                  timeZone: preferences.timezone,
                                  locale: preferences.locale,
                                  dateFormat: preferences.dateFormat,
                                  timeFormat: preferences.timeFormat,
                                })}
                          </div>
                        );
                      },
                    )}
                  </div>
                );
              })}
            </div>
            {!rows.length && !loading && (
              <div className="empty-grid">
                <p>
                  {query.where
                    ? "No rows match this filter."
                    : "This table has no rows yet."}
                </p>
                {writable && (
                  <Button onPress={() => setAddRow(true)}>Add first row</Button>
                )}
              </div>
            )}
          </div>
          <footer className="grid-footer">
            <form
              className="jump-control"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canJump || loading) return;
                preserveDraft(() => void loadWindow(jump - 1));
              }}
            >
              <NumberField
                className="jump-field"
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
                isDisabled={loading || currentTotal === 0}
              >
                <Label>Go to row</Label>
                <NumberField.Group>
                  <NumberField.Input autoComplete="off" />
                </NumberField.Group>
              </NumberField>
              <Button
                type="submit"
                variant="secondary"
                isDisabled={loading || !canJump}
              >
                Go
              </Button>
            </form>
            <span className="live-status" role="status">
              {loading
                ? "Loading…"
                : error || staleResults
                  ? "Previous results"
                  : "Live view"}
            </span>
            {selection && (
              <div className="selection-actions">
                <button
                  className="icon-button"
                  aria-label="Show selected cell history"
                  onClick={() =>
                    setHistory({
                      row: rows[selection.row]!,
                      field: fields[selection.column]!,
                    })
                  }
                >
                  <History size={17} />
                </button>
                {writable && (
                  <button
                    className="icon-button danger-text"
                    aria-label="Delete selected row"
                    disabled={saving}
                    onClick={() => void deleteSelectedRow()}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            )}
          </footer>
        </>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {draft && (
        <Dialog
          title={`Edit ${draft.field.name}`}
          closeDisabled={saving}
          onClose={() => {
            if (!saving) {
              setDraft(null);
              gridRef.current?.focus();
            }
          }}
          wide={draft.field.type === "json"}
        >
          <CellEditor
            field={draft.field}
            value={draft.row.values[draft.field.name] ?? null}
            initialInput={draft.initialInput}
            timeZone={preferences.timezone}
            locale={preferences.locale}
            onCommit={commitCell}
            onCancel={() => {
              setDraft(null);
              gridRef.current?.focus();
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
      {draftExit && (
        <Dialog title="Keep your draft?" onClose={() => setDraftExit(null)}>
          <p>
            A cell has an unsaved draft. Save or cancel it before changing the
            view.
          </p>
          <Button variant="secondary" onPress={() => setDraftExit(null)}>
            Continue editing
          </Button>
          <Button
            onPress={() => {
              const action = draftExit;
              setDraft(null);
              setDraftExit(null);
              action();
            }}
          >
            Discard draft and continue
          </Button>
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
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const [editing, setEditing] = useState<FieldDefinition | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(new MutationAttempt());
  async function create() {
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
      setPending(false);
    }
  }
  return (
    <Dialog
      title="Add row"
      closeDisabled={pending}
      onClose={() => {
        if (!pending) onClose();
      }}
      wide
    >
      {editing ? (
        <CellEditor
          field={editing}
          value={values[editing.name] ?? editing.default ?? null}
          timeZone={preferences.timezone}
          locale={preferences.locale}
          onCommit={(value) => {
            setValues((previous) => ({ ...previous, [editing.name]: value }));
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <>
          <p>
            Omitted fields use their configured defaults. Set an explicit null
            by opening a field and clearing it.
          </p>
          <div className="add-row-fields">
            {fields.map((field) => (
              <button
                key={field.id}
                className="add-row-field"
                onClick={() => setEditing(field)}
              >
                <span>
                  {field.name}
                  {field.required ? " *" : ""}
                  <small>{field.type}</small>
                </span>
                <strong>
                  {field.name in values
                    ? formatCellValue(field, values[field.name] ?? null, {
                        timeZone: preferences.timezone,
                        locale: preferences.locale,
                      })
                    : field.default !== undefined
                      ? `Default: ${copyCell(field.default)}`
                      : "Not set"}
                </strong>
              </button>
            ))}
          </div>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <footer className="action-row">
            <Button variant="secondary" isDisabled={pending} onPress={onClose}>
              Cancel
            </Button>
            <Button isDisabled={pending} onPress={() => void create()}>
              {pending ? "Adding…" : "Add row"}
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  );
}
