"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  InviteMemberDialog,
  MembersTable,
  MemberEditDialog,
  InvitationsTable,
  RemoveMemberDialog,
  RevokeInvitationDialog,
  TeamGeneralSettings,
} from "@avgeek-oss/design-system";
import type { ChoiceOption } from "@avgeek-oss/design-system/patterns/choice-field";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import {
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { RootsetClient } from "@rootset/web-client";
import { MemberSchema, InvitationSchema } from "@rootset/contracts";
import type { z } from "zod";
import { organisationPath, useResource, write } from "./api";
import { FormCard } from "./account/page-parts";
import { PageSelectionTitle } from "./account/page-selection-title";
import { RelativeTime } from "./account/last-synced-time";
import type { Organisation, SettingsPanelProps } from "./types";

const client = new RootsetClient();
type Member = z.infer<typeof MemberSchema>;
type Invitation = z.infer<typeof InvitationSchema>;
type Page<T> = { data: T[]; nextCursor?: string | null; hasMore?: boolean };
const roles: readonly ChoiceOption<Member["role"]>[] = [
  {
    id: "admin",
    label: "Admin",
    description: "Manage the installation, data and team.",
  },
  {
    id: "member",
    label: "Member",
    description: "Read data and create, edit or delete rows.",
  },
  { id: "viewer", label: "Viewer", description: "Read and export data." },
];

export function OrganisationSettings(props: SettingsPanelProps) {
  const path = organisationPath(props.orgId);
  const resource = useResource<Organisation | null>(path, null);
  if (resource.error)
    return (
      <QueryError message={resource.error.message} onRetry={resource.reload} />
    );
  if (!resource.data) return <QueryLoading />;
  return (
    <div className="content-grid lg:grid-cols-2 lg:items-start">
      <TeamGeneralSettings
        value={resource.data.name}
        maxLength={120}
        onSave={async (name) => {
          await write(path, "PATCH", { name });
          resource.reload();
          props.onChanged?.();
        }}
      />
    </div>
  );
}

export function MembersSettings(props: SettingsPanelProps) {
  const path = organisationPath(props.orgId);
  const [memberCursors, setMemberCursors] = useState<Array<string | null>>([
    null,
  ]);
  const [inviteCursors, setInviteCursors] = useState<Array<string | null>>([
    null,
  ]);
  const memberCursor = memberCursors.at(-1);
  const inviteCursor = inviteCursors.at(-1);
  const members = useQuery({
    queryKey: ["team-members", props.orgId, memberCursor],
    queryFn: ({ signal }) =>
      client.operation<Page<Member>>(
        "listMembers",
        {
          orgId: props.orgId,
          limit: 25,
          ...(memberCursor ? { cursor: memberCursor } : {}),
        },
        { signal },
      ),
  });
  const invitations = useQuery({
    queryKey: ["team-invitations", props.orgId, inviteCursor],
    queryFn: ({ signal }) =>
      client.operation<Page<Invitation>>(
        "listInvitations",
        {
          orgId: props.orgId,
          state: "pending",
          limit: 25,
          ...(inviteCursor ? { cursor: inviteCursor } : {}),
        },
        { signal },
      ),
  });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function refresh() {
      setNow(Date.now());
      void invitations.refetch();
    }
    const nextExpiry = Math.min(
      ...(invitations.data?.data ?? [])
        .map((item) => Date.parse(item.expiresAt))
        .filter((time) => time > Date.now()),
    );
    if (Number.isFinite(nextExpiry))
      timer = setTimeout(
        refresh,
        Math.min(Math.max(1, nextExpiry - Date.now()), 2_147_483_647),
      );
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [invitations.data, invitations.refetch]);
  function changed() {
    setMemberCursors([null]);
    setInviteCursors([null]);
    void members.refetch();
    void invitations.refetch();
    props.onChanged?.();
  }
  const actions = useMemo(
    () => (
      <Button
        isDisabled={busy}
        onPress={() => {
          setInviteOpen(true);
        }}
      >
        Create invite
      </Button>
    ),
    [busy],
  );
  const items = (members.data?.data ?? []).map((member) => ({
    ...member,
    emailVerified: member.verified,
    accountStatus: {
      label: member.verified ? "Active" : "Email verification pending",
      color: member.verified ? ("success" as const) : ("warning" as const),
    },
    securityStatus: {
      label: member.twoFactorEnabled ? "Enabled" : "Not enabled",
      color: member.twoFactorEnabled
        ? ("success" as const)
        : ("danger" as const),
    },
  }));
  if (!members.data)
    return members.isError ? (
      <QueryError
        message={members.error.message}
        onRetry={() => void members.refetch()}
      />
    ) : (
      <QueryLoading />
    );
  return (
    <div className="content-grid">
      <PageSelectionTitle label="Members" actions={actions} />
      {members.isError && (
        <QueryError
          message={members.error.message}
          onRetry={() => void members.refetch()}
        />
      )}
      <MembersTable
        items={items}
        roles={roles}
        actions={(member) => (
          <>
            <Button
              variant="secondary"
              isDisabled={busy}
              onPress={() => setEditing(member)}
            >
              Edit
            </Button>
            <Button
              variant="danger"
              isDisabled={busy}
              onPress={() => setRemoving(member)}
            >
              Remove
            </Button>
          </>
        )}
      />
      <PageButtons
        label="Members"
        cursors={memberCursors}
        setCursors={setMemberCursors}
        nextCursor={members.data.nextCursor}
        disabled={members.isFetching || busy}
      />
      <FormCard title="Pending Invitations">
        {invitations.isError ? (
          <QueryError
            message={invitations.error.message}
            onRetry={() => void invitations.refetch()}
          />
        ) : !invitations.data ? (
          <QueryLoading />
        ) : (
          <>
            <InvitationsTable
              items={invitations.data.data.filter(
                (item) =>
                  item.state === "pending" && Date.parse(item.expiresAt) > now,
              )}
              roles={roles}
              formatDate={(value) => (
                <RelativeTime value={value} label="Expires" />
              )}
              actions={(invitation) => (
                <Button
                  variant="danger"
                  isDisabled={busy}
                  onPress={() => setRevoking(invitation)}
                >
                  Revoke
                </Button>
              )}
            />
            <PageButtons
              label="Invitations"
              cursors={inviteCursors}
              setCursors={setInviteCursors}
              nextCursor={invitations.data.nextCursor}
              disabled={invitations.isFetching || busy}
            />
          </>
        )}
      </FormCard>
      {removing && (
        <RemoveMemberDialog
          isOpen
          member={{ name: removing.name, email: removing.email }}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          onRemove={async () => {
            await write(`${path}/members/${removing.id}`, "DELETE", {
              expectedVersion: removing.version,
            });
            changed();
          }}
        />
      )}
      {revoking && (
        <RevokeInvitationDialog
          isOpen
          email={revoking.email}
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
          onRevoke={async () => {
            await write(`${path}/invitations/${revoking.id}`, "DELETE");
            changed();
          }}
        />
      )}
      {editing && (
        <MemberEditDialog
          isOpen
          member={editing}
          roles={roles}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSave={async (values) => {
            setBusy(true);
            try {
              await write(`${path}/members/${editing.id}`, "PATCH", {
                ...values,
                expectedVersion: editing.version,
              });
              toast.success("Member updated");
              changed();
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      <InviteMemberDialog
        isOpen={inviteOpen}
        onOpenChange={setInviteOpen}
        roles={roles}
        defaultRole="viewer"
        onInvite={async ({ email, role }) => {
          setBusy(true);
          try {
            const result = await write<{ inviteUrl: string }>(
              `${path}/invitations`,
              "POST",
              { email, role },
            );
            toast.success("Invitation created");
            changed();
            return result;
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function PageButtons({
  label,
  cursors,
  setCursors,
  nextCursor,
  disabled,
}: {
  label: string;
  cursors: Array<string | null>;
  setCursors: (cursors: Array<string | null>) => void;
  nextCursor?: string | null;
  disabled: boolean;
}) {
  if (cursors.length === 1 && !nextCursor) return null;
  return (
    <nav
      aria-label={`${label} pages`}
      className="flex items-center justify-end gap-3"
    >
      <span className="text-sm text-muted">Page {cursors.length}</span>
      <Button
        variant="secondary"
        isDisabled={disabled || cursors.length === 1}
        onPress={() => setCursors(cursors.slice(0, -1))}
      >
        Previous
      </Button>
      <Button
        variant="secondary"
        isDisabled={disabled || !nextCursor}
        onPress={() => {
          if (nextCursor) setCursors([...cursors, nextCursor]);
        }}
      >
        Next
      </Button>
    </nav>
  );
}
