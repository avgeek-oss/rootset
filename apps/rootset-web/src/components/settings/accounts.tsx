"use client";

import { Button } from "../ui/button";
import { useEffect, useState } from "react";
import { organisationPath, useMutation, useResource, write } from "./api";
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
  useConfirmation,
} from "./ui";
import type {
  Invitation,
  Member,
  Organisation,
  SettingsPanelProps,
} from "./types";

export function OrganisationSettings(props: SettingsPanelProps) {
  const path = organisationPath(props.orgId);
  const resource = useResource<Organisation | null>(path, null);
  const mutation = useMutation(() => {
    resource.reload();
    props.onChanged?.();
  });
  const [name, setName] = useState("");
  useEffect(() => {
    if (resource.data) setName(resource.data.name);
  }, [resource.data]);
  return (
    <>
      <Loading {...resource} retry={resource.reload} />
      <Feedback {...mutation} />
      <Section title="Organisation name">
        <Form
          busy={mutation.busy}
          onSubmit={async () => {
            await mutation.run(
              () => write(path, "PATCH", { name }),
              "Organisation name updated.",
            );
          }}
        >
          <Field
            label="Name"
            value={name}
            onChange={setName}
            required
            maxLength={255}
          />
        </Form>
      </Section>
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
  return (
    <Record title={member.name ?? member.email} description={member.email}>
      <Choice
        disabled={busy}
        label={`Role for ${member.email}`}
        value={role}
        onChange={(next) => setRole(next as Member["role"])}
        options={[
          { value: "admin", label: "Admin" },
          { value: "editor", label: "Editor" },
          { value: "viewer", label: "Viewer" },
        ]}
      />
      <Button
        variant="secondary"

        isDisabled={busy}
        onPress={() => save({ role })}
      >
        Save
      </Button>
      <Button
        variant="danger-soft"

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
        description="Rootset emails a single-use invitation. The recipient sets up their own credentials. At least one admin must remain in the installation."
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
              key={`${member.id}:${member.role}`}
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
                    `${member.email} will lose access to this organisation. Their API keys and application access stop working immediately.`,
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
