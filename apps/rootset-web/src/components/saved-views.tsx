"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dropdown,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
} from "@heroui/react";
import {
  Autocomplete,
  SearchField,
} from "@avgeek-oss/design-system/pickers/autocomplete";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { HugeiconsIcon } from "@hugeicons/react";
import { UserAccountIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { ApiError, client } from "@rootset/web-client";
import {
  AccountNameSchema,
  SavedViewDefinitionSchema,
  type SavedView,
  type SavedViewDefinition,
  type SavedViewSummary,
} from "@rootset/contracts";
import { MutationAttempt } from "../lib/mutation-attempt";
import { savedViewPath } from "../lib/saved-view-state";
import { Dialog } from "./dialog";
import { Form, useConfirmation } from "./settings/ui";
import { Columns3, MoreHorizontal, View } from "./ui/icons";

type SaveKind = "create" | "update" | "rename";
interface Target {
  orgId: string;
  databaseId: string;
  tableId: string;
}
interface SavedViewsProps {
  target: Target;
  schemaVersion: number;
  viewId: string | null;
  selected?: SavedView;
  definition: SavedViewDefinition;
  dirty: boolean;
  canShare: boolean;
  disabled: boolean;
  hasFilters: boolean;
  hasSorting: boolean;
  onNavigate(id: string | null): void;
  onColumns(): void;
  onClearFilters(): void;
  onClearSorting(): void;
  onSaved(view: SavedView, kind: SaveKind): void;
  onDeleted(): void;
  onReload(): Promise<void>;
  onReloadFields(): Promise<number | null>;
  onAccessLost(): void;
  loading: boolean;
}
export function SavedViewsToolbar(props: SavedViewsProps) {
  const [editor, setEditor] = useState<{
    kind: "create" | "rename";
    definition: SavedViewDefinition;
    selected?: SavedView;
    schemaVersion: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [schemaConflict, setSchemaConflict] = useState(false);
  const lock = useRef(false);
  const attempt = useRef(new MutationAttempt());
  const queryClient = useQueryClient();
  const confirmation = useConfirmation();
  const views = useQuery({
    queryKey: ["saved-views", props.target.tableId],
    queryFn: ({ signal }) =>
      client.operation<{ data: SavedViewSummary[] }>(
        "listSavedViews",
        { ...props.target },
        { signal },
      ),
    staleTime: 5000,
    retry: false,
  });
  const items = views.isError ? [] : (views.data?.data ?? []);
  const missing = Boolean(
    props.viewId && !items.some((item) => item.id === props.viewId),
  );
  useEffect(() => {
    if (
      views.error instanceof ApiError &&
      [401, 403, 404].includes(views.error.status)
    )
      props.onAccessLost();
  }, [views.error, props.onAccessLost]);
  const label =
    props.selected?.name ??
    (props.viewId
      ? props.loading
        ? "Loading view…"
        : "Unavailable view"
      : "Default view");
  async function changed(view: SavedView, kind: SaveKind) {
    await queryClient.invalidateQueries({
      queryKey: ["saved-views", props.target.tableId],
    });
    queryClient.setQueryData(
      ["saved-view", props.target.tableId, view.id],
      view,
    );
    setConflict(false);
    setSchemaConflict(false);
    setEditor(null);
    props.onSaved(view, kind);
  }
  function openEditor(kind: "create" | "rename") {
    if (busy || props.disabled) return;
    if (kind === "rename" && !props.selected?.canEdit) return;
    if (kind === "create") {
      const result = SavedViewDefinitionSchema.safeParse(props.definition);
      if (!result.success) {
        toast.danger(
          result.error.issues[0]?.message ??
            "Check the view’s filters and layout.",
        );
        return;
      }
    }
    setEditor({
      kind,
      definition: props.definition,
      selected: props.selected,
      schemaVersion: props.schemaVersion,
    });
  }
  async function save() {
    if (
      lock.current ||
      props.disabled ||
      !props.selected?.canEdit ||
      !props.dirty
    )
      return;
    lock.current = true;
    setBusy(true);
    const input = {
      ...props.target,
      viewId: props.selected.id,
      expectedVersion: props.selected.version,
      expectedSchemaVersion: props.schemaVersion,
      definition: props.definition,
    };
    try {
      const result = SavedViewDefinitionSchema.safeParse(input.definition);
      if (!result.success) {
        toast.danger(
          result.error.issues[0]?.message ??
            "Check the view’s filters and layout.",
        );
        return;
      }
      const view = await client.operation<SavedView>("updateSavedView", input, {
        idempotencyKey: attempt.current.forInput(input),
      });
      attempt.current.clear();
      await changed(view, "update");
      toast.success("View saved");
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "VIEW_VERSION_CONFLICT") setConflict(true);
        if (error.code === "SCHEMA_VERSION_CONFLICT") setSchemaConflict(true);
      }
      toast.danger(
        error instanceof Error ? error.message : "The view could not be saved.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function remove() {
    if (lock.current || !props.selected?.canEdit) return;
    const view = props.selected;
    lock.current = true;
    if (
      !(await confirmation.confirm(
        "Delete view?",
        "The saved view and any unsaved view changes will be removed. Its records will stay in the table.",
        "Delete view",
      ))
    ) {
      lock.current = false;
      return;
    }
    setBusy(true);
    const input = {
      ...props.target,
      viewId: view.id,
      expectedVersion: view.version,
    };
    try {
      await client.operation("deleteSavedView", input, {
        idempotencyKey: attempt.current.forInput(input),
      });
      attempt.current.clear();
      await queryClient.invalidateQueries({
        queryKey: ["saved-views", props.target.tableId],
      });
      props.onDeleted();
      toast.success("View deleted");
    } catch (error) {
      if (error instanceof ApiError && error.code === "VIEW_VERSION_CONFLICT")
        setConflict(true);
      toast.danger(
        error instanceof Error
          ? error.message
          : "The view could not be deleted.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function copyLink() {
    if (lock.current || !props.selected) return;
    lock.current = true;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(
        new URL(
          savedViewPath(
            props.target.databaseId,
            props.target.tableId,
            props.selected.id,
          ),
          window.location.origin,
        ).href,
      );
      toast.success("View link copied");
    } catch {
      toast.danger("The view link could not be copied. Try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    if (lock.current) return;
    lock.current = true;
    if (
      !(await confirmation.confirm(
        "Reload saved view?",
        "Your unsaved view changes will be replaced by the current saved filters and layout.",
        "Reload view",
      ))
    ) {
      lock.current = false;
      return;
    }
    setBusy(true);
    try {
      await props.onReload();
      setConflict(false);
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "The view could not be reloaded.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div
        className="flex min-w-0 flex-wrap items-center gap-3 border-b border-separator px-4 py-3 sm:px-6"
        role="toolbar"
        aria-label="View actions"
      >
        <Select
          className="min-w-0 max-w-xs flex-1"
          value={props.viewId ?? "default"}
          isDisabled={busy}
          onChange={(id) => {
            if (typeof id === "string")
              props.onNavigate(id === "default" ? null : id);
          }}
        >
          <Label className="sr-only">View</Label>
          <Select.Trigger>
            <View className="shrink-0 text-muted" />
            <Select.Value className="min-w-0 flex-1">
              <span className="truncate">{label}</span>
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover className="flex w-(--trigger-width) min-w-[min(18rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden">
            <Autocomplete.Filter
              filter={(text, search) =>
                text
                  .toLocaleLowerCase()
                  .includes(search.trim().toLocaleLowerCase())
              }
            >
              <SearchField
                aria-label="Search views"
                variant="secondary"
                className="shrink-0 px-2 pt-2 pb-2"
              >
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input
                    className="text-base sm:text-sm"
                    placeholder="Search views…"
                    maxLength={120}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={
                      typeof window !== "undefined" &&
                      window.matchMedia("(pointer: fine)").matches
                    }
                  />
                  <SearchField.ClearButton aria-label="Clear view search" />
                </SearchField.Group>
              </SearchField>
              <ListBox
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                renderEmptyState={() => "No matching views"}
              >
                <ListBox.Item id="default" textValue="Default view">
                  Default view
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                {missing && (
                  <ListBox.Item id={props.viewId!} textValue={label} isDisabled>
                    {label}
                  </ListBox.Item>
                )}
                {items.map((view) => (
                  <ListBox.Item
                    key={view.id}
                    id={view.id}
                    textValue={`${view.name} ${view.visibility}`}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="truncate">{view.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted">
                        {view.visibility === "shared" ? "Shared" : "Personal"}
                      </span>
                    </span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Autocomplete.Filter>
            {views.isPending && (
              <p role="status" className="px-3 py-2 text-sm text-muted">
                Loading views…
              </p>
            )}
            {views.isError && (
              <Button
                slot={null}
                variant="secondary"
                onPress={() => void views.refetch()}
              >
                Retry loading views
              </Button>
            )}
          </Select.Popover>
        </Select>
        {props.selected?.canEdit && props.dirty && (
          <Button
            isPending={busy}
            isDisabled={busy || props.disabled || conflict || schemaConflict}
            onPress={() => void save()}
          >
            Save changes
          </Button>
        )}
        <Button
          variant="secondary"
          isIconOnly
          aria-label="Columns"
          isDisabled={busy || props.disabled}
          onPress={props.onColumns}
        >
          <Columns3 />
        </Button>
        <Dropdown>
          <Button
            variant="secondary"
            isIconOnly
            aria-label="View options"
            isDisabled={busy}
          >
            <MoreHorizontal />
          </Button>
          <Dropdown.Popover>
            <Dropdown.Menu
              aria-label="View options"
              onAction={(key) => {
                if (key === "new") openEditor("create");
                else if (key === "rename") openEditor("rename");
                else if (key === "copy") void copyLink();
                else if (key === "delete") void remove();
                else if (key === "clear-filters") props.onClearFilters();
                else if (key === "clear-sorting") props.onClearSorting();
              }}
            >
              <Dropdown.Item id="new" isDisabled={props.disabled}>
                Save as new view
              </Dropdown.Item>
              {props.selected && (
                <Dropdown.Item id="copy" isDisabled={props.disabled}>
                  Copy view link
                </Dropdown.Item>
              )}
              {props.selected?.canEdit && (
                <Dropdown.Item id="rename" isDisabled={props.disabled}>
                  Rename or share view
                </Dropdown.Item>
              )}
              {props.hasFilters && (
                <Dropdown.Item id="clear-filters">Clear filters</Dropdown.Item>
              )}
              {props.hasSorting && (
                <Dropdown.Item id="clear-sorting">Clear sorting</Dropdown.Item>
              )}
              {props.selected?.canEdit && (
                <Dropdown.Item id="delete" variant="danger">
                  Delete view
                </Dropdown.Item>
              )}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        {conflict && (
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => void reload()}
          >
            Reload saved view
          </Button>
        )}
        {schemaConflict && (
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() =>
              void props.onReloadFields().then((version) => {
                if (version) setSchemaConflict(false);
              })
            }
          >
            Reload fields
          </Button>
        )}
      </div>
      {editor && (
        <ViewEditor
          {...props}
          snapshot={editor}
          onClose={() => setEditor(null)}
          onComplete={changed}
        />
      )}
      {confirmation.dialog}
    </>
  );
}

function ViewEditor({
  target,
  canShare,
  snapshot,
  onClose,
  onComplete,
  onReloadFields,
}: Pick<SavedViewsProps, "target" | "canShare" | "onReloadFields"> & {
  snapshot: {
    kind: "create" | "rename";
    definition: SavedViewDefinition;
    selected?: SavedView;
    schemaVersion: number;
  };
  onClose(): void;
  onComplete(view: SavedView, kind: SaveKind): Promise<void>;
}) {
  const [name, setName] = useState(
    snapshot.kind === "rename"
      ? snapshot.selected!.name
      : snapshot.selected
        ? `${snapshot.selected.name.slice(0, 115)} copy`
        : "",
  );
  const [visibility, setVisibility] = useState<"personal" | "shared">(
    snapshot.kind === "rename" ? snapshot.selected!.visibility : "personal",
  );
  const [schemaVersion, setSchemaVersion] = useState(snapshot.schemaVersion);
  const [busy, setBusy] = useState(false);
  const [nameInvalid, setNameInvalid] = useState(false);
  const [schemaConflict, setSchemaConflict] = useState(false);
  const [viewConflict, setViewConflict] = useState(false);
  const lock = useRef(false);
  const attempt = useRef(new MutationAttempt());
  const nameInput = useRef<HTMLInputElement>(null);
  const focusName = useRef(false);
  const closing = useRef(false);
  useEffect(() => {
    if (!busy && focusName.current) {
      focusName.current = false;
      nameInput.current?.focus();
    }
  }, [busy]);
  const confirmation = useConfirmation();
  const initialName =
    snapshot.kind === "rename"
      ? snapshot.selected!.name
      : snapshot.selected
        ? `${snapshot.selected.name.slice(0, 115)} copy`
        : "";
  const initialVisibility =
    snapshot.kind === "rename" ? snapshot.selected!.visibility : "personal";
  async function close() {
    if (lock.current || closing.current) return;
    closing.current = true;
    try {
      if (
        (name === initialName && visibility === initialVisibility) ||
        (await confirmation.confirm(
          "Discard view changes?",
          "The name and visibility changes will be discarded.",
          "Discard changes",
        ))
      )
        onClose();
    } finally {
      closing.current = false;
    }
  }
  async function submit() {
    if (lock.current || schemaConflict || viewConflict) return;
    if (!AccountNameSchema.safeParse(name).success) {
      setNameInvalid(true);
      toast.danger("Enter a view name of up to 120 characters.");
      nameInput.current?.focus();
      return;
    }
    lock.current = true;
    setBusy(true);
    const input = {
      ...target,
      expectedSchemaVersion: schemaVersion,
      name: name.trim(),
      visibility,
      ...(snapshot.kind === "create"
        ? { definition: snapshot.definition }
        : {
            viewId: snapshot.selected!.id,
            expectedVersion: snapshot.selected!.version,
          }),
    };
    try {
      const view = await client.operation<SavedView>(
        snapshot.kind === "create" ? "createSavedView" : "updateSavedView",
        input,
        { idempotencyKey: attempt.current.forInput(input) },
      );
      attempt.current.clear();
      await onComplete(view, snapshot.kind);
      toast.success(
        snapshot.kind === "create" ? "View created" : "View updated",
      );
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === "SCHEMA_VERSION_CONFLICT") setSchemaConflict(true);
        if (error.code === "VIEW_VERSION_CONFLICT") setViewConflict(true);
        if (error.code === "VIEW_NAME_CONFLICT") {
          setNameInvalid(true);
          focusName.current = true;
        }
      }
      toast.danger(
        error instanceof Error ? error.message : "The view could not be saved.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        title={
          snapshot.kind === "create" ? "Save view" : "Rename or share view"
        }
        onClose={() => void close()}
        closeDisabled={busy}
      >
        <Form
          noValidate
          busy={busy}
          submit={snapshot.kind === "create" ? "Create view" : "Save changes"}
          submitDisabled={schemaConflict || viewConflict}
          onSubmit={submit}
          onCancel={() => void close()}
        >
          <TextField
            className="settings-field"
            isRequired
            isInvalid={nameInvalid}
            value={name}
            onChange={(value) => {
              setName(value);
              setNameInvalid(false);
            }}
            validationBehavior="aria"
          >
            <Label>View name</Label>
            <Input
              ref={nameInput}
              variant="secondary"
              maxLength={120}
              autoComplete="off"
              autoFocus={
                typeof window !== "undefined" &&
                window.matchMedia("(pointer: fine)").matches
              }
            />
          </TextField>
          <Select
            variant="secondary"
            className="settings-field"
            value={visibility}
            onChange={(value) => {
              if (value === "personal" || value === "shared")
                setVisibility(value);
            }}
            disabledKeys={!canShare ? ["shared"] : []}
            isDisabled={
              busy ||
              (snapshot.kind === "rename" &&
                !snapshot.selected?.canChangeVisibility)
            }
          >
            <Label>Visibility</Label>
            <Select.Trigger>
              <Select.Value>
                <span className="flex items-center gap-2">
                  <HugeiconsIcon
                    icon={
                      visibility === "personal"
                        ? UserAccountIcon
                        : UserGroupIcon
                    }
                    size={16}
                    aria-hidden="true"
                  />
                  {visibility === "personal" ? "Personal" : "Shared"}
                </span>
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="personal" textValue="Personal">
                  <HugeiconsIcon
                    icon={UserAccountIcon}
                    size={16}
                    aria-hidden="true"
                  />
                  Personal
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item id="shared" textValue="Shared">
                  <HugeiconsIcon
                    icon={UserGroupIcon}
                    size={16}
                    aria-hidden="true"
                  />
                  Shared
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
          <p className="text-sm text-muted">
            {visibility === "shared"
              ? "People with access to this table can use this view. Sharing a view does not grant access to its data."
              : "Only you can use this view."}
          </p>
          {schemaConflict && (
            <Button
              variant="secondary"
              isDisabled={busy}
              onPress={async () => {
                const version = await onReloadFields();
                if (version) {
                  setSchemaVersion(version);
                  setSchemaConflict(false);
                }
              }}
            >
              Reload fields
            </Button>
          )}
          {viewConflict && (
            <p className="text-sm text-muted">
              Close this dialog and reload the saved view before trying again.
              Your draft is kept until you close it.
            </p>
          )}
        </Form>
      </Dialog>
      {confirmation.dialog}
    </>
  );
}
