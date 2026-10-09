"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { useEffect, useState } from "react";
import {
  databasePath,
  performAction,
  useMutation,
  useResource,
  write,
} from "./api";
import {
  Empty,
  Feedback,
  Field,
  Form,
  Loading,
  Section,
  useConfirmation,
} from "./ui";
import type { SettingsPanelProps } from "./types";

export function DatabaseSettings(props: SettingsPanelProps) {
  const path = props.databaseId
    ? databasePath(props.orgId, props.databaseId)
    : undefined;
  const resource = useResource<{
    name: string;
    description?: string | null;
    state: string;
  } | null>(path, null);
  const mutation = useMutation(() => {
    resource.reload();
    props.onChanged?.();
  });
  const confirmation = useConfirmation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (resource.data) {
      setName(resource.data.name);
      setDescription(resource.data.description ?? "");
    }
  }, [resource.data]);
  if (!path) return <Empty>Select a database to manage its settings.</Empty>;
  return (
    <>
      <Loading {...resource} retry={resource.reload} />
      <Feedback {...mutation} />
      <Section
        title="Database details"
        description={`State: ${resource.data?.state ?? "Loading"}`}
      >
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
      <Section
        title="Delete database"
        description="Deletion covers all tables in this database and requires recent authentication."
      >
        <Button
          variant="danger-soft"
          isDisabled={mutation.busy}
          onPress={async () => {
            if (
              await confirmation.confirm(
                "Delete this database?",
                `Delete ${name || "this database"} and all its tables? This action cannot be undone in Rootset.`,
                "Delete database",
              )
            )
              await mutation.run(
                () =>
                  performAction("deleteDatabase", {
                    orgId: props.orgId,
                    databaseId: props.databaseId,
                  }),
                "Database deletion requested.",
              );
          }}
        >
          Delete database
        </Button>
      </Section>
      {confirmation.dialog}
    </>
  );
}
