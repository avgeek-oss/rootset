"use client";

import { usePageQuery } from "./page-navigation";
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
  SelectColumn,
  Row as DataGridRow,
  type Column,
  type SortColumn,
  type DataGridHandle,
  type CellKeyDownArgs,
  type CellKeyboardEvent,
  type ColumnWidths,
} from "react-data-grid";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { Pagination } from "@avgeek-oss/design-system/navigation/pagination";
import {
  ResourceName,
  ResourceTable,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { Dropdown, Tooltip } from "@heroui/react";
import {
  Columns3,
  Eraser,
  History,
  Trash2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  View,
  Upload,
  ArrowDownToLine,
  Pencil,
  RefreshCw,
  Check,
  Copy,
  Hide,
  SortAscending,
  SortDescending,
} from "./ui/icons";
import { client, ApiError, resourcePath } from "@rootset/web-client";
import {
  limits,
  IdSchema,
  RootsetError,
  stableViewQuery,
  resolveSavedViewDefinition,
  type SavedView,
  type BulkRowsInput,
  type FilterNode,
  type ForeignKey,
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
import { fillGridColumnWidths } from "../lib/grid-column-widths";
import { rowResultCount, type RowResultCount } from "../lib/row-result-count";
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
import { ForeignKeyLinks } from "./foreign-key-links";
import {
  foreignKeyLinks,
  readLinkedTableFilter,
} from "../lib/foreign-key-navigation";
import { Dialog } from "./dialog";
import { RowComments } from "./row-comments";
import { RecordEditor } from "./record-editor";
import { ImportRecords } from "./import-records";
import { ExportView } from "./export-view";
import { SavedViewsToolbar } from "./saved-views";
import { SpreadsheetLoading } from "./spreadsheet-loading";
import { ViewColumns } from "./view-columns";
import { BulkRows } from "./bulk-rows";
import { GridCheckbox, RecordSelectionCell } from "./grid-checkbox";
import {
  loadRecordSelection,
  selectRecords,
  type SelectedRecord,
} from "../lib/row-selection";
import {
  linkedViewQuery,
  resolvedViewLayout,
  savedViewDirty,
  savedViewFilterState,
  savedViewPath,
  viewDefinition,
  visibleViewFields,
  type ViewLayout,
} from "../lib/saved-view-state";
import { useConfirmation } from "./settings/ui";
import { FieldTypeIcon } from "./settings/field-type-options";
import { TableFilterDialog } from "./table-filter-dialog";
import { TableFilterButton } from "./table-filter-button";
import type { FilterCombination, FilterCondition } from "../lib/table-filters";

interface WindowResult extends QueryResult {
  window?: {
    sessionId: string;
    start: number;
    total?: number | null;
    estimatedTotal?: number | null;
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
interface PlaceholderRow {
  id: string;
  placeholderIndex: number;
}
type GridRow = Row | PlaceholderRow;
const placeholderRows: PlaceholderRow[] = Array.from(
  { length: 100 },
  (_, placeholderIndex) => ({
    id: `placeholder-${placeholderIndex}`,
    placeholderIndex,
  }),
);
function isPlaceholderRow(row: GridRow): row is PlaceholderRow {
  return "placeholderIndex" in row;
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
  linkedFilter = null,
  savedViewId = null,
  initialRecordId = null,
  onSettings,
  onChanged,
}: {
  orgId: string;
  databaseId: string;
  table: Table;
  preferences: Preferences;
  canEdit: boolean;
  canManage: boolean;
  linkedFilter?: string | null;
  savedViewId?: string | null;
  initialRecordId?: string | null;
  onSettings: (section: string) => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const systemColumns = canEdit ? 2 : 1;
  const [selectedRecords, setSelectedRecords] = useState(
    new Map<string, SelectedRecord>(),
  );
  const hasSelectedRecords = selectedRecords.size > 0;
  const createdSelectionAbort = useRef<AbortController | null>(null);
  const [bulkAction, setBulkAction] = useState<{
    action: BulkRowsInput["action"]["type"];
    records: SelectedRecord[];
  } | null>(null);
  const tablePath = resourcePath(orgId, databaseId, table.id);
  const queryClient = useQueryClient();
  const confirmation = useConfirmation();
  const schema = usePageQuery({
    queryKey: ["schema", table.id],
    queryFn: ({ signal }) =>
      client.request<TableSchemaResult>(`${tablePath}/schema`, { signal }),
  });
  const view = usePageQuery({
    queryKey: ["view-preferences", table.id],
    queryFn: ({ signal }) =>
      client.operation<{ preferences: typeof preferencesEmpty }>(
        "getViewPreferences",
        { tableId: table.id },
        { signal },
      ),
  });
  const parsedViewId = IdSchema.safeParse(savedViewId);
  const viewId = parsedViewId.success ? parsedViewId.data : null;
  const namedView = usePageQuery({
    queryKey: ["saved-view", table.id, viewId],
    queryFn: ({ signal }) =>
      client.operation<SavedView>(
        "getSavedView",
        {
          orgId,
          databaseId,
          tableId: table.id,
          viewId,
        },
        { signal },
      ),
    enabled: Boolean(savedViewId && viewId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [initialFilter] = useState(() => readLinkedTableFilter(linkedFilter));
  const initialDefinition =
    namedView.data && schema.data
      ? resolveSavedViewDefinition(
          namedView.data.definition,
          schema.data.fields,
        ).definition
      : null;
  const initialQuery: QuerySpec = {
    limit: windowLimit,
    ...linkedViewQuery(initialDefinition?.query ?? {}, initialFilter.where),
  };
  const initialFilters = savedViewFilterState(
    initialQuery.where,
    schema.data?.fields ?? [],
  );
  const initialViewReady =
    !schema.isPending &&
    !view.isPending &&
    (!savedViewId || Boolean(initialDefinition));
  let initialQueryValid = !initialFilter.error;
  if (initialQueryValid && schema.data) {
    try {
      stableViewQuery(initialQuery, schema.data.fields);
    } catch {
      initialQueryValid = false;
    }
  }
  const initialReadFinished = useRef(false);
  useEffect(() => {
    initialReadFinished.current = true;
  }, []);
  const initialWindow = usePageQuery(
    {
      queryKey: [
        "initial-row-window",
        orgId,
        databaseId,
        table.id,
        schema.data?.table.schemaVersion,
        initialQuery,
      ],
      queryFn: async ({ signal }) => {
        const response = await client.request<WindowResult>(
          `/tables/${table.id}/windows/query`,
          {
            method: "POST",
            body: { orgId, databaseId, query: initialQuery, position: "first" },
            signal,
          },
        );
        if (response.schemaVersion !== schema.data?.table.schemaVersion) {
          const refreshed = await schema.refetch();
          if (refreshed.error) throw refreshed.error;
        }
        return response;
      },
      enabled:
        !initialReadFinished.current &&
        initialViewReady &&
        initialQueryValid &&
        Boolean(schema.data?.fields.length),
      staleTime: Infinity,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    { fresh: true },
  );
  const [loadedSavedView, setLoadedSavedView] = useState<SavedView | undefined>(
    namedView.data,
  );
  const [viewReady, setViewReady] = useState(initialViewReady);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [viewPrefs, setViewPrefs] = useState(
    initialDefinition ?? view.data?.preferences ?? preferencesEmpty,
  );
  const latestViewPrefs = useRef(viewPrefs);
  const mounted = useRef(true);
  const viewSaveToast = useRef<string | undefined>(undefined);
  const [rows, setRows] = useState<Row[]>(initialWindow.data?.data ?? []);
  const [linkedFilterError, setLinkedFilterError] = useState(
    initialFilter.error,
  );
  const [query, setQuery] = useState<QuerySpec>(initialQuery);
  const [windowStart, setWindowStart] = useState(
    initialWindow.data?.window?.start ?? 0,
  );
  const [windowInfo, setWindowInfo] = useState<WindowResult | null>(
    initialWindow.data ?? null,
  );
  const initialWindowApplied = useRef(Boolean(initialWindow.data));
  const [filteredCount, setFilteredCount] = useState<{
    filter: string;
    value: RowResultCount | null;
  } | null>(() =>
    initialQuery.where && initialWindow.data
      ? {
          filter: JSON.stringify(initialQuery.where),
          value: rowResultCount(
            {
              start: initialWindow.data.window?.start ?? 0,
              length: initialWindow.data.data.length,
              hasMore: initialWindow.data.page.hasMore,
              total: initialWindow.data.window?.total,
              estimate: initialWindow.data.window?.estimatedTotal,
            },
            null,
          ),
        }
      : null,
  );
  const [displayedNavigation, setDisplayedNavigation] = useState(
    initialWindow.data
      ? JSON.stringify({
          where: initialQuery.where,
          orderBy: initialQuery.orderBy,
        })
      : "",
  );
  const [loading, setLoading] = useState(false);
  const [accessRevoked, setAccessRevoked] = useState(false);
  const [error, setError] = useState<string | null>(
    initialWindow.error?.message ?? null,
  );
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
    isOpen: boolean;
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
  const [tableActionsOpen, setTableActionsOpen] = useState(false);
  const [recordEditor, setRecordEditor] = useState<{
    rowId?: string;
    focusFieldId?: string;
  } | null>(() => (initialRecordId ? { rowId: initialRecordId } : null));
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>(
    initialFilters.conditions,
  );
  const [advancedFilter, setAdvancedFilter] = useState<FilterNode | undefined>(
    initialFilters.advanced,
  );
  const [filterCombination, setFilterCombination] = useState<FilterCombination>(
    initialFilters.combination,
  );
  const [contextMenu, setContextMenu] = useState<{
    row?: Row;
    field?: FieldDefinition;
    selectedRows?: true;
  } | null>(null);
  const contextAnchor = useRef<Element | null>(null);
  const [columnMenu, setColumnMenu] = useState<FieldDefinition | null>(null);
  const columnAnchor = useRef<Element | null>(null);
  useEffect(() => {
    setContextMenu(null);
    setColumnMenu(null);
    setTableActionsOpen(false);
  }, [selectedRecords]);
  const gridRef = useRef<DataGridHandle>(null);
  const bulkFocus = useRef(false);
  useLayoutEffect(() => {
    if (!bulkFocus.current || loading || bulkAction || accessRevoked) return;
    bulkFocus.current = false;
    const firstSelected = rows.findIndex((row) => selectedRecords.has(row.id));
    gridRef.current?.setActivePosition(
      {
        rowIdx: firstSelected >= 0 ? firstSelected : rows.length ? 0 : -1,
        idx: 0,
      },
      { shouldFocus: true },
    );
    if (firstSelected >= 0)
      gridRef.current?.scrollToCell({ rowIdx: firstSelected });
  }, [rows, loading, bulkAction, accessRevoked, selectedRecords]);

  const [gridContainer, setGridContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [gridWidth, setGridWidth] = useState(0);
  useLayoutEffect(() => {
    const grid = gridContainer?.querySelector<HTMLElement>('[role="grid"]');
    if (!grid) return;
    const measure = () => setGridWidth(grid.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [gridContainer]);
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
  const tailCursor = useRef<string | null>(
    initialWindow.data?.page.nextCursor ?? null,
  );
  const hasNextWindow = useRef(initialWindow.data?.page.hasMore ?? false);
  useLayoutEffect(() => {
    if (scrollOffset.current === null) return;
    const grid = gridRef.current?.element;
    if (grid) grid.scrollTop = scrollOffset.current;
    scrollOffset.current = null;
  }, [rows]);
  const closeEditor = useRef<(() => void) | null>(null);
  const submitEditor = useRef<(() => Promise<boolean>) | null>(null);
  const extendSelection = useRef(false);
  const cache = useRef(new RowWindowCache());
  const updateCommentPresence = useCallback(
    (rowId: string, hasComments: boolean) => {
      cache.current.clear();
      setRows((previous) =>
        previous.map((row) =>
          row.id === rowId && row.hasComments !== hasComments
            ? { ...row, hasComments }
            : row,
        ),
      );
    },
    [],
  );
  const abort = useRef<AbortController | null>(null);
  const copyAbort = useRef<AbortController | null>(null);
  const sessionId = useRef<string | undefined>(
    initialWindow.data?.window?.sessionId,
  );
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
  const currentStart = useRef(windowStart);
  const currentRows = useRef<Row[]>(rows);
  const currentSelection = useRef<CellSelection | null>(null);
  const recordAccessLost = useCallback(() => {
    setRecordEditor(null);
    setImportOpen(false);
    setExportOpen(false);
    setBulkAction(null);
    setSelectedRecords(new Map());
    createdSelectionAbort.current?.abort();
    setDiscussion(null);
    setColumnMenu(null);
    setHistory(null);
    setDraft(null);
    cache.current.clear();
    setRows([]);
    setWindowInfo(null);
    setSelection(null);
    setAccessRevoked(true);
    abort.current?.abort();
  }, []);
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
  const currentFilteredCount =
    filteredCount && filteredCount.filter === JSON.stringify(query.where)
      ? filteredCount.value
      : null;
  const filteredEmpty =
    rows.length === 0 &&
    !!query.where &&
    !!windowInfo &&
    !loading &&
    !staleResults &&
    !error;
  const gridRows: GridRow[] = rows.length ? rows : placeholderRows;
  const allFields = useMemo(() => schema.data?.fields ?? [], [schema.data]);
  const layout = useMemo(
    () => resolvedViewLayout(allFields, viewPrefs),
    [allFields, viewPrefs],
  );
  const fields = useMemo(
    () => visibleViewFields(allFields, layout),
    [allFields, layout],
  );
  const currentViewDefinition = viewDefinition(layout, query);
  const viewDirty = Boolean(
    loadedSavedView &&
    savedViewDirty(
      currentViewDefinition,
      loadedSavedView.definition,
      allFields,
    ),
  );
  const queryProblem = useMemo(() => {
    if (!schema.data || !viewReady) return null;
    try {
      stableViewQuery(query, allFields);
      return null;
    } catch (failure) {
      if (!(failure instanceof RootsetError)) throw failure;
      return failure.message;
    }
  }, [queryDigest, allFields, viewReady, schema.data]);
  const unavailableView = savedViewId && (!viewId || namedView.isError);
  const rowsBlocked =
    !viewReady || Boolean(unavailableView || linkedFilterError || queryProblem);
  function applySavedView(saved: SavedView) {
    const definition = resolveSavedViewDefinition(
      saved.definition,
      allFields,
    ).definition;
    const nextQuery = {
      limit: windowLimit,
      ...linkedViewQuery(definition.query, initialFilter.where),
    };
    const filter = savedViewFilterState(nextQuery.where, allFields);
    setLoadedSavedView(saved);
    latestViewPrefs.current = definition;
    setViewPrefs(definition);
    setQuery(nextQuery);
    setFilterConditions(filter.conditions);
    setFilterCombination(filter.combination);
    setAdvancedFilter(filter.advanced);
    setViewReady(true);
    setSelection(null);
    setDraft(null);
  }
  useEffect(() => {
    if (savedViewId && !viewReady && namedView.data && schema.data)
      applySavedView(namedView.data);
  }, [savedViewId, viewReady, namedView.data, schema.data]);

  const fieldNames = useMemo(
    () => new Map(allFields.map((field) => [field.id, field.name])),
    [allFields],
  );
  const foreignKeysByField = useMemo(() => {
    const byField = new Map<string, ForeignKey[]>();
    for (const rule of schema.data?.foreignKeys ?? []) {
      for (const fieldId of rule.fieldIds) {
        const rules = byField.get(fieldId) ?? [];
        rules.push(rule);
        byField.set(fieldId, rules);
      }
    }
    return byField;
  }, [schema.data]);
  const writable =
    canEdit &&
    !accessRevoked &&
    !rowsBlocked &&
    !staleResults &&
    (!windowInfo ||
      windowInfo.schemaVersion === schema.data?.table.schemaVersion) &&
    (schema.data?.table.state ?? table.state) === "active";

  useEffect(() => {
    undoStack.current.clear();
    undoAttempt.current.clear();
  }, [tablePath, schema.data?.table.schemaVersion, accessRevoked, canEdit]);

  useEffect(() => {
    if (!savedViewId && !viewSave.hasPending) {
      if (view.data) {
        latestViewPrefs.current = view.data.preferences;
        setViewPrefs(view.data.preferences);
      }
      if (view.isSuccess || view.isError) setViewReady(true);
    }
  }, [view.data, view.isSuccess, view.isError, viewSave, savedViewId]);
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
      if (rowsBlocked) return;
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
          const grid = gridRef.current?.element;
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
        if (query.where) {
          const filter = JSON.stringify(query.where);
          setFilteredCount((previous) => ({
            filter,
            value: rowResultCount(
              {
                start,
                length: response.data.length,
                hasMore: response.page.hasMore,
                total: response.window?.total,
                estimate: response.window?.estimatedTotal,
              },
              direction && previous?.filter === filter ? previous.value : null,
            ),
          }));
        } else setFilteredCount(null);
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
        return merged.rows;
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
          recordAccessLost();
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
      rowsBlocked,
      rowHeight,
      recordAccessLost,
    ],
  );

  useEffect(() => {
    cache.current.clear();
    const navigationQuery = JSON.stringify({
      where: query.where,
      orderBy: query.orderBy,
    });
    if (initialWindowApplied.current) {
      initialWindowApplied.current = false;
      previousFilter.current = navigationQuery;
      previousSchemaVersion.current = schema.data?.table.schemaVersion;
      return () => abort.current?.abort();
    }
    const sameNavigation =
      previousFilter.current === navigationQuery &&
      previousSchemaVersion.current === schema.data?.table.schemaVersion;
    if (!sameNavigation) sessionId.current = undefined;
    const position = sameNavigation ? currentStart.current : 0;
    previousFilter.current = navigationQuery;
    previousSchemaVersion.current = schema.data?.table.schemaVersion;
    if (rowsBlocked) {
      abort.current?.abort();
      fetchingWindow.current = false;
      currentRows.current = [];
      setRows([]);
      setWindowInfo(null);
      setSelection(null);
      setLoading(false);
    } else if (schema.data) void loadWindow(position);
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
    if (draft && (await submitEditor.current?.()) !== true) return;
    action();
  }
  async function recordsChanged(created = false, createdIds: string[] = []) {
    createdSelectionAbort.current?.abort();
    const controller = new AbortController();
    createdSelectionAbort.current = controller;
    cache.current.clear();
    sessionId.current = undefined;
    setSelection(null);
    setSelectedRecords(new Map());
    onChanged();
    const loaded = await loadWindow(
      created && !query.where && !query.orderBy?.length
        ? "last"
        : currentStart.current,
    );
    if (!createdIds.length || controller.signal.aborted) return;
    try {
      if (!loaded) throw new Error("The table could not be reloaded.");
      const selected = await loadRecordSelection(
        createdIds,
        loaded,
        (rowId) =>
          client.operation<Row>(
            "getRow",
            {
              orgId,
              databaseId,
              tableId: table.id,
              rowId,
            },
            { signal: controller.signal },
          ),
        controller.signal,
      );
      bulkFocus.current = true;
      setSelectedRecords(selected);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status))
        recordAccessLost();
      toast.danger(
        "The records were duplicated, but the new selection could not be loaded. Reload the table to select them.",
      );
    }
  }

  function updateLayout(next: ViewLayout) {
    const resolved = resolvedViewLayout(allFields, next);
    latestViewPrefs.current = resolved;
    setViewPrefs(resolved);
    setSelection(null);
    if (!savedViewId) viewSave.schedule(resolved);
  }
  function navigateView(id: string | null, discardConfirmed = false) {
    void leaveEditor(async () => {
      if (
        !discardConfirmed &&
        viewDirty &&
        !(await confirmation.confirm(
          "Discard view changes?",
          "Your unsaved filters and column layout will be discarded.",
          "Discard changes",
        ))
      )
        return;
      router.push(savedViewPath(databaseId, table.id, id));
    });
  }
  async function reloadViewFields() {
    const result = await schema.refetch();
    if (result.error) {
      toast.danger(result.error.message);
      return null;
    }
    if (!result.data) return null;
    const next = resolvedViewLayout(
      result.data.fields,
      latestViewPrefs.current,
    );
    latestViewPrefs.current = next;
    setViewPrefs(next);
    return result.data.table.schemaVersion;
  }

  function changeRecordSelection(keys: Set<string>) {
    if (!writable || saving || loading) return;
    createdSelectionAbort.current?.abort();
    void leaveEditor(() => {
      try {
        setSelectedRecords(selectRecords(selectedRecords, keys, rows));
      } catch (error) {
        toast.danger(
          error instanceof Error
            ? error.message
            : "The selection could not be changed.",
        );
      }
    });
  }
  function openBulk(action: BulkRowsInput["action"]["type"]) {
    if (!writable || !selectedRecords.size) return;
    void leaveEditor(() =>
      setBulkAction({ action, records: [...selectedRecords.values()] }),
    );
  }
  function openRecordContextMenu(
    row: Row,
    columnKey: string,
    anchor: Element | null,
  ) {
    setColumnMenu(null);
    if (
      !anchor ||
      saving ||
      accessRevoked ||
      (hasSelectedRecords && !selectedRecords.has(row.id))
    ) {
      setContextMenu(null);
      return;
    }
    contextAnchor.current = anchor;
    setContextMenu(
      hasSelectedRecords
        ? { selectedRows: true }
        : {
            row,
            field: fields.find((field) => field.id === columnKey),
          },
    );
  }
  useEffect(() => {
    setSelectedRecords(new Map());
    createdSelectionAbort.current?.abort();
    return () => createdSelectionAbort.current?.abort();
  }, [queryDigest, schema.data?.table.schemaVersion, canEdit]);

  function focusCell(row: number, column: number) {
    gridRef.current?.setActivePosition(
      { rowIdx: row, idx: column + systemColumns },
      { shouldFocus: true },
    );
  }

  function beginEdit(row: Row, field: FieldDefinition, initialInput?: string) {
    if (!writable || saving || !Object.hasOwn(row.values, field.name))
      return false;
    if (
      initialInput === undefined &&
      schema.data?.foreignKeys.some((rule) => rule.fieldIds.includes(field.id))
    ) {
      setRecordEditor({ rowId: row.id, focusFieldId: field.id });
      return false;
    }
    setDraft({
      row,
      field,
      ...(initialInput !== undefined ? { initialInput } : {}),
    });
    return true;
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
        previous.map((row) =>
          row.id === updated.id ? { ...row, ...updated } : row,
        ),
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
          previous.map((row) =>
            row.id === current!.id ? { ...row, ...current! } : row,
          ),
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
        previous.map((row) => {
          const restoredRow = restored.find((next) => next.id === row.id);
          return restoredRow ? { ...row, ...restoredRow } : row;
        }),
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

  function onKey(args: CellKeyDownArgs<GridRow>, event: CellKeyboardEvent) {
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
    if (!row || !column || rowIdx < 0 || isPlaceholderRow(row)) return;
    if (column.key === "__row_number" && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      event.preventGridDefault();
      leaveEditor(() =>
        setDiscussion({
          rowId: row.id,
          rowNumber: windowStart + rowIdx + 1,
          isOpen: true,
        }),
      );
      return;
    }
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      event.preventGridDefault();
      const anchor =
        event.target instanceof Element
          ? event.target.closest('[role="gridcell"]')
          : null;
      openRecordContextMenu(row, column.key, anchor);
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
        if (
          beginEdit(row, field, event.key.length === 1 ? event.key : undefined)
        )
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
    void leaveEditor(() => {
      const stable = stableViewQuery(where ? { where } : {}, allFields).where;
      setAdvancedFilter(undefined);
      setLinkedFilterError(undefined);
      setError(null);
      setQuery((current) => ({
        limit: windowLimit,
        ...(current.orderBy ? { orderBy: current.orderBy } : {}),
        ...(stable ? { where: stable } : {}),
      }));
      setFilterConditions(conditions);
      setFilterCombination(combination);
      setFilterVisible(false);
    });
  }

  function applySortColumns(columns: SortColumn[]) {
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
                direction: sort.direction === "ASC" ? "asc" : "desc",
              })),
            }
          : {}),
      }));
    });
  }

  function openColumnMenu(target: EventTarget) {
    if (!(target instanceof Element)) return false;
    const header = target.closest('[role="columnheader"]');
    const field = fields.find(
      (field) =>
        field.id ===
        header?.querySelector("[data-field-id]")?.getAttribute("data-field-id"),
    );
    if (!header || !field || saving || accessRevoked || hasSelectedRecords)
      return false;
    void leaveEditor(() => {
      setContextMenu(null);
      columnAnchor.current = header;
      setColumnMenu(field);
    });
    return true;
  }

  const columnSort = columnMenu
    ? query.orderBy?.find(
        (sort) =>
          sort.field === columnMenu.id || sort.field === columnMenu.name,
      )
    : undefined;
  const columnSortLabel =
    columnSort?.direction === "asc"
      ? "Sort descending"
      : columnSort?.direction === "desc"
        ? "Reset sort"
        : "Sort ascending";

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
  const rowNumberWidth = Math.max(
    80,
    String(Math.max(table.rowCount, windowStart + rows.length)).length * 9 + 48,
    query.where
      ? table.rowCount.toLocaleString(preferences.locale).length * 8 + 64
      : 0,
  );
  const fittedColumnWidths = useMemo<ColumnWidths>(() => {
    const widths = fillGridColumnWidths(
      fields.map(
        (field) =>
          layout.columnWidths[field.id] ??
          (field.type === "date-time"
            ? 340
            : field.type === "json"
              ? 240
              : field.type === "date"
                ? 200
                : 180),
      ),
      gridWidth - rowNumberWidth - (canEdit ? 48 : 0),
    );
    return new Map(
      fields.map((field, index) => [
        field.id,
        { type: "measured", width: widths[index]! },
      ]),
    );
  }, [fields, layout.columnWidths, gridWidth, rowNumberWidth, canEdit]);
  const gridColumns: Column<GridRow>[] = [
    ...(canEdit
      ? [
          {
            ...SelectColumn,
            width: 48,
            minWidth: 48,
            maxWidth: 48,
            cellClass: "record-selection-cell",
            headerCellClass: "record-selection-cell",
            renderHeaderCell: ({ tabIndex }) => (
              <GridCheckbox
                aria-label="Select loaded records"
                tabIndex={tabIndex}
                disabled={!writable || saving || loading || !rows.length}
                checked={
                  Boolean(rows.length) &&
                  rows.every((row) => selectedRecords.has(row.id))
                }
                indeterminate={
                  rows.some((row) => selectedRecords.has(row.id)) &&
                  !rows.every((row) => selectedRecords.has(row.id))
                }
                onChange={(checked) => {
                  const keys = new Set(selectedRecords.keys());
                  for (const row of rows) {
                    if (checked) keys.add(row.id);
                    else keys.delete(row.id);
                  }
                  changeRecordSelection(keys);
                }}
              />
            ),
            renderCell: ({ row, rowIdx, tabIndex }) =>
              isPlaceholderRow(row) ? null : (
                <RecordSelectionCell
                  row={row}
                  rowNumber={windowStart + rowIdx + 1}
                  tabIndex={tabIndex}
                />
              ),
          } satisfies Column<GridRow>,
        ]
      : []),
    {
      key: "__row_number",
      name: (
        <span className="flex w-full items-center justify-between gap-1 whitespace-nowrap">
          #
          {query.where && (
            <span
              className="text-xs font-normal text-muted tabular-nums"
              aria-label={
                currentFilteredCount
                  ? `${currentFilteredCount.approximate ? "Approximately " : ""}${currentFilteredCount.count.toLocaleString(preferences.locale)} matching rows`
                  : "Loading matching row count"
              }
            >
              (
              {currentFilteredCount
                ? `${currentFilteredCount.approximate ? "~" : ""}${currentFilteredCount.count.toLocaleString(preferences.locale)}`
                : "…"}
              )
            </span>
          )}
        </span>
      ),
      width: rowNumberWidth,
      cellClass: "row-number-cell",
      frozen: true,
      resizable: false,
      sortable: false,
      renderCell: ({ row, rowIdx, tabIndex }) => {
        if (isPlaceholderRow(row)) return null;
        const openDiscussion = () =>
          leaveEditor(() =>
            setDiscussion({
              rowId: row.id,
              rowNumber: windowStart + rowIdx + 1,
              isOpen: true,
            }),
          );
        return (
          <div className="row-number-content">
            <span>{windowStart + rowIdx + 1}</span>
            <button
              type="button"
              className="row-comment-trigger"
              data-has-comments={row.hasComments === true}
              tabIndex={tabIndex}
              aria-label={`Row ${windowStart + rowIdx + 1} comments, ${row.hasComments ? "has comments" : "no comments"}`}
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
              <MessageSquare
                size={14}
                fill={row.hasComments ? "currentColor" : "none"}
              />
            </button>
          </div>
        );
      },
    },
    ...fields.map((field, index): Column<GridRow> => ({
      key: field.id,
      name: (
        <Tooltip delay={250} closeDelay={0}>
          <Tooltip.Trigger
            tabIndex={-1}
            data-field-id={field.id}
            className="inline-flex w-full min-w-0 max-w-full items-center gap-1.5 align-middle"
          >
            <FieldTypeIcon type={field.type} size={14} />
            <span className="min-w-0 flex-1 truncate text-left">
              {field.name}
            </span>
            {foreignKeysByField.has(field.id) && (
              <Chip
                size="sm"
                color="accent"
                variant="primary"
                className="shrink-0"
                aria-label="Foreign key"
              >
                <Chip.Label className="text-xs font-medium italic">
                  fk
                </Chip.Label>
              </Chip>
            )}
          </Tooltip.Trigger>
          <Tooltip.Content placement="top">
            {field.type === "time" ? "UTC time" : field.type}
            {field.required ? " · required" : ""}
          </Tooltip.Content>
        </Tooltip>
      ),
      sortable: field.type !== "json" && !accessRevoked && !saving,
      width: fittedColumnWidths.get(field.id)!.width,
      // Data Grid cannot span frozen and scrolling columns in the same cell.
      frozen: !filteredEmpty && index < layout.frozenColumns,
      maxWidth: 2000,
      colSpan: (args) =>
        filteredEmpty &&
        index === 0 &&
        args.type === "ROW" &&
        isPlaceholderRow(args.row) &&
        args.row.placeholderIndex === 0
          ? fields.length
          : undefined,
      editable: (row) =>
        !isPlaceholderRow(row) &&
        writable &&
        Object.hasOwn(row.values, field.name),
      cellClass: (row) => {
        if (!selection || isPlaceholderRow(row)) return undefined;
        const rowIdx = rows.findIndex((candidate) => candidate.id === row.id);
        return rowIdx >= Math.min(selection.row, selection.endRow) &&
          rowIdx <= Math.max(selection.row, selection.endRow) &&
          index >= Math.min(selection.column, selection.endColumn) &&
          index <= Math.max(selection.column, selection.endColumn)
          ? "range-selected"
          : undefined;
      },
      renderCell: ({ row, tabIndex }) =>
        isPlaceholderRow(row) ? (
          filteredEmpty && index === 0 && row.placeholderIndex === 0 ? (
            <span className="empty-filter-message">
              No results returned for the applied filters.
            </span>
          ) : null
        ) : (
          <span
            data-cell-loaded={Object.hasOwn(row.values, field.name)}
            className={
              foreignKeysByField.has(field.id) ? "foreign-key-cell" : undefined
            }
          >
            <span
              className={`${foreignKeysByField.has(field.id) ? "foreign-key-cell-value " : ""}${
                row.values[field.name] === null
                  ? "null-value"
                  : field.type === "boolean" &&
                      typeof row.values[field.name] === "boolean"
                    ? `cell-boolean-${row.values[field.name]}`
                    : ""
              }`}
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
            {!accessRevoked &&
              !staleResults &&
              foreignKeysByField.has(field.id) && (
                <ForeignKeyLinks
                  links={foreignKeyLinks(
                    databaseId,
                    foreignKeysByField.get(field.id)!,
                    row,
                    fieldNames,
                  )}
                  tabIndex={tabIndex}
                />
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
      <SavedViewsToolbar
        target={{ orgId, databaseId, tableId: table.id }}
        schemaVersion={schema.data?.table.schemaVersion ?? table.schemaVersion}
        viewId={savedViewId}
        selected={loadedSavedView}
        definition={currentViewDefinition}
        dirty={viewDirty}
        loading={!viewReady && !unavailableView}
        onAccessLost={recordAccessLost}
        canShare={canEdit && !accessRevoked}
        disabled={
          !schema.data ||
          !viewReady ||
          Boolean(unavailableView) ||
          accessRevoked ||
          saving
        }
        hasFilters={Boolean(query.where || linkedFilterError)}
        hasSorting={Boolean(query.orderBy?.length)}
        onNavigate={navigateView}
        onColumns={() => void leaveEditor(() => setColumnsOpen(true))}
        onClearFilters={() => applyFilters([], "and", undefined)}
        onClearSorting={() =>
          void leaveEditor(() =>
            setQuery((current) => ({
              limit: windowLimit,
              ...(current.where ? { where: current.where } : {}),
            })),
          )
        }
        onSaved={(saved, kind) => {
          if (kind === "create" || (kind === "update" && linkedFilter))
            navigateView(saved.id, true);
          else if (kind === "manage") setLoadedSavedView(saved);
          else applySavedView(saved);
        }}
        onDeleted={() => navigateView(null, true)}
        onReload={async () => {
          const result = await namedView.refetch();
          if (result.error) throw result.error;
          if (result.data) applySavedView(result.data);
        }}
        onReloadFields={reloadViewFields}
        selectionActions={
          canEdit && selectedRecords.size > 0 ? (
            <>
              <span className="shrink-0 text-sm font-medium tabular-nums italic">
                {selectedRecords.size.toLocaleString(preferences.locale)}{" "}
                {selectedRecords.size === 1 ? "row" : "rows"} selected
              </span>
              <div className="ml-auto flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <Button
                  variant="secondary"
                  aria-label="Set value"
                  className="max-sm:size-9 max-sm:min-w-9 max-sm:px-0"
                  isDisabled={!writable || saving}
                  onPress={() => openBulk("set")}
                >
                  <Pencil />
                  <span className="max-sm:hidden">Set value</span>
                </Button>
                <Button
                  variant="secondary"
                  aria-label="Duplicate rows"
                  className="max-sm:size-9 max-sm:min-w-9 max-sm:px-0"
                  isDisabled={!writable || saving}
                  onPress={() => openBulk("duplicate")}
                >
                  <Copy />
                  <span className="max-sm:hidden">Duplicate rows</span>
                </Button>
                <Button
                  variant="danger"
                  aria-label="Delete rows"
                  className="max-sm:size-9 max-sm:min-w-9 max-sm:px-0"
                  isDisabled={!writable || saving}
                  onPress={() => openBulk("delete")}
                >
                  <Trash2 />
                  <span className="max-sm:hidden">Delete rows</span>
                </Button>
              </div>
            </>
          ) : undefined
        }
      />
      {bulkAction && (
        <BulkRows
          target={{ orgId, databaseId, tableId: table.id }}
          selected={bulkAction.records}
          action={bulkAction.action}
          preferences={preferences}
          canEdit={writable}
          onClose={() => setBulkAction(null)}
          onApplied={(result) => {
            bulkFocus.current = true;
            if (result.action !== "duplicate")
              undoStack.current.forgetRows(
                bulkAction.records.map((record) => record.rowId),
              );
            setBulkAction(null);
            void recordsChanged(
              result.action === "duplicate",
              result.createdIds,
            );
          }}
          onSelectionReload={(records) =>
            setSelectedRecords(
              new Map(records.map((record) => [record.rowId, record])),
            )
          }
          onAccessLost={recordAccessLost}
        />
      )}
      {columnsOpen && (
        <ViewColumns
          fields={allFields}
          value={layout}
          tableName={table.name}
          onApply={updateLayout}
          onClose={() => setColumnsOpen(false)}
        />
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
          isOpen={discussion.isOpen}
          canCreate={canEdit && !accessRevoked}
          locale={preferences.locale}
          timeZone={preferences.timezone}
          onClose={() =>
            setDiscussion((current) => current && { ...current, isOpen: false })
          }
          onPresenceChange={updateCommentPresence}
        />
      )}
      <div
        className="table-floating-actions"
        role="toolbar"
        aria-label="Table actions"
        data-hidden={hasSelectedRecords || undefined}
        aria-hidden={hasSelectedRecords}
        inert={hasSelectedRecords}
      >
        <Dropdown
          isOpen={tableActionsOpen && !hasSelectedRecords}
          onOpenChange={setTableActionsOpen}
        >
          <Button
            isIconOnly
            size="lg"
            variant="secondary"
            aria-label="More table actions"
            isDisabled={
              hasSelectedRecords || saving || accessRevoked || !allFields.length
            }
          >
            <MoreHorizontal size={20} />
          </Button>
          <Dropdown.Popover>
            <Dropdown.Menu
              aria-label="More table actions"
              onAction={(key) => {
                if (key === "open" && selection && rows[selection.row])
                  void leaveEditor(() =>
                    setRecordEditor({ rowId: rows[selection.row]!.id }),
                  );
                else if (key === "import")
                  void leaveEditor(() => setImportOpen(true));
                else if (key === "export")
                  void leaveEditor(() => setExportOpen(true));
              }}
            >
              <Dropdown.Item
                id="open"
                textValue="Open record"
                isDisabled={!selection || !rows[selection.row]}
              >
                <View className="shrink-0 text-muted" />
                Open record
              </Dropdown.Item>
              <Dropdown.Item
                id="export"
                textValue="Export current view"
                isDisabled={
                  !viewReady ||
                  Boolean(unavailableView) ||
                  Boolean(queryProblem) ||
                  Boolean(linkedFilterError) ||
                  (schema.data?.table.state ?? table.state) !== "active"
                }
              >
                <ArrowDownToLine className="shrink-0 text-muted" />
                Export current view
              </Dropdown.Item>
              {canEdit && (
                <Dropdown.Item
                  id="import"
                  textValue="Import records"
                  isDisabled={!writable}
                >
                  <Upload className="shrink-0 text-muted" />
                  Import records
                </Dropdown.Item>
              )}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        <TableFilterButton
          fields={allFields}
          advancedWhere={advancedFilter}
          conditions={filterConditions}
          combination={filterCombination}
          isDisabled={
            hasSelectedRecords ||
            !allFields.length ||
            !viewReady ||
            Boolean(unavailableView) ||
            saving
          }
          isEditing={filterVisible}
          onPress={() => leaveEditor(() => setFilterVisible(true))}
        />
        {canEdit && (
          <Button
            size="lg"
            isDisabled={
              hasSelectedRecords || !writable || !allFields.length || saving
            }
            onPress={() => void leaveEditor(() => setRecordEditor({}))}
          >
            <Plus size={20} />
            Add record
          </Button>
        )}
      </div>
      {recordEditor && (
        <RecordEditor
          target={{ orgId, databaseId, tableId: table.id }}
          tableName={table.name}
          rowId={recordEditor.rowId}
          focusFieldId={recordEditor.focusFieldId}
          preferences={preferences}
          canEdit={writable}
          onClose={() => setRecordEditor(null)}
          onSaved={(_row, created) => {
            recordsChanged(created);
          }}
          onAccessLost={recordAccessLost}
        />
      )}
      {importOpen && (
        <ImportRecords
          target={{ orgId, databaseId, tableId: table.id }}
          preferences={preferences}
          onClose={() => setImportOpen(false)}
          onImported={() => recordsChanged(true)}
          onAccessLost={recordAccessLost}
        />
      )}
      {exportOpen && schema.data && (
        <ExportView
          target={{ orgId, databaseId, tableId: table.id }}
          tableName={table.name}
          fields={allFields}
          visible={fields}
          selected={
            selection
              ? fields.slice(
                  Math.min(selection.column, selection.endColumn),
                  Math.max(selection.column, selection.endColumn) + 1,
                )
              : []
          }
          query={query}
          schemaVersion={schema.data.table.schemaVersion}
          onClose={() => setExportOpen(false)}
          onAccessLost={recordAccessLost}
        />
      )}
      {filterVisible && (
        <TableFilterDialog
          fields={allFields}
          advancedWhere={advancedFilter}
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
      {linkedFilterError && (
        <p className="error-banner" role="alert">
          {linkedFilterError}
          <button onClick={() => applyFilters([], "and", undefined)}>
            Clear filter
          </button>
        </p>
      )}
      {(schema.data?.table.state ?? table.state) !== "active" && canEdit && (
        <p className="notice" role="status">
          This table is in maintenance. Drafts are retained; writes resume when
          the schema job finishes.
        </p>
      )}
      {unavailableView ? (
        <div className="empty-state" role="alert">
          <View size={30} />
          <h2>View unavailable</h2>
          <p>
            {!viewId
              ? "This view link is invalid."
              : (namedView.error?.message ?? "This view could not be opened.")}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {viewId && (
              <Button
                variant="secondary"
                onPress={() => void namedView.refetch()}
              >
                <RefreshCw />
                Retry
              </Button>
            )}
            <Button onPress={() => navigateView(null)}>
              <View />
              Open default view
            </Button>
          </div>
        </div>
      ) : accessRevoked ? (
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
            <RefreshCw />
            Check access again
          </Button>
        </div>
      ) : schema.isPending || !viewReady ? (
        <SpreadsheetLoading />
      ) : schema.isError && !schema.data ? null : queryProblem ||
        linkedFilterError ? (
        <div className="empty-state" role="alert">
          <h2>Review the view’s filters or sorting</h2>
          <p>{queryProblem ?? linkedFilterError}</p>
          <p>
            No records have been loaded. Correct or clear the affected
            conditions to continue.
          </p>
        </div>
      ) : !allFields.length ? (
        <div className="empty-state">
          <Columns3 size={30} />
          <h2>{canManage ? "Define this table’s fields" : "No fields yet"}</h2>
          <p>
            {canManage
              ? "Choose typed columns and validation before entering data."
              : "An admin can define this table’s fields before you enter data."}
          </p>
          {canManage && (
            <Button onPress={() => onSettings("fields")}>
              <Plus />
              Add a field
            </Button>
          )}
        </div>
      ) : !windowInfo ? (
        error ? null : (
          <SpreadsheetLoading />
        )
      ) : (
        <>
          <div className="sr-only" id="grid-instructions">
            Double-click a cell to edit. Right-click for cell actions. Arrow
            keys navigate; Enter or F2 edits; Tab moves across columns; Escape
            cancels. Right-click a column title or press Shift-F10 for column
            actions. Hold Shift to select a rectangle. Times are UTC. Date-times
            display in {preferences.timezone}. Command-Z or Control-Z undoes the
            last saved cell change. Undo is available during this table session.
            {copying && (
              <span role="status"> Preparing selection for copy…</span>
            )}
          </div>
          <div
            className="grid-container"
            aria-busy={loading}
            ref={setGridContainer}
            onContextMenu={(event) => {
              if (hasSelectedRecords || openColumnMenu(event.target))
                event.preventDefault();
            }}
            onKeyDownCapture={(event) => {
              if (
                (event.key === "ContextMenu" ||
                  (event.shiftKey && event.key === "F10")) &&
                ((hasSelectedRecords &&
                  event.target instanceof Element &&
                  event.target.closest('[role="columnheader"]')) ||
                  openColumnMenu(event.target))
              ) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
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
                if (rows.length)
                  previewPaste(event.clipboardData.getData("text/plain"));
              }
            }}
          >
            <DataGrid
              ref={gridRef}
              columns={gridColumns}
              columnWidths={fittedColumnWidths}
              // Resizing saves preferences below; viewport sizing supplies the displayed widths.
              onColumnWidthsChange={() => {}}
              rows={gridRows}
              rowKeyGetter={(row) => row.id}
              rowClass={(row) =>
                row.id === deleteTargetId ? "row-delete-pending" : undefined
              }
              rowHeight={rowHeight}
              selectedRows={new Set(selectedRecords.keys())}
              onSelectedRowsChange={changeRecordSelection}
              isRowSelectionDisabled={(row) =>
                isPlaceholderRow(row) || !writable || saving || loading
              }
              className="rootset-grid"
              aria-label={`${table.name} spreadsheet`}
              aria-describedby="grid-instructions"
              sortColumns={(query.orderBy ?? []).map((sort): SortColumn => ({
                columnKey: sort.field,
                direction: sort.direction === "asc" ? "ASC" : "DESC",
              }))}
              onSortColumnsChange={applySortColumns}
              defaultColumnOptions={{
                resizable:
                  (savedViewId ? viewReady : view.isSuccess) && !accessRevoked,
              }}
              onScroll={(event) => {
                releaseResizeSpace(event.currentTarget);
                if (
                  !rows.length ||
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
                if (
                  isPlaceholderRow(row) ||
                  draft ||
                  saving ||
                  !field ||
                  !writable
                )
                  event.preventGridDefault();
                else if (!beginEdit(row, field)) event.preventGridDefault();
              }}
              onCellContextMenu={({ row, column, rowIdx }, event) => {
                event.preventDefault();
                event.preventGridDefault();
                if (isPlaceholderRow(row)) return;
                const anchor = event.currentTarget;
                if (hasSelectedRecords) {
                  openRecordContextMenu(row, column.key, anchor);
                  return;
                }
                leaveEditor(() => {
                  focusCell(rowIdx, column.idx - systemColumns);
                  openRecordContextMenu(row, column.key, anchor);
                });
              }}
              onActivePositionChange={({ rowIdx, column, row }) => {
                if (
                  !row ||
                  isPlaceholderRow(row) ||
                  rowIdx < 0 ||
                  !column ||
                  column.idx < systemColumns
                ) {
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
              onCellCopy={(_args, event) => {
                if (draft) return;
                event.preventDefault();
                void copySelection();
              }}
              onCellKeyDown={onKey}
              onColumnResize={(column, width) => {
                if (!fields.some((field) => field.id === column.key)) return;
                const next = {
                  ...resolvedViewLayout(allFields, latestViewPrefs.current),
                  columnWidths: {
                    ...resolvedViewLayout(allFields, latestViewPrefs.current)
                      .columnWidths,
                    [column.key]: width,
                  },
                };
                updateLayout(next);
              }}
              renderers={{
                renderRow: (key, props) => (
                  <DataGridRow
                    key={key}
                    {...props}
                    data-row-id={
                      isPlaceholderRow(props.row) ? undefined : props.row.id
                    }
                  />
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
      {contextMenu &&
        (contextMenu.selectedRows
          ? hasSelectedRecords
          : !hasSelectedRecords) && (
          <Dropdown
            isOpen
            onOpenChange={(open) => {
              if (!open) setContextMenu(null);
            }}
          >
            <Dropdown.Popover
              triggerRef={contextAnchor}
              placement="bottom start"
            >
              <Dropdown.Menu
                aria-label={
                  contextMenu.selectedRows
                    ? "Selected row actions"
                    : contextMenu.field
                      ? "Cell actions"
                      : "Row actions"
                }
                autoFocus="first"
                onAction={(key) => {
                  const current = contextMenu;
                  setContextMenu(null);
                  if (current.selectedRows) {
                    if (
                      key === "set" ||
                      key === "duplicate" ||
                      key === "delete"
                    )
                      openBulk(key);
                    return;
                  }
                  if (hasSelectedRecords) return;
                  if (key === "open" && current.row)
                    void leaveEditor(() =>
                      setRecordEditor({ rowId: current.row!.id }),
                    );
                  else if (key === "comments" && current.row)
                    setDiscussion({
                      rowId: current.row.id,
                      rowNumber:
                        windowStart +
                        rows.findIndex((row) => row.id === current.row!.id) +
                        1,
                      isOpen: true,
                    });
                  else if (
                    key === "duplicate" &&
                    current.row &&
                    writable &&
                    !saving
                  )
                    setBulkAction({
                      action: "duplicate",
                      records: [
                        {
                          rowId: current.row.id,
                          expectedVersion: current.row.version,
                        },
                      ],
                    });
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
                  else if (key === "delete" && current.row)
                    void deleteRow(current.row);
                }}
              >
                {contextMenu.selectedRows ? (
                  <>
                    <Dropdown.Item
                      id="set"
                      textValue="Set value"
                      isDisabled={!writable || saving}
                    >
                      <Pencil className="shrink-0 text-muted" />
                      Set value
                    </Dropdown.Item>
                    <Dropdown.Item
                      id="duplicate"
                      textValue="Duplicate rows"
                      isDisabled={!writable || saving}
                    >
                      <Copy className="shrink-0 text-muted" />
                      Duplicate rows
                    </Dropdown.Item>
                    <Dropdown.Item
                      id="delete"
                      textValue="Delete rows"
                      variant="danger"
                      isDisabled={!writable || saving}
                    >
                      <Trash2 className="shrink-0 text-danger" />
                      <span className="text-danger">Delete rows</span>
                    </Dropdown.Item>
                  </>
                ) : (
                  <>
                    <Dropdown.Item
                      id="open"
                      textValue="Open record"
                      isDisabled={!contextMenu.row || saving}
                    >
                      <View className="shrink-0 text-muted" />
                      Open record
                    </Dropdown.Item>
                    <Dropdown.Item
                      id="comments"
                      textValue="Open comments"
                      isDisabled={
                        !contextMenu.row ||
                        saving ||
                        accessRevoked ||
                        staleResults
                      }
                    >
                      <MessageSquare className="shrink-0 text-muted" />
                      Open comments
                    </Dropdown.Item>
                    {canEdit && (
                      <Dropdown.Item
                        id="duplicate"
                        textValue="Duplicate row"
                        isDisabled={!contextMenu.row || !writable || saving}
                      >
                        <Copy className="shrink-0 text-muted" />
                        Duplicate row
                      </Dropdown.Item>
                    )}
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
                        <Dropdown.Item
                          id="history"
                          textValue="View cell history"
                        >
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
                  </>
                )}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}
      {columnMenu && (
        <Dropdown
          isOpen
          onOpenChange={(open) => {
            if (!open) setColumnMenu(null);
          }}
        >
          <Dropdown.Popover triggerRef={columnAnchor} placement="bottom start">
            <Dropdown.Menu
              aria-label={`${columnMenu.name} column actions`}
              autoFocus="first"
              onAction={(key) => {
                const field = columnMenu;
                setColumnMenu(null);
                if (key === "hide")
                  void leaveEditor(() =>
                    updateLayout({
                      ...layout,
                      hiddenColumns: [...layout.hiddenColumns, field.id],
                    }),
                  );
                else if (key === "sort") {
                  const orderBy = query.orderBy ?? [];
                  const isField = (sort: (typeof orderBy)[number]) =>
                    sort.field === field.id || sort.field === field.name;
                  const next = { field: field.id, direction: "asc" as const };
                  const sorts = !columnSort
                    ? [...orderBy, next]
                    : columnSort.direction === "asc"
                      ? orderBy.map((sort) =>
                          isField(sort)
                            ? { ...sort, direction: "desc" as const }
                            : sort,
                        )
                      : orderBy.filter((sort) => !isField(sort));
                  applySortColumns(
                    sorts.map((sort) => ({
                      columnKey: sort.field,
                      direction: sort.direction === "asc" ? "ASC" : "DESC",
                    })),
                  );
                }
              }}
            >
              <Dropdown.Item
                id="hide"
                textValue="Hide column"
                isDisabled={saving || accessRevoked}
              >
                <Hide className="shrink-0 text-muted" />
                Hide column
              </Dropdown.Item>
              <Dropdown.Item
                id="sort"
                textValue={columnSortLabel}
                isDisabled={
                  columnMenu.type === "json" || saving || accessRevoked
                }
              >
                {columnSort?.direction === "asc" ? (
                  <SortDescending className="shrink-0 text-muted" />
                ) : columnSort?.direction === "desc" ? (
                  <Eraser className="shrink-0 text-muted" />
                ) : (
                  <SortAscending className="shrink-0 text-muted" />
                )}
                {columnSortLabel}
              </Dropdown.Item>
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
            <Check />
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
              tableClassName="min-w-2xl"
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
      className={`block max-w-56 truncate font-mono tabular-nums${value === null ? " null-value" : ""}`}
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
