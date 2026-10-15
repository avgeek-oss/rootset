"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { HugeiconsIcon } from "@hugeicons/react";
import { Key01Icon, TableIcon } from "@hugeicons/core-free-icons";
import type { TableSummary } from "@rootset/contracts";
import { Dialog } from "../dialog";
import { PageSelectionTitle } from "./account/page-selection-title";
import {
  organisationPath,
  tablePath,
  useMutation,
  useResource,
  write,
} from "./api";
import { FieldTypeIcon } from "./field-type-options";
import { Choice, Empty, Form, Loading, useConfirmation } from "./ui";
import type { Job, SettingsPanelProps, TableSchemaResult } from "./types";

const EMPTY_SCHEMA: TableSchemaResult = {
  table: { name: "", schemaVersion: 1 },
  fields: [],
  uniqueRules: [],
  foreignKeys: [],
};

export function ForeignKeysSettings(props: SettingsPanelProps) {
  const path =
    props.databaseId && props.tableId
      ? tablePath(props.orgId, props.databaseId, props.tableId)
      : undefined;
  const schema = useResource<TableSchemaResult>(
    path ? `${path}/schema` : undefined,
    EMPTY_SCHEMA,
  );
  const tables = useResource<TableSummary[]>(
    props.databaseId
      ? `${organisationPath(props.orgId)}/databases/${props.databaseId}/tables`
      : undefined,
    [],
  );
  const [formOpen, setFormOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [fieldIds, setFieldIds] = useState<string[]>([]);
  const [formError, setFormError] = useState<string>();
  const [pendingJobId, setPendingJobId] = useState<string>();
  const target = useResource<TableSchemaResult>(
    formOpen && targetId && props.databaseId
      ? `${tablePath(props.orgId, props.databaseId, targetId)}/schema`
      : undefined,
    EMPTY_SCHEMA,
  );
  const job = useResource<Job | null>(
    pendingJobId
      ? `${organisationPath(props.orgId)}/jobs/${pendingJobId}`
      : undefined,
    null,
  );
  const mutation = useMutation();
  const confirmation = useConfirmation();
  const busy = mutation.busy || Boolean(pendingJobId);
  const disabled = busy || schema.loading || Boolean(schema.error);
  const eligible = target.data.uniqueRules.filter(
    (rule) => rule.state === "active" && !rule.where,
  );
  const selected = eligible.find((rule) => rule.id === ruleId);
  const referencedFields = (selected?.fieldIds ?? []).map((id) =>
    target.data.fields.find((field) => field.id === id),
  );
  const actions = useMemo(
    () => (
      <Button
        isDisabled={disabled || !schema.data.fields.length}
        onPress={() => {
          setTargetId("");
          setRuleId("");
          setFieldIds([]);
          setFormError(undefined);
          setFormOpen(true);
        }}
      >
        Create foreign key
      </Button>
    ),
    [disabled, schema.data.fields.length],
  );
  useEffect(() => {
    if (!pendingJobId) return;
    const timer = setInterval(job.reload, 2000);
    return () => clearInterval(timer);
  }, [pendingJobId, job.reload]);
  useEffect(() => {
    if (
      !pendingJobId ||
      job.data?.id !== pendingJobId ||
      !["succeeded", "failed", "cancelled"].includes(job.data.state)
    )
      return;
    setPendingJobId(undefined);
    schema.reload();
    props.onChanged?.();
    if (job.data.state === "succeeded") {
      setFormOpen(false);
      toast.success("Foreign key created.");
    } else
      setFormError(
        typeof job.data.error === "string"
          ? job.data.error
          : (job.data.error?.message ??
              "The foreign key could not be created."),
      );
  }, [pendingJobId, job.data, schema.reload, props.onChanged]);
  if (!path) return <Empty>Select a table to manage foreign keys.</Empty>;
  return (
    <>
      <PageSelectionTitle label="Foreign keys" actions={actions} />
      <Loading {...schema} retry={schema.reload} />
      <Loading {...tables} retry={tables.reload} />
      <Loading {...job} retry={job.reload} />
      {!schema.loading && !schema.error && (
        <ResourceTable
          ariaLabel="Foreign keys"
          items={schema.data.foreignKeys}
          getRowKey={(rule) => rule.id}
          tableClassName="min-w-2xl"
          emptyTitle="No foreign keys yet"
          emptyDescription="Link fields to a unique key in another table to validate their values."
          columns={[
            {
              key: "fields",
              header: "Fields",
              cell: (rule) =>
                rule.fieldIds
                  .map(
                    (id) =>
                      schema.data.fields.find((f) => f.id === id)?.name ?? id,
                  )
                  .join(" + "),
            },
            {
              key: "table",
              header: "Referenced table",
              cell: (rule) => rule.referencedTableName,
            },
            {
              key: "key",
              header: "Referenced fields",
              cell: (rule) => rule.referencedFieldNames.join(" + "),
            },
            {
              key: "actions",
              header: "Actions",
              headerClassName: "text-right",
              cell: (rule) => (
                <div className="field-edit-actions">
                  <Button
                    variant="danger-soft"
                    isDisabled={disabled}
                    onPress={async () => {
                      if (
                        !(await confirmation.confirm(
                          "Remove foreign key?",
                          "Future writes will no longer require a matching value in the referenced table.",
                          "Remove",
                        ))
                      )
                        return;
                      const result = await mutation.run(
                        () =>
                          write(`${path}/foreign-keys/${rule.id}`, "DELETE", {
                            expectedSchemaVersion:
                              schema.data.table.schemaVersion,
                          }),
                        "Foreign key removed.",
                      );
                      if (result.ok) {
                        schema.reload();
                        props.onChanged?.();
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
      {formOpen && (
        <Dialog
          title="Create foreign key"
          onClose={() => setFormOpen(false)}
          closeDisabled={busy}
        >
          <Form
            noValidate
            busy={busy || target.loading}
            submit="Create foreign key"
            onCancel={() => setFormOpen(false)}
            onSubmit={async () => {
              if (
                !selected ||
                !referencedFields.length ||
                fieldIds.length !== referencedFields.length ||
                fieldIds.some((id) => !id) ||
                new Set(fieldIds).size !== fieldIds.length
              ) {
                setFormError(
                  "Choose a referenced unique key and a different local field for each referenced field.",
                );
                return;
              }
              setFormError(undefined);
              const result = await mutation.run(() =>
                write<{ jobId?: string }>(`${path}/foreign-keys`, "POST", {
                  fieldIds,
                  referencedTableId: targetId,
                  referencedRuleId: ruleId,
                  expectedSchemaVersion: schema.data.table.schemaVersion,
                  expectedReferencedSchemaVersion:
                    target.data.table.schemaVersion,
                }),
              );
              if (result.ok) {
                if (result.value.jobId) setPendingJobId(result.value.jobId);
                else {
                  setFormOpen(false);
                  schema.reload();
                  props.onChanged?.();
                  toast.success("Foreign key created.");
                }
              }
            }}
          >
            <Choice
              label="Referenced table"
              value={targetId}
              disabled={busy || tables.loading || Boolean(tables.error)}
              options={tables.data
                .filter((t) => t.state === "active")
                .map((t) => ({
                  value: t.id,
                  label: t.name,
                  icon: (
                    <HugeiconsIcon
                      icon={TableIcon}
                      size={16}
                      aria-hidden="true"
                    />
                  ),
                }))}
              onChange={(value) => {
                setTargetId(value);
                setRuleId("");
                setFieldIds([]);
                setFormError(undefined);
              }}
            />
            <Loading {...target} retry={target.reload} />
            {targetId && !target.loading && !target.error && (
              <>
                <Choice
                  label="Referenced unique key"
                  value={ruleId}
                  disabled={busy || !eligible.length}
                  options={eligible.map((rule) => ({
                    value: rule.id,
                    label: (rule.fieldIds ?? [])
                      .map(
                        (id) =>
                          target.data.fields.find((f) => f.id === id)?.name ??
                          id,
                      )
                      .join(" + "),
                    icon: (
                      <HugeiconsIcon
                        icon={Key01Icon}
                        size={16}
                        aria-hidden="true"
                      />
                    ),
                  }))}
                  onChange={(value) => {
                    setRuleId(value);
                    setFieldIds([]);
                    setFormError(undefined);
                  }}
                />
                {!eligible.length && (
                  <p className="settings-muted">
                    Create a unique rule for all rows in the referenced table
                    first.
                  </p>
                )}
                {referencedFields.map(
                  (field, index) =>
                    field && (
                      <Choice
                        key={field.id}
                        label={`Local field for ${field.name}`}
                        value={fieldIds[index] ?? ""}
                        disabled={busy}
                        options={schema.data.fields
                          .filter(
                            (f) =>
                              f.type === field.type &&
                              (!fieldIds.includes(f.id) ||
                                fieldIds[index] === f.id),
                          )
                          .map((f) => ({
                            value: f.id,
                            label: f.name,
                            icon: <FieldTypeIcon type={f.type} />,
                          }))}
                        onChange={(value) => {
                          setFieldIds((ids) =>
                            referencedFields.map((_, i) =>
                              i === index ? value : (ids[i] ?? ""),
                            ),
                          );
                          setFormError(undefined);
                        }}
                      />
                    ),
                )}
              </>
            )}
            <p className="settings-muted">
              Values must match the referenced key. Optional fields allow{" "}
              <i>NULL</i>. Referenced values cannot be changed or deleted while
              in use.
            </p>
            {formError && (
              <p className="settings-error" role="alert">
                {formError}
              </p>
            )}
          </Form>
        </Dialog>
      )}
      {confirmation.dialog}
    </>
  );
}
