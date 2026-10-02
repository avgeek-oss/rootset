"use client";

import { Button } from "@heroui/react";
import { scopeNames, type StorageAdmission } from "@rootset/contracts";
import { useEffect, useState } from "react";
import {
  organisationPath,
  performAction,
  useMutation,
  useResource,
  write,
  writeRaw,
} from "./api";
import {
  Choice,
  DateLabel,
  Empty,
  Feedback,
  Field,
  Form,
  Loading,
  Record,
  RecordList,
  Section,
  Status,
  Toggle,
  useConfirmation,
} from "./ui";
import type {
  ApiKey,
  AuditEvent,
  Connection,
  Invitation,
  Member,
  Organisation,
  Preferences,
  Profile,
  Session,
  SettingsPanelProps,
} from "./types";

export function OrganisationSettings(props: SettingsPanelProps) {
  const path = organisationPath(props.orgId);
  const resource = useResource<Organisation | null>(path, null);
  const usage = useResource<{
    databases: number;
    tables: number;
    rows: number;
    dataBytes: number;
    indexBytes: number;
    historyBytes: number;
    artifactBytes: number;
    storageQuotaBytes: string | null;
    storageAdmission: StorageAdmission;
    admissionAvailable: boolean;
  } | null>(`${path}/usage`, null);
  const mutation = useMutation(() => {
    resource.reload();
    props.onChanged?.();
  });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nextOwner, setNextOwner] = useState("");
  const members = useResource<Member[]>(`${path}/members`, []);
  const confirmation = useConfirmation();
  useEffect(() => {
    if (resource.data) {
      setName(resource.data.name);
      setDescription(resource.data.description ?? "");
    }
  }, [resource.data]);
  return (
    <>
      <Loading {...resource} retry={resource.reload} />
      <Feedback {...mutation} />
      <Section
        title="Organisation usage"
        description="Native data, indexes, retained history and artifacts count towards storage admission. Unconfigured quotas are shown explicitly."
      >
        <Loading {...usage} retry={usage.reload} />
        {usage.data && (
          <>
            <p>
              <Status value={usage.data.storageAdmission.state} /> ·{" "}
              {usage.data.storageAdmission.reason ??
                (usage.data.admissionAvailable
                  ? "Growth is currently permitted."
                  : "Growth is currently refused.")}
            </p>
            <RecordList>
              <Record
                title="Databases / tables / rows"
                description={`${usage.data.databases.toLocaleString()} / ${usage.data.tables.toLocaleString()} / ${usage.data.rows.toLocaleString()}`}
              />
              <Record
                title="Data / index / retained history / artifact bytes"
                description={`${usage.data.dataBytes.toLocaleString()} / ${usage.data.indexBytes.toLocaleString()} / ${usage.data.historyBytes.toLocaleString()} / ${usage.data.artifactBytes.toLocaleString()}`}
              />
              <Record
                title="Organisation storage quota"
                description={
                  usage.data.storageQuotaBytes === null
                    ? "Not configured"
                    : `${BigInt(usage.data.storageQuotaBytes).toLocaleString()} bytes`
                }
              />
            </RecordList>
          </>
        )}
        <Button variant="secondary" onPress={usage.reload}>
          Refresh usage
        </Button>
      </Section>
      <Section title="Organisation details">
        <Form
          busy={mutation.busy}
          onSubmit={async () => {
            await mutation.run(
              () => write(path, "PATCH", { name, description }),
              "Organisation updated.",
            );
          }}
        >
          <Field
            label="Organisation name"
            value={name}
            onChange={setName}
            required
          />
          <Field
            label="Description"
            value={description}
            onChange={setDescription}
            multiline
          />
        </Form>
      </Section>
      <Section
        title="Ownership"
        description="Transfer ownership to a verified active member. Rootset keeps at least one active Owner."
      >
        <Form
          busy={mutation.busy}
          submit="Transfer ownership"
          onSubmit={async () => {
            if (
              await confirmation.confirm(
                "Transfer ownership?",
                "This changes who can manage ownership and delete the organisation.",
                "Transfer ownership",
              )
            )
              await mutation.run(
                () =>
                  performAction("transferOwnership", {
                    orgId: props.orgId,
                    userId: nextOwner,
                  }),
                "Ownership transferred.",
              );
          }}
        >
          <Choice
            label="New owner"
            value={nextOwner}
            onChange={setNextOwner}
            required
            options={members.data
              .filter(
                (member) =>
                  member.verified &&
                  !member.disabled &&
                  member.state !== "disabled",
              )
              .map((member) => ({
                value: member.userId,
                label: `${member.name ?? member.email} (${member.role})`,
              }))}
          />
        </Form>
      </Section>
      <Section
        title="Delete organisation"
        description="This starts a deletion job and requires recent authentication. Retained history and backup expiry follow the installation policy."
      >
        <Button
          variant="danger-soft"
          isDisabled={mutation.busy}
          onPress={async () => {
            if (
              await confirmation.confirm(
                "Delete this organisation?",
                `Delete ${name || "this organisation"} and its databases? This starts an irreversible deletion job.`,
                "Delete organisation",
              )
            )
              await mutation.run(
                () =>
                  performAction("deleteOrganisation", {
                    orgId: props.orgId,
                    confirmation: "DELETE",
                  }),
                "Organisation deletion requested. Check the job before leaving.",
              );
          }}
        >
          Delete organisation
        </Button>
      </Section>
      {confirmation.dialog}
    </>
  );
}

