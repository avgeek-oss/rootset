"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePageQuery as useQuery } from "./page-navigation";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { UserAvatar } from "@avgeek-oss/design-system/patterns/user-avatar";
import { ListBox, Select } from "@avgeek-oss/design-system/forms/select";
import {
  Autocomplete,
  SearchField,
} from "@avgeek-oss/design-system/pickers/autocomplete";
import {
  QueryError,
  QueryLoading,
  StatusIndicator,
  teamRoleOptions,
} from "@avgeek-oss/design-system";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { client } from "@rootset/web-client";
import type { Workspace, WorkspaceMember } from "@rootset/contracts";
import { Dialog } from "./dialog";
import { Field, Section } from "./settings/ui";
import type { SettingsPanelProps } from "./settings/types";
import { Plus, Save, Trash2, View } from "./ui/icons";
import { Dropdown, Label } from "@heroui/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Layers01Icon,
  ArrowDown01Icon,
  Add01Icon,
} from "@hugeicons/core-free-icons";
import { PageSelectionTitle } from "./settings/account/page-selection-title";
import { useSwitchWorkspace } from "./workspace-navigation";
import "./workspaces.css";
const showError = (error: unknown) =>
  toast.danger(
    error instanceof Error
      ? error.message
      : "The workspace could not be updated.",
  );

export function WorkspaceSwitcher({
  workspaces,
  current,
  orgId,
  canCreate,
}: {
  workspaces: Workspace[];
  current: Workspace;
  orgId: string;
  canCreate: boolean;
}) {
  const selectorId = useId();
  const switchWorkspace = useSwitchWorkspace();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const workspace = await client.operation<Workspace>(
        "createWorkspace",
        { orgId, name, description },
        { idempotencyKey: key.current },
      );
      setCreating(false);
      setBusy(false);
      switchWorkspace(workspace.id);
    } catch (error) {
      showError(error);
      setBusy(false);
    }
  }
  return (
    <>
      <div className="workspace-switcher">
        <Label htmlFor={selectorId} className="px-2 text-xs text-muted">
          Workspace
        </Label>
        <Dropdown>
          <Button
            id={selectorId}
            variant="secondary"
            className="w-full justify-between px-2"
            aria-label={`Workspace: ${current.name}`}
          >
            <span className="flex min-w-0 items-center gap-3">
              <HugeiconsIcon
                icon={Layers01Icon}
                size={16}
                className="shrink-0 text-muted"
                aria-hidden
              />
              <span className="truncate">{current.name}</span>
            </span>
            <HugeiconsIcon icon={ArrowDown01Icon} size={16} aria-hidden />
          </Button>
          <Dropdown.Popover placement="bottom start" className="w-64">
            <Dropdown.Menu
              aria-label="Choose workspace"
              selectionMode="single"
              selectedKeys={new Set([current.id])}
              onAction={(value) => {
                const id = String(value);
                if (id === "create-workspace") {
                  key.current = crypto.randomUUID();
                  setCreating(true);
                } else if (id !== current.id) switchWorkspace(id);
              }}
            >
              {workspaces.map((w) => (
                <Dropdown.Item id={w.id} key={w.id} textValue={w.name}>
                  <HugeiconsIcon
                    icon={Layers01Icon}
                    size={18}
                    className="text-muted"
                    aria-hidden
                  />
                  <Label>{w.name}</Label>
                </Dropdown.Item>
              ))}
              {canCreate && (
                <Dropdown.Item
                  id="create-workspace"
                  textValue="Create Workspace"
                >
                  <HugeiconsIcon icon={Add01Icon} size={18} aria-hidden />
                  <Label>Create Workspace</Label>
                </Dropdown.Item>
              )}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
      {creating && (
        <Dialog
          title="Create Workspace"
          closeDisabled={busy}
          onClose={() => setCreating(false)}
        >
          <form className="dialog-form" onSubmit={create}>
            <Field
              label="Workspace name"
              value={name}
              onChange={setName}
              required
              maxLength={120}
            />
            <Field
              label="Description"
              value={description}
              onChange={setDescription}
              multiline
              maxLength={4096}
            />
            <footer>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button type="submit" isPending={busy}>
                <Plus />
                Create Workspace
              </Button>
            </footer>
          </form>
        </Dialog>
      )}
    </>
  );
}

