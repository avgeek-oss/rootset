"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { useEffect, useState } from "react";
import {
  databasePath,
  confirmIdentity,
  useMutation,
  useResource,
  write,
} from "./api";
import { Empty, Field, Form, Loading, Section, useConfirmation } from "./ui";
import type { SettingsPanelProps } from "./types";

export function DatabaseSettings(props: SettingsPanelProps) {
  const path = props.databaseId
    ? databasePath(props.orgId, props.databaseId)
    : undefined;
  const resource = useResource<{
    name: string;
    description?: string | null;
  } | null>(path, null);
  const mutation = useMutation(() => {
    resource.reload();
    props.onChanged?.();
  });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (resource.data) {
      setName(resource.data.name);
      setDescription(resource.data.description ?? "");
    }
  }, [resource.data]);
  if (!path) return <Empty>Select a database to manage its settings.</Empty>;
  if (!resource.data) return <Loading {...resource} retry={resource.reload} />;
  return (
    <>
      <Loading {...resource} retry={resource.reload} />
      <Section title="Database details">
        <Form
          busy={mutation.busy}
          onSubmit={async () => {
            await mutation.run(
              () => write(path, "PATCH", { name, description }),
              "Database updated.",
            );
          }}
        >
          <Field
            label="Database name"
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
    </>
  );
}

export function DatabaseDangerZone(props: SettingsPanelProps) {
  const path = props.databaseId
    ? databasePath(props.orgId, props.databaseId)
    : undefined;
  const resource = useResource<{ name: string } | null>(path, null);
  const mutation = useMutation(() => {
    resource.reload();
    props.onChanged?.();
  });
  const confirmation = useConfirmation();
  if (!path) return <Empty>Select a database to manage its settings.</Empty>;
  if (!resource.data) return <Loading {...resource} retry={resource.reload} />;
  const name = resource.data.name;
  return (
    <>
      <Loading {...resource} retry={resource.reload} />
      <Section
        title="Delete database"
        description="Deleting this database removes it and all its tables from Rootset. Its rows will no longer be accessible in the app or through the API and MCP, and its cell changelogs will be deleted. Rootset does not provide an undo or restore option."
      >
        <Button
          variant="danger-soft"
          isDisabled={mutation.busy}
          onPress={async () => {
            if (
              await confirmation.confirm(
                "Delete this database?",
                `Delete ${name} and all its tables? This action cannot be undone in Rootset.`,
                "Delete database",
              )
            ) {
              await mutation.run(async () => {
                await confirmIdentity();
                return write(path, "DELETE");
              }, "Database deletion requested.");
            }
          }}
        >
          Delete database
        </Button>
      </Section>
      {confirmation.dialog}
    </>
  );
}