function MemberRow({
  member,
  busy,
  save,
  remove,
}: {
  member: Member;
  busy: boolean;
  save: (patch: object) => Promise<void>;
  remove: () => Promise<void>;
}) {
  const [role, setRole] = useState(member.role);
  const [enabled, setEnabled] = useState(
    member.state !== "disabled" && !member.disabled,
  );
  return (
    <Record
      title={member.name ?? member.email}
      description={
        <>
          {member.email} ·{" "}
          <Status
            value={member.state ?? (member.disabled ? "disabled" : "active")}
          />
        </>
      }
    >
      <Choice
        label={`Role for ${member.email}`}
        value={role}
        onChange={setRole}
        options={
          member.role === "owner"
            ? [
                { value: "owner", label: "Owner" },
                { value: "admin", label: "Admin" },
                { value: "editor", label: "Editor" },
                { value: "viewer", label: "Viewer" },
              ]
            : [
                { value: "admin", label: "Admin" },
                { value: "editor", label: "Editor" },
                { value: "viewer", label: "Viewer" },
              ]
        }
      />
      <Toggle
        label={`Active: ${member.email}`}
        selected={enabled}
        onChange={setEnabled}
      />
      <Button
        variant="secondary"
        size="sm"
        isDisabled={busy}
        onPress={() => save({ role, state: enabled ? "active" : "disabled" })}
      >
        Save
      </Button>
      <Button
        variant="danger-soft"
        size="sm"
        isDisabled={busy}
        onPress={remove}
      >
        Remove
      </Button>
    </Record>
  );
}