export function WorkspaceDetailsSettings(props: SettingsPanelProps) {
  const cache = useQueryClient();
  const workspace = useQuery({
    queryKey: ["workspace", props.workspaceId],
    queryFn: () =>
      client.operation<Workspace>("getWorkspace", {
        orgId: props.orgId,
        workspaceId: props.workspaceId,
      }),
  });
  if (workspace.isPending) return <QueryLoading />;
  if (workspace.isError)
    return (
      <QueryError
        message={workspace.error.message}
        onRetry={() => void workspace.refetch()}
      />
    );
  if (props.section === "workspace-danger-zone")
    return <WorkspaceDangerZone workspace={workspace.data} />;
  return (
    <WorkspaceGeneralForm
      key={`${workspace.data.id}:${workspace.data.updatedAt}`}
      workspace={workspace.data}
      onSaved={() => {
        void workspace.refetch();
        void cache.invalidateQueries({ queryKey: ["workspaces"] });
      }}
    />
  );
}
function WorkspaceGeneralForm({
  workspace,
  onSaved,
}: {
  workspace: Workspace;
  onSaved(): void;
}) {
  const [name, setName] = useState(workspace.name),
    [description, setDescription] = useState(workspace.description),
    [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await client.operation(
        "updateWorkspace",
        {
          orgId: workspace.orgId,
          workspaceId: workspace.id,
          name,
          description,
        },
        { idempotencyKey: crypto.randomUUID() },
      );
      toast.success("Workspace updated");
      onSaved();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="content-grid lg:grid-cols-2 lg:items-start">
      <Section title="Workspace details">
        <form className="dialog-form" onSubmit={save}>
          <Field
            label="Workspace name"
            value={name}
            onChange={setName}
            readOnly={workspace.isDefault}
            description={
              workspace.isDefault
                ? "Default is shared by all team members and cannot be renamed."
                : undefined
            }
            required
            maxLength={120}
          />
          <Field
            label="Description"
            value={description}
            onChange={setDescription}
            multiline
            maxLength={4096}
          />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" isPending={busy}>
              <Save />
              Save changes
            </Button>
          </div>
        </form>
      </Section>
    </div>
  );
}
function WorkspaceDangerZone({ workspace }: { workspace: Workspace }) {
  const switchWorkspace = useSwitchWorkspace();
  const [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState(false);
  return (
    <>
      <Section
        title="Delete workspace"
        description={
          workspace.isDefault
            ? "Default is shared by all team members and cannot be deleted."
            : "Delete this workspace after deleting all of its databases. This action cannot be undone."
        }
      >
        {!workspace.isDefault && (
          <Button variant="danger" onPress={() => setDeleting(true)}>
            <Trash2 />
            Delete workspace
          </Button>
        )}
      </Section>
      {deleting && (
        <Dialog
          title="Delete workspace"
          closeDisabled={busy}
          onClose={() => setDeleting(false)}
        >
          <div className="dialog-form">
            <p>
              Delete {workspace.name}? The workspace must have no databases.
              This action cannot be undone.
            </p>
            <footer>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => setDeleting(false)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                isPending={busy}
                onPress={async () => {
                  setBusy(true);
                  try {
                    await client.operation(
                      "deleteWorkspace",
                      { orgId: workspace.orgId, workspaceId: workspace.id },
                      { idempotencyKey: crypto.randomUUID() },
                    );
                    switchWorkspace(workspace.orgId);
                  } catch (error) {
                    showError(error);
                    setBusy(false);
                  }
                }}
              >
                <Trash2 />
                Delete workspace
              </Button>
            </footer>
          </div>
        </Dialog>
      )}
    </>
  );
}
function WorkspaceMemberIdentity({ member }: { member: WorkspaceMember }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <UserAvatar
        email={member.email}
        name={member.name}
        size="sm"
        className="shrink-0"
        aria-hidden
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate">{member.name}</span>
        <span className="truncate text-sm text-muted">{member.email}</span>
      </span>
    </span>
  );
}

