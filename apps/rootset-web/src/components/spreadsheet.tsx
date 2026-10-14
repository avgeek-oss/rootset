"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  type SortColumn,
  type DataGridHandle,
  type CellKeyDownArgs,
  type CellKeyboardEvent,
} from "react-data-grid";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { Pagination } from "@avgeek-oss/design-system/navigation/pagination";
import {
  ResourceName,
  ResourceTable,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { Dropdown, Tooltip } from "@heroui/react";
import {
  Filter,
  Columns3,
  Eraser,
  History,
  Trash2,
  MessageSquare,
} from "./ui/icons";
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
import { mergeScrollWindow } from "../lib/scroll-window";
import { RowWindowCache } from "../lib/window-cache";
import { parseTsvCells, type TsvCell } from "../lib/clipboard";
import { parsePastedCell } from "../lib/pasted-cell";
import {
  copySelectedRows,
  readSelectedWindow,
} from "../lib/clipboard-selection";
import { MutationAttempt } from "../lib/mutation-attempt";
import { DebouncedSave } from "../lib/debounced-save";
import { CellUndoStack } from "../lib/cell-undo";
import { CellEditor, formatCellValue } from "./cells";
import { ImageCell } from "./cells/ImageCell";
import { Dialog } from "./dialog";
import { RowComments, useRowCommentCounts } from "./row-comments";
import { useConfirmation } from "./settings/ui";
import { FieldTypeIcon } from "./settings/field-type-options";
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
}
const rowHeight = 32;
const windowLimit = 200;
const systemColumns = 2;
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
  const confirmation = useConfirmation();
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
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [history, setHistory] = useState<{
    row: Row;
    field: FieldDefinition;
  } | null>(null);
  const [discussion, setDiscussion] = useState<{
    rowId: string;
    rowNumber: number;
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
  } | null>(null);
  const [filterVisible, setFilterVisible] = useState(false);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>(
    [],
  );
  const [filterCombination, setFilterCombination] =
    useState<FilterCombination>("and");
  const [contextMenu, setContextMenu] = useState<{
    row?: Row;
    field?: FieldDefinition;
  } | null>(null);
  const contextAnchor = useRef<Element | null>(null);
  const gridRef = useRef<DataGridHandle>(null);
  const gridContainer = useRef<HTMLDivElement>(null);
  const commentCounts = useRowCommentCounts(
    { orgId, databaseId, tableId: table.id },
    rows,
    gridContainer,
    !accessRevoked,
  );
  const countsByRow = new Map(
    commentCounts.data?.data.map((item) => [item.rowId, item.count]),
  );
  const resizingColumn = useRef(false);
  const resizeScrollLimit = useRef<number | null>(null);
  function releaseResizeSpace(grid: HTMLElement) {
    if (
      !resizingColumn.current &&
      resizeScrollLimit.current !== null &&
      grid.scrollLeft <= resizeScrollLimit.current
    ) {
      grid.style.removeProperty("--rs-resize-scroll-width");
      resizeScrollLimit.current = null;
    }
  }
  const scrollOffset = useRef<number | null>(null);
  const fetchingWindow = useRef(false);
  const tailCursor = useRef<string | null>(null);
  const hasNextWindow = useRef(false);
  useLayoutEffect(() => {
    if (scrollOffset.current === null) return;
    const grid =
      gridContainer.current?.querySelector<HTMLElement>('[role="grid"]');
    if (grid) grid.scrollTop = scrollOffset.current;
    scrollOffset.current = null;
  }, [rows]);
  const closeEditor = useRef<(() => void) | null>(null);
  const submitEditor = useRef<(() => Promise<boolean>) | null>(null);
  const extendSelection = useRef(false);
  const cache = useRef(new RowWindowCache());
  const abort = useRef<AbortController | null>(null);
  const copyAbort = useRef<AbortController | null>(null);
  const sessionId = useRef<string | undefined>(undefined);
  const cellAttempt = useRef(new MutationAttempt());
  const pasteAttempt = useRef(new MutationAttempt());
  const undoAttempt = useRef(new MutationAttempt());
  const undoStack = useRef(new CellUndoStack());
  const undoing = useRef(false);
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
  const writable =
    canEdit &&
    !accessRevoked &&
    !staleResults &&
    (!windowInfo ||
      windowInfo.schemaVersion === schema.data?.table.schemaVersion) &&
    (schema.data?.table.state ?? table.state) === "active";

  useEffect(() => {
    undoStack.current.clear();
    undoAttempt.current.clear();
  }, [tablePath, schema.data?.table.schemaVersion, accessRevoked, canEdit]);

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
      direction?: "next" | "previous",
    ) => {
      if (direction && fetchingWindow.current) return;
      fetchingWindow.current = true;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const key = `${table.id}:${schema.data?.table.schemaVersion}:${queryDigest}:${String(position)}:${cursor ?? ""}`;
      const cached = cache.current.get(key);
      if (cached && !direction && typeof position === "number") {
        setRows(cached.rows);
        setWindowStart(cached.start);
      }
      setLoading(true);
      setError(null);
      try {
        const requestLimit =
          direction === "previous" && typeof position === "number"
            ? Math.min(windowLimit, currentStart.current - position)
            : windowLimit;
        let response: WindowResult =
          direction === "next" && cursor
            ? await client.operation<QueryResult>(
                "queryRows",
                {
                  orgId,
                  databaseId,
                  tableId: table.id,
                  query: { ...query, limit: requestLimit, cursor },
                },
                { signal: controller.signal },
              )
            : await client.request<WindowResult>(
                `/tables/${table.id}/windows/query`,
                {
                  method: "POST",
                  body: {
                    orgId,
                    databaseId,
                    query: {
                      ...query,
                      limit: requestLimit,
                      ...(cursor ? { cursor } : {}),
                    },
                    position: position === 0 ? "first" : position,
                    ...(sessionId.current
                      ? { sessionId: sessionId.current }
                      : {}),
                  },
                  signal: controller.signal,
                },
              );
        if (controller.signal.aborted) return;
        setAccessRevoked(false);
        const start =
          response.window?.start ??
          (typeof position === "number" ? position : 0);
        if (direction === "previous") {
          const needed = Math.min(requestLimit, currentStart.current - start);
          while (response.data.length < needed && response.page.nextCursor) {
            const page = await client.operation<QueryResult>(
              "queryRows",
              {
                orgId,
                databaseId,
                tableId: table.id,
                query: {
                  ...query,
                  limit: needed - response.data.length,
                  cursor: response.page.nextCursor,
                },
              },
              { signal: controller.signal },
            );
            response = {
              ...response,
              data: [...response.data, ...page.data],
              page: page.page,
            };
          }
          if (controller.signal.aborted) return;
        }
        if (response.window?.sessionId)
          sessionId.current = response.window.sessionId;
        const previousRows = currentRows.current;
        const merged = direction
          ? mergeScrollWindow(
              currentRows.current,
              currentStart.current,
              response.data,
              start,
              direction,
            )
          : { rows: response.data, start, offset: 0, trimmed: 0 };
        if (direction) {
          const grid =
            gridContainer.current?.querySelector<HTMLElement>('[role="grid"]');
          scrollOffset.current = Math.max(
            0,
            (grid?.scrollTop ?? 0) + merged.offset * rowHeight,
          );
        }
        currentRows.current = merged.rows;
        currentStart.current = merged.start;
        setRows(merged.rows);
        setWindowStart(merged.start);
        if (!direction || direction === "next")
          hasNextWindow.current = response.page.hasMore;
        else if (merged.trimmed) hasNextWindow.current = true;
        setWindowInfo(response);
        if (response.schemaVersion !== schema.data?.table.schemaVersion)
          void schema.refetch();
        setDisplayedNavigation(
          JSON.stringify({ where: query.where, orderBy: query.orderBy }),
        );
        const selected = currentSelection.current;
        if (selected) {
          const firstId = previousRows[selected.row]?.id;
          const lastId = previousRows[selected.endRow]?.id;
          const first = merged.rows.findIndex((row) => row.id === firstId);
          const last = merged.rows.findIndex((row) => row.id === lastId);
          const nextSelection =
            first < 0 || last < 0
              ? null
              : { ...selected, row: first, endRow: last };
          if (!closeEditor.current)
            gridRef.current?.setActivePosition(
              {
                rowIdx: nextSelection?.row ?? -1,
                idx: nextSelection ? nextSelection.column + systemColumns : 0,
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
        tailCursor.current = cache.current.cursorAfter(
          merged.start + merged.rows.length,
        );
        if (!direction) gridRef.current?.scrollToCell({ rowIdx: 0 });
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
          setDraft(null);
        }
        if (!(failure instanceof Error && failure.name === "AbortError"))
          setError(
            failure instanceof Error
              ? failure.message
              : "Rows could not be loaded",
          );
      } finally {
        if (!controller.signal.aborted) {
          fetchingWindow.current = false;
          setLoading(false);
        }
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
    if (draft) await submitEditor.current?.();
    action();
  }

  function focusCell(row: number, column: number) {
    gridRef.current?.setActivePosition(
      { rowIdx: row, idx: column + systemColumns },
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
    if (!draft || saving) return false;
    if (!writable) {
      toast.danger("This table is currently read-only.");
      setDraft(null);
      return false;
    }
    if (
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
      undoStack.current.record(schema.data!.table.schemaVersion, [
        { before: draft.row, after: updated, fields: [draft.field.name] },
      ]);
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
          /* Keep the last loaded value when the current row cannot be read. */
        }
      }
      if (current)
        setRows((previous) =>
          previous.map((row) => (row.id === current!.id ? current! : row)),
        );
      setDraft(null);
      cellAttempt.current.clear();
      cache.current.clear();
      toast.danger(
        failure instanceof Error
          ? failure.message
          : "The value could not be saved.",
      );
      if (
        failure instanceof ApiError &&
        failure.code === "SCHEMA_VERSION_CONFLICT"
      )
        void schema.refetch();
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function setCellNull(row: Row, field: FieldDefinition) {
    await commitCell(null, { row, field, initialValue: null });
  }

  async function undoChange() {
    if (saving || undoing.current || draft || !writable) return;
    const change = undoStack.current.latest;
    if (!change) {
      toast("No changes to undo.");
      return;
    }
    undoing.current = true;
    setSaving(true);
    try {
      const input = {
        orgId,
        databaseId,
        tableId: table.id,
        expectedSchemaVersion: change.schemaVersion,
        mutations: change.rows.map(({ rowId, expectedVersion, values }) => ({
          type: "update" as const,
          rowId,
          expectedVersion,
          values,
        })),
      };
      const outcome = await client.operation<{
        results: { row?: Row }[];
      }>("mutateRows", input, {
        idempotencyKey: undoAttempt.current.forInput(input),
      });
      const restored = outcome.results.flatMap(({ row }) => (row ? [row] : []));
      undoStack.current.complete(change, restored);
      undoAttempt.current.clear();
      setRows((previous) =>
        previous.map(
          (row) => restored.find((next) => next.id === row.id) ?? row,
        ),
      );
      cache.current.clear();
      if (query.where || query.orderBy?.length) void loadWindow(windowStart);
      onChanged();
      toast.success("Last change undone.");
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        ["ROW_VERSION_CONFLICT", "RESOURCE_NOT_FOUND"].includes(failure.code)
      ) {
        undoStack.current.forgetRows(change.rows.map((row) => row.rowId));
        undoAttempt.current.clear();
        void loadWindow(windowStart);
        toast.danger("Cannot undo: a row has changed or been deleted.");
      } else {
        if (failure instanceof ApiError) {
          if (failure.code === "SCHEMA_VERSION_CONFLICT") {
            undoStack.current.clear();
            undoAttempt.current.clear();
            void schema.refetch();
          } else if ([401, 403].includes(failure.status)) {
            cache.current.clear();
            setRows([]);
            setWindowInfo(null);
            setSelection(null);
            setAccessRevoked(true);
          }
        }
        toast.danger(
          failure instanceof Error
            ? failure.message
            : "Could not undo the change.",
        );
      }
    } finally {
      undoing.current = false;
      setSaving(false);
    }
  }

  function onKey(args: CellKeyDownArgs<Row>, event: CellKeyboardEvent) {
    if (args.mode === "EDIT") {
      event.preventGridDefault();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "z"
    ) {
      event.preventDefault();
      event.preventGridDefault();
      if (!event.repeat) void undoChange();
      return;
    }
    const { row, column, rowIdx } = args;
    if (!row || !column || rowIdx < 0) return;
    if (column.key === "__comments") {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        event.preventGridDefault();
        leaveEditor(() =>
          setDiscussion({ rowId: row.id, rowNumber: windowStart + rowIdx + 1 }),
        );
      }
      return;
    }
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
          ? { row }
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
    const operations: {
      kind: "update";
      rowId: string;
      expectedVersion: string;
      values: Record<string, JsonValue>;
    }[] = [];
    if (cells.some((line) => line.length !== cells[0]?.length))
      errors.push("The pasted selection must be rectangular.");
    if (
      cells.length > limits.mutationBatch ||
      cells.length + selection.row > rows.length
    ) {
      toast.danger(
        `Paste must fit within the loaded rows and contain at most ${limits.mutationBatch.toLocaleString()} rows.`,
      );
      return;
    }
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
      if (row)
        operations.push({
          kind: "update",
          rowId: row.id,
          expectedVersion: row.version,
          values,
        });
    });
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
    if (
      new TextEncoder().encode(JSON.stringify(input)).byteLength >
      limits.requestBytes
    ) {
      toast.danger("Paste is too large. Use a smaller selection.");
      return;
    }

    setPastePreview({
      cells,
      errors: errors.slice(0, 50),
      operations,
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
      const before = rows;
      const outcome = await client.operation<{
        results: { row?: Row }[];
      }>("mutateRows", input, {
        idempotencyKey: pasteAttempt.current.forInput(input),
      });
      undoStack.current.record(
        input.expectedSchemaVersion,
        outcome.results.flatMap(({ row: after }) => {
          const previous = before.find((row) => row.id === after?.id);
          const mutation = input.mutations.find(
            (row) => row.rowId === after?.id,
          );
          return after && previous && mutation
            ? [
                {
                  before: previous,
                  after,
                  fields: Object.keys(mutation.values),
                },
              ]
            : [];
        }),
      );
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

  async function deleteRow(row: Row) {
    if (!writable || saving) return;
    setDeleteTargetId(row.id);
    let confirmed: boolean;
    try {
      confirmed = await confirmation.confirm(
        `Delete row ${windowStart + rows.findIndex((candidate) => candidate.id === row.id) + 1}?`,
        "Delete this row and its cell history? This cannot be undone.",
        "Delete row",
      );
    } finally {
      setDeleteTargetId(null);
    }
    if (!confirmed) return;
    setSaving(true);
    try {
      await client.request(`${tablePath}/rows/${row.id}`, {
        method: "DELETE",
        headers: { "If-Match": `\"${row.id}:${row.version}\"` },
        body: { expectedSchemaVersion: schema.data!.table.schemaVersion },
      });
      undoStack.current.forgetRows([row.id]);
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
      setQuery((current) => ({
        limit: windowLimit,
        ...(current.orderBy ? { orderBy: current.orderBy } : {}),
        ...(where ? { where } : {}),
      }));
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
            onClose?.();
            if (saved) {
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
        />
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
      width: Math.max(
        52,
        String(Math.max(table.rowCount, windowStart + rows.length)).length * 9 +
          32,
      ),
      cellClass: "row-number-cell",
      frozen: true,
      resizable: false,
      renderCell: ({ rowIdx }) => windowStart + rowIdx + 1,
    },
    {
      key: "__comments",
      name: (
        <span aria-label="Comments" title="Comments">
          <MessageSquare />
        </span>
      ),
      width: 64,
      frozen: true,
      resizable: false,
      sortable: false,
      cellClass: "row-comment-cell",
      renderCell: ({ row, rowIdx, tabIndex }) => {
        const count = countsByRow.get(row.id);
        const openDiscussion = () =>
          leaveEditor(() =>
            setDiscussion({
              rowId: row.id,
              rowNumber: windowStart + rowIdx + 1,
            }),
          );
        return (
          <button
            type="button"
            className="row-comment-trigger"
            tabIndex={tabIndex}
            aria-label={`Row ${windowStart + rowIdx + 1} comments${count === undefined ? "" : `, ${count}`}`}
            disabled={accessRevoked || staleResults}
            onClick={openDiscussion}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                openDiscussion();
              }
            }}
          >
            <MessageSquare size={14} />
            <span>
              {count === undefined
                ? commentCounts.isError
                  ? "?"
                  : "…"
                : count > 999
                  ? "999+"
                  : count}
            </span>
          </button>
        );
      },
    },
    ...fields.map((field, index): Column<Row> => ({
      key: field.id,
      name: (
        <Tooltip delay={250} closeDelay={0}>
          <Tooltip.Trigger
            tabIndex={-1}
            className="inline-flex max-w-full items-center gap-1.5 align-middle"
          >
            <FieldTypeIcon type={field.type} size={14} />
            <span className="truncate">{field.name}</span>
          </Tooltip.Trigger>
          <Tooltip.Content placement="top">
            {field.type === "time" ? "UTC time" : field.type}
            {field.required ? " · required" : ""}
          </Tooltip.Content>
        </Tooltip>
      ),
      sortable: field.type !== "json" && !accessRevoked && !saving,
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
        <span
          data-cell-loaded={Object.hasOwn(row.values, field.name)}
          className={
            field.type === "boolean" &&
            typeof row.values[field.name] === "boolean"
              ? `cell-boolean-${row.values[field.name]}`
              : undefined
          }
        >
          {!Object.hasOwn(row.values, field.name) ? null : field.type ===
              "image" && typeof row.values[field.name] === "string" ? (
            <ImageCell
              key={String(row.values[field.name])}
              src={String(row.values[field.name])}
              name={field.name}
            />
          ) : (
            formatCellValue(field, row.values[field.name] ?? null, {
              timeZone: preferences.timezone,
              locale: preferences.locale,
              dateFormat: preferences.dateFormat,
              timeFormat: preferences.timeFormat,
            })
          )}
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
      {commentCounts.isError && (
        <div className="error-banner" role="status">
          Comment counts are unavailable.
          <button onClick={() => void commentCounts.refetch()}>
            Retry counts
          </button>
        </div>
      )}
      {discussion && (
        <RowComments
          key={discussion.rowId}
          target={{
            orgId,
            databaseId,
            tableId: table.id,
            rowId: discussion.rowId,
          }}
          rowNumber={discussion.rowNumber}
          canCreate={canEdit && !accessRevoked}
          locale={preferences.locale}
          timeZone={preferences.timezone}
          onClose={() => setDiscussion(null)}
        />
      )}
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
        <div className="grid-skeleton" role="status"></div>
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
            display in {preferences.timezone}. Command-Z or Control-Z undoes the
            last saved cell change. Undo is available during this table session.
            {copying && (
              <span role="status"> Preparing selection for copy…</span>
            )}
          </div>
          <div
            className="grid-container"
            ref={gridContainer}
            onPointerDownCapture={(event) => {
              const target = event.target;
              if (
                !(target instanceof HTMLElement) ||
                !target.closest('[role="columnheader"]') ||
                getComputedStyle(target).cursor !== "col-resize"
              )
                return;
              const grid = gridRef.current?.element;
              if (!grid) return;
              // Preserve the scroll range so shrinking at the right edge cannot move the handle.
              resizingColumn.current = true;
              grid.style.setProperty(
                "--rs-resize-scroll-width",
                `${grid.scrollWidth}px`,
              );
            }}
            onLostPointerCapture={() => {
              if (!resizingColumn.current) return;
              resizingColumn.current = false;
              const grid = gridRef.current?.element;
              if (!grid) return;
              const naturalWidth = getComputedStyle(grid)
                .gridTemplateColumns.split(" ")
                .reduce((sum, width) => sum + parseFloat(width), 0);
              resizeScrollLimit.current = Math.max(
                0,
                Math.ceil(naturalWidth) - grid.clientWidth,
              );
              releaseResizeSpace(grid);
            }}
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
              rowClass={(row) =>
                row.id === deleteTargetId ? "row-delete-pending" : undefined
              }
              rowHeight={rowHeight}
              className="rootset-grid"
              aria-label={`${table.name} spreadsheet`}
              aria-describedby="grid-instructions"
              sortColumns={(query.orderBy ?? []).map((sort): SortColumn => ({
                columnKey: sort.field,
                direction: sort.direction === "asc" ? "ASC" : "DESC",
              }))}
              onSortColumnsChange={(columns) => {
                if (columns.length > limits.querySorts) {
                  toast.danger(`Sort by at most ${limits.querySorts} columns.`);
                  return;
                }
                void leaveEditor(() => {
                  setSelection(null);
                  setQuery((current) => ({
                    limit: windowLimit,
                    ...(current.where ? { where: current.where } : {}),
                    ...(columns.length
                      ? {
                          orderBy: columns.map((sort) => ({
                            field: sort.columnKey,
                            direction:
                              sort.direction === "ASC"
                                ? ("asc" as const)
                                : ("desc" as const),
                          })),
                        }
                      : {}),
                  }));
                });
              }}
              defaultColumnOptions={{
                resizable: view.isSuccess && !accessRevoked,
              }}
              onScroll={(event) => {
                releaseResizeSpace(event.currentTarget);
                if (
                  fetchingWindow.current ||
                  draft ||
                  saving ||
                  staleResults ||
                  accessRevoked ||
                  error
                )
                  return;
                const grid = event.currentTarget;
                if (
                  grid.scrollHeight - grid.scrollTop - grid.clientHeight <
                    rowHeight * 12 &&
                  hasNextWindow.current
                )
                  void loadWindow(
                    currentStart.current + currentRows.current.length,
                    tailCursor.current,
                    "next",
                  );
                else if (
                  grid.scrollTop < rowHeight * 6 &&
                  currentStart.current > 0
                )
                  void loadWindow(
                    Math.max(0, currentStart.current - windowLimit),
                    null,
                    "previous",
                  );
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
                if (column.key === "__comments") return;
                const anchor = event.currentTarget;
                leaveEditor(() => {
                  focusCell(rowIdx, column.idx - systemColumns);
                  contextAnchor.current = anchor;
                  setContextMenu(
                    column.key === "__row_number"
                      ? { row }
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
                if (rowIdx < 0 || !column || column.idx < systemColumns) {
                  setSelection(null);
                  return;
                }
                const index = column.idx - systemColumns;
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
                if (!fields.some((field) => field.id === column.key)) return;
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
                      ? null
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
              aria-label={contextMenu.field ? "Cell actions" : "Row actions"}
              autoFocus="first"
              onAction={(key) => {
                const current = contextMenu;
                setContextMenu(null);
                if (
                  key === "null" &&
                  current.row &&
                  current.field &&
                  !current.field.required &&
                  writable
                )
                  void setCellNull(current.row, current.field);
                else if (key === "history" && current.row && current.field)
                  setHistory({ row: current.row, field: current.field });
                else if (key === "delete" && current.row)
                  void deleteRow(current.row);
              }}
            >
              {contextMenu.field ? (
                <>
                  <Dropdown.Item
                    id="null"
                    textValue="Set to NULL"
                    isDisabled={
                      !writable || saving || contextMenu.field.required
                    }
                  >
                    <Eraser className="shrink-0 text-muted" />
                    Set to NULL
                  </Dropdown.Item>
                  <Dropdown.Item id="history" textValue="View cell history">
                    <History className="shrink-0 text-muted" />
                    View cell history
                  </Dropdown.Item>
                  {writable && (
                    <Dropdown.Item
                      id="delete"
                      textValue="Delete row"
                      variant="danger"
                      isDisabled={saving}
                    >
                      <Trash2 className="shrink-0 text-danger" />
                      <span className="text-danger">Delete row</span>
                    </Dropdown.Item>
                  )}
                </>
              ) : (
                <Dropdown.Item
                  id="delete"
                  textValue="Delete row"
                  variant="danger"
                  isDisabled={!writable || saving}
                >
                  <Trash2 className="shrink-0 text-danger" />
                  <span className="text-danger">Delete row</span>
                </Dropdown.Item>
              )}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
      {confirmation.dialog}
      {history && (
        <CellHistory
          tablePath={tablePath}
          row={history.row}
          field={history.field}
          onClose={() => setHistory(null)}
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
            {pastePreview.cells[0]?.length ?? 0} columns. Clipboard edits commit
            as one atomic batch.
          </p>
          <p>
            An unquoted empty TSV cell means NULL; required fields refuse it. A
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
          <Button
            isDisabled={saving || pastePreview.errors.length > 0}
            onPress={() => void confirmPaste()}
          >
            {saving ? "Committing…" : "Commit paste"}
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
    queryKey: ["cell-history", tablePath, row.id, field.id, cursor, 10],
    placeholderData: keepPreviousData,
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
        nextCursor: string | null;
        hasMore: boolean;
      }>(
        `${tablePath}/rows/${row.id}/cells/${field.id}/history?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal },
      ),
  });
  return (
    <Dialog title={`${field.name} history`} onClose={onClose} wide>
      {history.isPending ? null : history.isError ? (
        <p className="error-message" role="alert">
          {history.error.message}
        </p>
      ) : (
        <>
          <div
            aria-busy={history.isFetching}
            className="max-h-[55dvh] overflow-y-auto"
          >
            <ResourceTable
              ariaLabel={`${field.name} cell history`}
              items={history.data.data}
              getRowKey={(change) => change.id}
              mobileLayout="stacked"
              emptyTitle="No retained changes for this cell"
              emptyDescription=""
              columns={[
                {
                  key: "timestamp",
                  header: "Changed at",
                  className: "whitespace-nowrap tabular-nums",
                  cell: (change) => (
                    <ResourceName
                      name={
                        <time dateTime={change.timestamp}>
                          {new Intl.DateTimeFormat(preferences.locale, {
                            timeZone: preferences.timezone,
                            dateStyle: "medium",
                          }).format(new Date(change.timestamp))}
                        </time>
                      }
                      description={new Intl.DateTimeFormat(preferences.locale, {
                        timeZone: preferences.timezone,
                        timeStyle: "medium",
                      }).format(new Date(change.timestamp))}
                    />
                  ),
                },
                {
                  key: "before",
                  header: "Previous value",
                  cell: (change) => <HistoryValue value={change.before} />,
                },
                {
                  key: "after",
                  header: "New value",
                  cell: (change) => <HistoryValue value={change.after} />,
                },
              ]}
            />
          </div>
          {history.data.data.length > 0 && (
            <fieldset
              disabled={history.isFetching}
              className="mt-4 min-w-0 border-0 p-0"
            >
              <Pagination
                className="[&_.pagination__content]:flex-wrap"
                page={cursors.length}
                totalPages={history.data.hasMore ? null : cursors.length}
                hasNextPage={Boolean(history.data.nextCursor)}
                onPageChange={(page) => {
                  if (history.isFetching || page === cursors.length) return;
                  if (page < cursors.length) {
                    setCursors((previous) => previous.slice(0, page));
                  } else if (history.data.nextCursor) {
                    setCursors((previous) => [
                      ...previous,
                      history.data.nextCursor,
                    ]);
                  }
                }}
              />
            </fieldset>
          )}
        </>
      )}
    </Dialog>
  );
}

function HistoryValue({ value }: { value: JsonValue }) {
  const text = value === null ? "NULL" : JSON.stringify(value);
  return (
    <TooltipText
      tooltip={text}
      className="block max-w-56 truncate font-mono tabular-nums"
    >
      {text}
    </TooltipText>
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