export function MembersSettings(props: SettingsPanelProps) {
  const path = organisationPath(props.orgId);
  const members = useResource<Member[]>(`${path}/members`, []);
  const invitations = useResource<Invitation[]>(`${path}/invitations`, []);
  const mutation = useMutation(() => {
    members.reload();
    invitations.reload();
    props.onChanged?.();
  });
  const confirmation = useConfirmation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  return (
    <>
      <Feedback {...mutation} />
      <Section
        title="Invite a person"
        description="Rootset emails a single-use invitation. The recipient sets up their own credentials."
      >
        <Form
          busy={mutation.busy}
          submit="Send invitation"
          onSubmit={async () => {
            const result = await mutation.run(
              () => write(`${path}/invitations`, "POST", { email, role }),
              "Invitation sent.",
            );
            if (result.ok) setEmail("");
          }}
        >
          <Field
            label="Email address"
            value={email}
            onChange={setEmail}
            type="email"
            autoComplete="email"
            required
          />
          <Choice
            label="Role"
            value={role}
            onChange={setRole}
            options={[
              { value: "admin", label: "Admin" },
              { value: "editor", label: "Editor" },
              { value: "viewer", label: "Viewer" },
            ]}
          />
        </Form>
      </Section>
      <Section title="Members">
        <Loading {...members} retry={members.reload} />
        {!members.loading && !members.error && members.data.length === 0 && (
          <Empty>No members are visible.</Empty>
        )}
        <RecordList>
          {members.data.map((member) => (
            <MemberRow
              key={`${member.id}:${member.role}:${member.state}`}
              member={member}
              busy={mutation.busy}
              save={async (patch) => {
                await mutation.run(
                  () =>
                    write(`${path}/members/${member.id}`, "PATCH", {
                      ...patch,
                      expectedVersion: member.version,
                    }),
                  "Member updated.",
                );
              }}
              remove={async () => {
                if (
                  await confirmation.confirm(
                    "Remove member?",
                    `${member.email} will lose access to this organisation. Personal keys and grants are rechecked immediately.`,
                    "Remove member",
                  )
                )
                  await mutation.run(
                    () =>
                      write(`${path}/members/${member.id}`, "DELETE", {
                        expectedVersion: member.version,
                      }),
                    "Member removed.",
                  );
              }}
            />
          ))}
        </RecordList>
      </Section>
      <Section title="Invitations">
        <Loading {...invitations} retry={invitations.reload} />
        <RecordList>
          {invitations.data.map((invitation) => (
            <Record
              key={invitation.id}
              title={invitation.email}
              description={
                <>
                  {invitation.role} ·{" "}
                  <Status
                    value={invitation.status ?? invitation.state ?? "pending"}
                  />{" "}
                  · expires <DateLabel value={invitation.expiresAt} />
                </>
              }
            >
              <Button
                size="sm"
                variant="secondary"
                isDisabled={
                  mutation.busy ||
                  ["accepted", "cancelled"].includes(
                    invitation.status ?? invitation.state ?? "",
                  )
                }
                onPress={() =>
                  mutation
                    .run(
                      () =>
                        write(`${path}/invitations/${invitation.id}`, "DELETE"),
                      "Invitation cancelled.",
                    )
                    .then(() => undefined)
                }
              >
                Cancel invitation
              </Button>
            </Record>
          ))}
        </RecordList>
        {!invitations.loading &&
          !invitations.error &&
          invitations.data.length === 0 && <Empty>No invitations.</Empty>}
      </Section>
      {confirmation.dialog}
    </>
  );
}