function WorkspaceMemberSelect({
  members,
  value,
  onChange,
  disabled,
}: {
  members: WorkspaceMember[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [search, setSearch] = useState("");
  const selected = members.find((member) => member.userId === value);
  return (
    <Select
      variant="secondary"
      value={value || null}
      onChange={(key) => onChange(key ? String(key) : "")}
      isDisabled={disabled}
      onOpenChange={(open) => {
        if (!open) setSearch("");
      }}
    >
      <Label>Team member</Label>
      <Select.Trigger>
        <Select.Value className="min-w-0 flex-1">
          {selected ? (
            <WorkspaceMemberIdentity member={selected} />
          ) : (
            "Select a team member"
          )}
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="flex w-(--trigger-width) max-w-[calc(100vw-2rem)] flex-col overflow-hidden">
        <Autocomplete.Filter
          inputValue={search}
          onInputChange={setSearch}
          filter={(text, term) =>
            text.toLowerCase().includes(term.trim().toLowerCase())
          }
        >
          <SearchField
            aria-label="Search team members"
            variant="secondary"
            className="shrink-0 px-2 pt-2 pb-2"
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input
                placeholder="Search by name or email…"
                autoComplete="off"
                spellCheck={false}
              />
              <SearchField.ClearButton aria-label="Clear member search" />
            </SearchField.Group>
          </SearchField>
          <ListBox
            className="max-h-72 min-h-0 flex-1 overflow-y-auto overscroll-contain"
            renderEmptyState={() => "No matching team members"}
          >
            {members.map((member) => (
              <ListBox.Item
                id={member.userId}
                key={member.userId}
                textValue={`${member.name} ${member.email}`}
              >
                <WorkspaceMemberIdentity member={member} />
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Autocomplete.Filter>
      </Select.Popover>
    </Select>
  );
}

function WorkspaceMembersTable({
  members,
  onRemove,
  busy = false,
}: {
  members: WorkspaceMember[];
  onRemove?: (member: WorkspaceMember) => void;
  busy?: boolean;
}) {
  return (
    <ResourceTable
      ariaLabel="Workspace members"
      items={members}
      getRowKey={(m) => m.userId}
      emptyTitle="No members"
      emptyDescription="This workspace has no assigned members."
      columns={[
        {
          key: "name",
          header: "Name",
          cell: (m) => <WorkspaceMemberIdentity member={m} />,
        },
        {
          key: "role",
          header: "Role",
          cell: (m) => (
            <StatusIndicator
              label={
                teamRoleOptions.find((role) => role.id === m.role)?.label ??
                m.role
              }
            />
          ),
        },
        ...(onRemove
          ? [
              {
                key: "actions",
                header: "Actions",
                cell: (m: WorkspaceMember) => (
                  <Button
                    variant="danger-soft"
                    isDisabled={busy}
                    onPress={() => onRemove(m)}
                  >
                    <Trash2 />
                    Remove
                  </Button>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
export function WorkspaceAccessSettings(props: SettingsPanelProps) {
  const switchWorkspace = useSwitchWorkspace();
  const [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [adding, setAdding] = useState(false),
    [removing, setRemoving] = useState<WorkspaceMember | null>(null);
  const addAction = useMemo(
    () =>
      props.workspaceIsDefault ? undefined : (
        <Button onPress={() => setAdding(true)} isDisabled={busy}>
          <Plus />
          Add member
        </Button>
      ),
    [props.workspaceIsDefault, busy],
  );
  const members = useQuery({
    queryKey: ["workspace-members", props.workspaceId],
    queryFn: () =>
      client.operation<{ data: WorkspaceMember[] }>("listWorkspaceMembers", {
        orgId: props.orgId,
        workspaceId: props.workspaceId,
      }),
  });
  const team = useQuery({
    queryKey: ["workspace-team-members", props.orgId],
    queryFn: async () => {
      const data: WorkspaceMember[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.operation<{
          data: WorkspaceMember[];
          nextCursor: string | null;
        }>("listMembers", {
          orgId: props.orgId,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        data.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { data };
    },
  });
  async function change(operation: string, userId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await client.operation(
        operation,
        { orgId: props.orgId, workspaceId: props.workspaceId, userId },
        { idempotencyKey: crypto.randomUUID() },
      );
      setRemoving(null);
      if (operation === "removeWorkspaceMember" && userId === props.userId) {
        switchWorkspace(props.orgId);
        return;
      }
      setSelected("");
      setAdding(false);
      await members.refetch();
      toast.success(
        operation === "addWorkspaceMember" ? "Member added" : "Member removed",
      );
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }
  if (members.isPending || team.isPending) return <QueryLoading />;
  if (members.isError || team.isError)
    return (
      <QueryError
        message={
          members.error?.message ??
          team.error?.message ??
          "Members could not be loaded"
        }
        onRetry={() => {
          void members.refetch();
          void team.refetch();
        }}
      />
    );
  const options = team.data.data.filter(
    (m) => !members.data.data.some((entry) => entry.userId === m.userId),
  );
  return (
    <div className="grid gap-6">
      <PageSelectionTitle label="Manage Access" actions={addAction} />
      <WorkspaceMembersTable
        members={members.data.data}
        busy={busy}
        onRemove={props.workspaceIsDefault ? undefined : setRemoving}
      />
      {adding && (
        <Dialog
          title="Add member"
          closeDisabled={busy}
          onClose={() => setAdding(false)}
        >
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (selected) void change("addWorkspaceMember", selected);
            }}
          >
            <WorkspaceMemberSelect
              value={selected}
              members={options}
              onChange={setSelected}
              disabled={busy}
            />
            <footer>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => setAdding(false)}
              >
                Cancel
              </Button>
              <Button type="submit" isDisabled={!selected} isPending={busy}>
                <Plus />
                Add member
              </Button>
            </footer>
          </form>
        </Dialog>
      )}
      {removing && (
        <Dialog
          title="Remove member"
          closeDisabled={busy}
          onClose={() => setRemoving(null)}
        >
          <div className="dialog-form">
            <p>
              {removing.userId === props.userId
                ? "Remove yourself from this workspace? You will lose access to its databases and settings."
                : `Remove ${removing.name} from this workspace? They will lose access to its databases and settings.`}
            </p>
            <footer>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => setRemoving(null)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                isPending={busy}
                onPress={() =>
                  void change("removeWorkspaceMember", removing.userId)
                }
              >
                <Trash2 />
                Remove member
              </Button>
            </footer>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function TeamWorkspacesSettings(props: SettingsPanelProps) {
  const [selected, setSelected] = useState<Workspace | null>(null);
  const workspaces = useQuery({
    queryKey: ["team-workspaces", props.orgId],
    queryFn: () =>
      client.operation<{ data: Workspace[] }>("listTeamWorkspaces", {
        orgId: props.orgId,
      }),
  });
  const members = useQuery({
    queryKey: ["workspace-directory-members", selected?.id],
    queryFn: () =>
      client.operation<{ data: WorkspaceMember[] }>("listWorkspaceMembers", {
        orgId: props.orgId,
        workspaceId: selected!.id,
      }),
    enabled: !!selected,
  });
  if (workspaces.isPending) return <QueryLoading />;
  if (workspaces.isError)
    return (
      <QueryError
        message={workspaces.error.message}
        onRetry={() => void workspaces.refetch()}
      />
    );
  return (
    <>
      <ResourceTable
        ariaLabel="Team workspaces"
        emptyTitle="No workspaces"
        emptyDescription="Workspaces will appear here."
        items={workspaces.data.data}
        getRowKey={(w) => w.id}
        columns={[
          {
            key: "name",
            header: "Workspace",
            cell: (w) => (
              <div className="grid gap-1">
                <span>{w.name}</span>
                {w.description && (
                  <span className="text-sm text-muted">{w.description}</span>
                )}
              </div>
            ),
          },
          { key: "members", header: "Members", cell: (w) => w.memberCount },
          {
            key: "actions",
            header: "Actions",
            cell: (w) => (
              <Button variant="secondary" onPress={() => setSelected(w)}>
                <View />
                View members
              </Button>
            ),
          },
        ]}
      />
      {selected && (
        <Drawer
          isOpen
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <Drawer.Backdrop>
            <Drawer.Content placement="right">
              <Drawer.Dialog className="record-editor-drawer">
                <Drawer.Header className="record-editor-header">
                  <div>
                    <Drawer.Heading>Members</Drawer.Heading>
                    <p className="text-sm text-muted">{selected.name}</p>
                  </div>
                  <Drawer.CloseTrigger aria-label="Close members" />
                </Drawer.Header>
                <Drawer.Body className="record-editor-body">
                  {members.isPending ? (
                    <QueryLoading />
                  ) : members.isError ? (
                    <QueryError
                      message={members.error.message}
                      onRetry={() => void members.refetch()}
                    />
                  ) : (
                    <WorkspaceMembersTable members={members.data.data} />
                  )}
                </Drawer.Body>
              </Drawer.Dialog>
            </Drawer.Content>
          </Drawer.Backdrop>
        </Drawer>
      )}
    </>
  );
}