interface ResourceGrant {
  membershipId: string;
  unrestricted: boolean;
  version: number;
  targets: { databaseId?: string; tableId?: string; level: string }[];
}
export function GrantsSettings(props: SettingsPanelProps) {
  const path = organisationPath(props.orgId);
  const members = useResource<Member[]>(`${path}/members`, []);
  const grants = useResource<ResourceGrant[]>(`${path}/grants`, []);
  const databases = useResource<{ id: string; name: string }[]>(
    `${path}/databases`,
    [],
  );
  const [userId, setUserId] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [targets, setTargets] = useState<ResourceGrant["targets"]>([]);
  const [databaseId, setDatabaseId] = useState("");
  const [tableId, setTableId] = useState("");
  const [level, setLevel] = useState("read");
  const tables = useResource<{ id: string; name: string }[]>(
    databaseId && databaseId !== "__organisation"
      ? `${path}/databases/${databaseId}/tables`
      : undefined,
    [],
  );
  const mutation = useMutation(() => {
    grants.reload();
    props.onChanged?.();
  });
  useEffect(() => {
    const grant = grants.data.find((item) => item.membershipId === userId);
    setRestricted(grant ? !grant.unrestricted : false);
    setTargets(grant?.targets ?? []);
  }, [userId, grants.data]);
  return (
    <>
      <Feedback {...mutation} />
      <Loading {...grants} retry={grants.reload} />
      <Section
        title="Resource access"
        description="Role and resource grants intersect. Owners and Admins retain organisation access; a manage grant cannot allow an Editor to manage people or team keys."
      >
        <Form
          busy={mutation.busy}
          onSubmit={async () => {
            await mutation.run(
              () =>
                write(`${path}/grants`, "PATCH", {
                  grants: [
                    {
                      membershipId: userId,
                      unrestricted: !restricted,
                      targets,
                      version:
                        grants.data.find((item) => item.membershipId === userId)
                          ?.version ?? 1,
                    },
                  ],
                }),
              "Resource access updated.",
            );
          }}
        >
          <Choice
            label="Member"
            value={userId}
            onChange={setUserId}
            required
            options={members.data
              .filter((member) => !["owner", "admin"].includes(member.role))
              .map((member) => ({
                value: member.id,
                label: `${member.name ?? member.email} (${member.role})`,
              }))}
          />
          <Toggle
            label="Restrict access to the resources below"
            selected={restricted}
            onChange={setRestricted}
            description="When disabled, shared data is readable by default within the member's role."
          />
          <RecordList>
            {targets.map((target, index) => (
              <Record
                key={`${target.databaseId}:${target.tableId}`}
                title={
                  target.tableId
                    ? (tables.data.find((table) => table.id === target.tableId)
                        ?.name ?? target.tableId)
                    : !target.databaseId
                      ? "All organisation resources, including future databases"
                      : (databases.data.find(
                          (database) => database.id === target.databaseId,
                        )?.name ?? target.databaseId)
                }
                description={`${target.tableId ? "Table" : target.databaseId ? "Database" : "Organisation resources"} · ${target.level}`}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() =>
                    setTargets((previous) =>
                      previous.filter((_, position) => position !== index),
                    )
                  }
                >
                  Remove grant
                </Button>
              </Record>
            ))}
          </RecordList>
          <div className="settings-inline">
            <Choice
              label="Database"
              value={databaseId}
              onChange={(value) => {
                setDatabaseId(value);
                setTableId("");
              }}
              options={[
                {
                  value: "__organisation",
                  label:
                    "All organisation resources, including future databases",
                },
                ...databases.data.map((database) => ({
                  value: database.id,
                  label: database.name,
                })),
              ]}
            />
            {databaseId !== "__organisation" && (
              <Choice
                label="Table (optional)"
                value={tableId || "__all"}
                onChange={(value) => setTableId(value === "__all" ? "" : value)}
                options={[
                  { value: "__all", label: "Entire database" },
                  ...tables.data.map((table) => ({
                    value: table.id,
                    label: table.name,
                  })),
                ]}
              />
            )}
            <Choice
              label="Access"
              value={level}
              onChange={setLevel}
              options={["read", "edit", "manage"]}
            />
          </div>
          <Button
            variant="secondary"
            isDisabled={!databaseId}
            onPress={() =>
              setTargets((previous) => [
                ...previous.filter(
                  (target) =>
                    !(
                      target.databaseId ===
                        (databaseId === "__organisation"
                          ? undefined
                          : databaseId) &&
                      target.tableId === (tableId || undefined)
                    ),
                ),
                {
                  ...(databaseId === "__organisation" ? {} : { databaseId }),
                  ...(tableId ? { tableId } : {}),
                  level,
                },
              ])
            }
          >
            Add resource grant
          </Button>
        </Form>
      </Section>
    </>
  );
}

const SCOPES = scopeNames;
export function KeysSettings(props: SettingsPanelProps) {
  const [owner, setOwner] = useState("personal");
  const path =
    owner === "personal" ? "/me/keys" : `${organisationPath(props.orgId)}/keys`;
  const resource = useResource<ApiKey[]>(path, []);
  const mutation = useMutation(() => {
    resource.reload();
    props.onChanged?.();
  });
  const confirmation = useConfirmation();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState(["rows:read", "tables:read"]);
  const [expires, setExpires] = useState(() =>
    new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
  );
  const [secret, setSecret] = useState("");
  const [unrestricted, setUnrestricted] = useState(false);
  const [targetDatabase, setTargetDatabase] = useState(props.databaseId ?? "");
  const [targetTable, setTargetTable] = useState(props.tableId ?? "");
  return (
    <>
      <Choice
        label="Key ownership"
        value={owner}
        onChange={(value) => {
          setOwner(value);
          setSecret("");
        }}
        options={[
          { value: "personal", label: "Personal keys" },
          { value: "team", label: "Team keys" },
        ]}
      />
      <Feedback {...mutation} />
      {secret && (
        <Section
          title="Copy your new key"
          description="This secret is displayed once. Store it before dismissing this panel; it cannot be retrieved later."
        >
          <Field
            label="API key secret"
            type="password"
            value={secret}
            onChange={() => undefined}
            readOnly
          />
          <div className="settings-actions">
            <Button
              onPress={() =>
                mutation
                  .run(
                    () => navigator.clipboard.writeText(secret),
                    "Key copied.",
                  )
                  .then(() => undefined)
              }
            >
              Copy key
            </Button>
            <Button variant="secondary" onPress={() => setSecret("")}>
              Dismiss secret
            </Button>
          </div>
        </Section>
      )}
      <Section
        title="Create API key"
        description={
          owner === "team"
            ? "Team keys belong to the organisation and continue working when their creator leaves. Creating one requires recent authentication."
            : "A personal key is limited by your current role and resource access."
        }
      >
        <Form
          busy={mutation.busy}
          submit="Create key"
          onSubmit={async () => {
            const result = await mutation.run(
              () =>
                performAction<ApiKey & { secret?: string }>(
                  owner === "team" ? "createTeamKey" : "createPersonalKey",
                  {
                    orgId: props.orgId,
                    name,
                    scopes,
                    unrestricted,
                    targets: unrestricted
                      ? []
                      : [
                          {
                            ...(targetDatabase
                              ? { databaseId: targetDatabase }
                              : {}),
                            ...(targetTable ? { tableId: targetTable } : {}),
                            level: scopes.some((scope) =>
                              scope.endsWith(":manage"),
                            )
                              ? "manage"
                              : scopes.some((scope) => scope.endsWith(":write"))
                                ? "edit"
                                : "read",
                          },
                        ].filter((target) => Object.keys(target).length),
                    expiresAt: expires ? `${expires}T23:59:59.999Z` : null,
                  },
                ),
              "Key created.",
            );
            if (result.ok) {
              setSecret(result.value.secret ?? "");
              setName("");
            }
          }}
        >
          <Field label="Key name" value={name} onChange={setName} required />
          <Field
            label="Expires on (UTC)"
            type="date"
            value={expires}
            onChange={setExpires}
            description="Only an Owner or Admin can approve a non-expiring key."
          />
          <Toggle
            label="All currently permitted resources"
            selected={unrestricted}
            onChange={setUnrestricted}
          />
          <div className="settings-inline">
            <Field
              label="Database target ID"
              value={targetDatabase}
              onChange={setTargetDatabase}
            />
            <Field
              label="Table target ID"
              value={targetTable}
              onChange={setTargetTable}
            />
          </div>
          <fieldset className="settings-scope-list">
            <legend>Allowed operations</legend>
            {SCOPES.map((scope) => (
              <Toggle
                key={scope}
                label={scope}
                selected={scopes.includes(scope)}
                onChange={(selected) =>
                  setScopes((previous) =>
                    selected
                      ? [...previous, scope]
                      : previous.filter((value) => value !== scope),
                  )
                }
              />
            ))}
          </fieldset>
        </Form>
      </Section>
      <Section title={owner === "team" ? "Team keys" : "Your keys"}>
        <Loading {...resource} retry={resource.reload} />
        <RecordList>
          {resource.data.map((key) => (
            <Record
              key={key.id}
              title={key.name}
              description={
                <>
                  {key.prefix} · {key.scopes.join(", ")}
                  <br />
                  Expires <DateLabel value={key.expiresAt} /> · last used{" "}
                  <DateLabel value={key.lastUsedAt} />
                  {key.revokedAt && (
                    <>
                      {" "}
                      · revoked <DateLabel value={key.revokedAt} />
                    </>
                  )}
                </>
              }
            >
              <Button
                size="sm"
                variant="secondary"
                isDisabled={mutation.busy || Boolean(key.revokedAt)}
                onPress={async () => {
                  if (
                    await confirmation.confirm(
                      "Rotate API key?",
                      "Create a replacement key. Copy its secret and update your integration before revoking the old key.",
                      "Rotate key",
                    )
                  ) {
                    const result = await mutation.run(
                      () =>
                        performAction<ApiKey & { secret?: string }>(
                          owner === "team"
                            ? "rotateTeamKey"
                            : "rotatePersonalKey",
                          {
                            ...(owner === "team" ? { orgId: props.orgId } : {}),
                            id: key.id,
                            overlapSeconds: 3600,
                          },
                        ),
                      "Key rotated. The old key expires after the overlap window.",
                    );
                    if (result.ok) setSecret(result.value.secret ?? "");
                  }
                }}
              >
                Rotate
              </Button>
              <Button
                size="sm"
                variant="danger-soft"
                isDisabled={mutation.busy || Boolean(key.revokedAt)}
                onPress={async () => {
                  if (
                    await confirmation.confirm(
                      "Revoke API key?",
                      "Requests using this key will fail immediately.",
                      "Revoke key",
                    )
                  )
                    await mutation.run(
                      () => write(`${path}/${key.id}`, "DELETE"),
                      "Key revoked.",
                    );
                }}
              >
                Revoke
              </Button>
            </Record>
          ))}
        </RecordList>
        {!resource.loading && !resource.error && !resource.data.length && (
          <Empty>No keys.</Empty>
        )}
      </Section>
      {confirmation.dialog}
    </>
  );
}

export function ProfileSettings(props: SettingsPanelProps) {
  const resource = useResource<Profile | null>("/me/profile", null);
  const mutation = useMutation(() => {
    resource.reload();
    props.onChanged?.();
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  useEffect(() => {
    if (resource.data) {
      setName(resource.data.name ?? resource.data.displayName ?? "");
      setEmail(resource.data.email);
    }
  }, [resource.data]);
  return (
    <>
      <Loading {...resource} retry={resource.reload} />
      <Feedback {...mutation} />
      <Section title="Your profile">
        <Form
          busy={mutation.busy}
          onSubmit={async () => {
            await mutation.run(
              () => write("/me/profile", "PATCH", { name }),
              "Profile updated.",
            );
          }}
        >
          <Field
            label="Display name"
            value={name}
            onChange={setName}
            autoComplete="name"
            required
          />
          <Field
            label="Current email"
            value={resource.data?.email ?? ""}
            onChange={() => undefined}
            readOnly
          />
          <p className="settings-muted">
            {resource.data?.emailVerified
              ? "Email verified."
              : "Email verification is pending."}
          </p>
        </Form>
      </Section>
      <Section
        title="Change email"
        description="Verify your new address before it replaces the current one. Both addresses receive security notices."
      >
        <Form
          busy={mutation.busy}
          submit="Start email change"
          onSubmit={async () => {
            await mutation.run(
              () => performAction("changeEmail", { newEmail: email }),
              "Email change started. Complete identity approval and verify the new address.",
            );
          }}
        >
          <Field
            label="New email address"
            value={email}
            onChange={setEmail}
            type="email"
            autoComplete="email"
            required
          />
        </Form>
      </Section>
    </>
  );
}

export function PreferencesSettings(props: SettingsPanelProps) {
  const resource = useResource<Preferences | null>("/me/preferences", null);
  const mutation = useMutation(() => {
    resource.reload();
    props.onChanged?.();
  });
  const [preferences, setPreferences] = useState<Preferences>({
    timezone: "UTC",
    locale: "en",
    dateFormat: "YYYY-MM-DD",
    timeFormat: "24h",
    theme: "system",
  });
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (resource.data) setPreferences(resource.data);
  }, [resource.data]);
  function patch<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences((previous) => ({ ...previous, [key]: value }));
  }
  function previewValue() {
    try {
      setPreview(
        new Intl.DateTimeFormat(preferences.locale, {
          dateStyle: "medium",
          timeStyle: "medium",
          timeZone: preferences.timezone,
          hour12: preferences.timeFormat === "12h",
        }).format(new Date("2026-10-02T12:34:56.000Z")),
      );
    } catch {
      setPreview("Enter a valid IANA timezone and locale.");
    }
  }
  return (
    <>
      <Loading {...resource} retry={resource.reload} />
      <Feedback {...mutation} />
      <Section
        title="Viewing preferences"
        description="Date-time cells are shown in your timezone and sent to Rootset as UTC. Date-only cells keep their calendar date; time-only cells remain UTC."
      >
        <Form
          busy={mutation.busy}
          onSubmit={async () => {
            await mutation.run(
              () => write("/me/preferences", "PATCH", preferences),
              "Viewing preferences saved.",
            );
          }}
        >
          <Field
            label="IANA timezone"
            value={preferences.timezone}
            onChange={(value) => patch("timezone", value)}
            description="For example, UTC, Asia/Kolkata, or America/New_York."
            required
          />
          <Field
            label="Locale"
            value={preferences.locale}
            onChange={(value) => patch("locale", value)}
            required
          />
          <Choice
            label="Date format"
            value={preferences.dateFormat}
            onChange={(value) => patch("dateFormat", value)}
            options={["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"]}
          />
          <Choice
            label="Time format"
            value={preferences.timeFormat}
            onChange={(value) =>
              patch("timeFormat", value as Preferences["timeFormat"])
            }
            options={["24h", "12h"]}
          />
          <Choice
            label="Appearance"
            value={preferences.theme}
            onChange={(value) => patch("theme", value as Preferences["theme"])}
            options={["system", "light", "dark"]}
          />
          <Button variant="secondary" onPress={previewValue}>
            Preview formatting
          </Button>
          {preview && (
            <p role="status" className="settings-preview">
              {preview}
              <small>Stored value: 2026-10-02T12:34:56.000Z</small>
            </p>
          )}
        </Form>
      </Section>
    </>
  );
}

export function SessionsSettings() {
  const resource = useResource<Session[]>("/me/sessions", []);
  const mutation = useMutation(resource.reload);
  const confirmation = useConfirmation();
  return (
    <>
      <Feedback {...mutation} />
      <Section
        title="Browser sessions"
        description="Revocation takes effect on the next request. API keys and connected applications are managed separately."
      >
        <Loading {...resource} retry={resource.reload} />
        <RecordList>
          {resource.data.map((session) => (
            <Record
              key={session.id}
              title={
                session.current
                  ? "This browser"
                  : (session.userAgent ?? "Browser session")
              }
              description={
                <>
                  {session.ipAddress ?? "Address unavailable"} · last active{" "}
                  <DateLabel value={session.lastActivityAt} /> · expires{" "}
                  <DateLabel value={session.expiresAt} />
                </>
              }
            >
              <Button
                variant="danger-soft"
                size="sm"
                isDisabled={mutation.busy}
                onPress={async () => {
                  if (
                    await confirmation.confirm(
                      "Revoke session?",
                      session.current
                        ? "This will sign you out of the current browser."
                        : "This browser will be signed out.",
                      "Revoke session",
                    )
                  )
                    await mutation.run(
                      () => write(`/me/sessions/${session.id}`, "DELETE"),
                      "Session revoked.",
                    );
                }}
              >
                Revoke
              </Button>
            </Record>
          ))}
        </RecordList>
        <Button
          variant="secondary"
          isDisabled={mutation.busy}
          onPress={async () => {
            if (
              await confirmation.confirm(
                "Sign out everywhere?",
                "All browser sessions will be revoked. This requires recent authentication.",
                "Sign out everywhere",
              )
            )
              await mutation.run(
                () =>
                  performAction("signOutEverywhere", {
                    revokeDelegated: false,
                  }),
                "Sign-out action started. Complete identity approval.",
              );
          }}
        >
          Sign out everywhere
        </Button>
      </Section>
      {confirmation.dialog}
    </>
  );
}

export function ConnectionsSettings() {
  const resource = useResource<Connection[]>("/me/connections", []);
  const mutation = useMutation(resource.reload);
  const confirmation = useConfirmation();
  return (
    <>
      <Feedback {...mutation} />
      <Section
        title="Connected applications"
        description="OAuth consent applies to the selected organisation, scopes, resources, and audience. Revoking access also prevents future token refresh."
      >
        <Loading {...resource} retry={resource.reload} />
        <RecordList>
          {resource.data.map((connection) => (
            <Record
              key={connection.id}
              title={
                connection.clientName ??
                connection.clientId ??
                "Connected application"
              }
              description={
                <>
                  {connection.clientId} · {connection.orgId} ·{" "}
                  {connection.audience}
                  <br />
                  {connection.scopes.join(", ")} · expires{" "}
                  <DateLabel value={connection.expiresAt} />
                  {connection.revokedAt && (
                    <>
                      {" "}
                      · revoked <DateLabel value={connection.revokedAt} />
                    </>
                  )}
                  {connection.targets.map((target, index) => (
                    <span key={index}>
                      <br />
                      {target.databaseId && (
                        <>Database {target.databaseId} · </>
                      )}
                      {target.tableId && <>Table {target.tableId} · </>}
                      {target.level}
                    </span>
                  ))}
                </>
              }
            >
              <Button
                size="sm"
                variant="danger-soft"
                isDisabled={mutation.busy || Boolean(connection.revokedAt)}
                onPress={async () => {
                  if (
                    await confirmation.confirm(
                      "Revoke application access?",
                      "This application will no longer be able to access Rootset with this grant.",
                      "Revoke access",
                    )
                  )
                    await mutation.run(
                      () => write(`/me/connections/${connection.id}`, "DELETE"),
                      "Application access revoked.",
                    );
                }}
              >
                Revoke
              </Button>
            </Record>
          ))}
        </RecordList>
        {!resource.loading && !resource.error && !resource.data.length && (
          <Empty>No connected applications.</Empty>
        )}
      </Section>
      {confirmation.dialog}
    </>
  );
}

export function AuditSettings(props: SettingsPanelProps) {
  const [operation, setOperation] = useState("");
  const [actorId, setActorId] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const mutation = useMutation();
  async function query(next: string | null = null) {
    const result = await mutation.run(
      () =>
        writeRaw<{
          data: AuditEvent[];
          nextCursor?: string;
          page?: { nextCursor?: string };
        }>(`${organisationPath(props.orgId)}/audit/query`, "POST", {
          operationId: operation || undefined,
          actorId: actorId || undefined,
          limit: 100,
          cursor: next,
        }),
      "Audit query complete.",
    );
    if (result.ok) {
      const response = result.value;
      setEvents((previous) =>
        next ? [...previous, ...response.data] : response.data,
      );
      setCursor(response.nextCursor ?? response.page?.nextCursor ?? null);
    }
  }
  return (
    <>
      <Feedback {...mutation} />
      <Section
        title="Organisation audit"
        description="Audit entries contain redacted account, schema, and organisation events. Cell history is available from the spreadsheet."
      >
        <Form
          busy={mutation.busy}
          submit="Query audit"
          onSubmit={() => query()}
        >
          <div className="settings-inline">
            <Field
              label="Operation (optional)"
              value={operation}
              onChange={setOperation}
            />
            <Field
              label="Actor ID (optional)"
              value={actorId}
              onChange={setActorId}
            />
          </div>
        </Form>
        <RecordList>
          {events.map((event) => (
            <Record
              key={event.id}
              title={event.operationId ?? event.operation}
              description={
                <>
                  {event.actorKind} {event.actorId} ·{" "}
                  {typeof event.outcome === "string"
                    ? event.outcome
                    : "Recorded"}{" "}
                  · <DateLabel value={event.createdAt ?? event.timestamp} />
                  <br />
                  {event.targetId}{" "}
                  {event.requestId && <>· reference {event.requestId}</>}
                </>
              }
            />
          ))}
        </RecordList>
        {cursor && (
          <Button
            variant="secondary"
            isDisabled={mutation.busy}
            onPress={() => query(cursor)}
          >
            Load more events
          </Button>
        )}
      </Section>
    </>
  );
}
