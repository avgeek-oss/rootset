"use client";

import { usePageQuery } from "../page-navigation";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Description, Input, Label, TextField } from "@heroui/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { ApiError, client } from "@rootset/web-client";
import {
  BackupPolicyInputSchema,
  type BackupPolicyResult,
} from "@rootset/contracts";
import { MutationAttempt } from "../../lib/mutation-attempt";
import { Form, Section, useConfirmation } from "./ui";
import type { SettingsPanelProps } from "./types";
import { RefreshCw } from "../ui/icons";

const policyKey = (props: SettingsPanelProps) => [
  "backup-policy",
  props.orgId,
  props.databaseId,
];
function useBackupPolicy(props: SettingsPanelProps) {
  return usePageQuery({
    queryKey: policyKey(props),
    queryFn: ({ signal }) =>
      client.operation<BackupPolicyResult>(
        "getDatabaseBackupPolicy",
        { orgId: props.orgId, databaseId: props.databaseId },
        { signal },
      ),
    enabled: Boolean(props.databaseId),
    retry: false,
    gcTime: 0,
    staleTime: 5000,
    refetchInterval: 10000,
  });
}
export function BackupRetentionSettings(props: SettingsPanelProps) {
  const resource = useBackupPolicy(props);
  if (
    !resource.data ||
    (resource.error instanceof ApiError &&
      [401, 403].includes(resource.error.status))
  )
    return null;
  return (
    <Section title="Retention and alerts">
      <RetentionForm
        key={props.databaseId}
        props={props}
        value={resource.data}
        reload={() => resource.refetch()}
      />
    </Section>
  );
}
function RetentionForm({
  props,
  value,
  reload,
}: {
  props: SettingsPanelProps;
  value: BackupPolicyResult;
  reload: () => Promise<unknown>;
}) {
  const cache = useQueryClient();
  const [retention, setRetention] = useState(
    value.policy.retentionCount?.toString() ?? "",
  );
  const [grace, setGrace] = useState(
    value.policy.overdueGraceMinutes.toString(),
  );
  const [baseline, setBaseline] = useState(value.policy);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const attempt = useRef(new MutationAttempt());
  const countField = useRef<HTMLDivElement>(null),
    graceField = useRef<HTMLDivElement>(null),
    reloadButton = useRef<HTMLButtonElement>(null);
  const confirmation = useConfirmation();
  const changed = value.policy.version !== baseline.version;
  const dirty =
    retention !== (baseline.retentionCount?.toString() ?? "") ||
    grace !== baseline.overdueGraceMinutes.toString();
  function adopt(result: BackupPolicyResult) {
    setBaseline(result.policy);
    setRetention(result.policy.retentionCount?.toString() ?? "");
    setGrace(result.policy.overdueGraceMinutes.toString());
  }
  async function save() {
    if (pending.current) return;
    const invalidInput = countField.current?.querySelector("input")?.validity
      .badInput
      ? countField
      : graceField.current?.querySelector("input")?.validity.badInput
        ? graceField
        : null;
    if (invalidInput) {
      toast.danger("Enter a valid whole number.");
      invalidInput.current?.querySelector("input")?.focus();
      return;
    }
    const parsed = BackupPolicyInputSchema.safeParse({
      expectedVersion: baseline.version,
      retentionCount: retention.trim() ? Number(retention) : null,
      overdueGraceMinutes: Number(grace),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      toast.danger(
        issue.path[0] === "retentionCount"
          ? "Enter a whole backup count from 1 to 10,000, or leave it empty to keep all."
          : "Enter an overdue grace period from 5 to 1,440 minutes.",
      );
      (issue.path[0] === "retentionCount" ? countField : graceField).current
        ?.querySelector("input")
        ?.focus();
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const input = {
        orgId: props.orgId,
        databaseId: props.databaseId,
        ...parsed.data,
      };
      const saved = await client.operation<BackupPolicyResult>(
        "saveDatabaseBackupPolicy",
        input,
        { idempotencyKey: attempt.current.forInput(input) },
      );
      cache.setQueryData(policyKey(props), saved);
      adopt(saved);
      toast.success("Backup retention saved.");
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "Backup retention could not be saved.",
      );
      if (error instanceof ApiError && [401, 403].includes(error.status))
        props.onClose();
      if (error instanceof ApiError && error.code === "ROW_VERSION_CONFLICT") {
        await reload();
        requestAnimationFrame(() => reloadButton.current?.focus());
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function reloadPolicy() {
    if (pending.current) return;
    if (
      dirty &&
      !(await confirmation.confirm(
        "Reload backup policy?",
        "Your unsaved retention count and grace period will be replaced with the saved values.",
        "Reload policy",
      ))
    )
      return;
    pending.current = true;
    setBusy(true);
    try {
      const latest = await client.operation<BackupPolicyResult>(
        "getDatabaseBackupPolicy",
        { orgId: props.orgId, databaseId: props.databaseId },
      );
      cache.setQueryData(policyKey(props), latest);
      adopt(latest);
      attempt.current = new MutationAttempt();
      requestAnimationFrame(() =>
        countField.current?.querySelector("input")?.focus(),
      );
    } catch (error) {
      toast.danger(
        error instanceof Error
          ? error.message
          : "The backup policy could not be loaded.",
      );
      if (error instanceof ApiError && [401, 403].includes(error.status))
        props.onClose();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Form
        busy={busy}
        submit="Save retention"
        noValidate
        onSubmit={save}
        actions={
          changed && (
            <Button
              ref={reloadButton}
              variant="secondary"
              isDisabled={busy}
              onPress={() => void reloadPolicy()}
            >
              <RefreshCw />
              Reload policy
            </Button>
          )
        }
      >
        {changed && (
          <p role="status" className="text-sm text-muted">
            This policy changed elsewhere. Your entered values are kept; reload
            the saved policy before applying them.
          </p>
        )}
        <div ref={countField}>
          <TextField
            className="settings-field"
            type="number"
            value={retention}
            onChange={setRetention}
            isReadOnly={busy}
          >
            <Label>Successful backups to keep</Label>
            <Input
              variant="secondary"
              min={1}
              max={10000}
              step={1}
              inputMode="numeric"
            />
            <Description>
              Leave empty to keep all. Older packages are removed; the latest
              successful backup and packages needed by restores stay protected.
            </Description>
          </TextField>
        </div>
        <div ref={graceField}>
          <TextField
            className="settings-field"
            type="number"
            value={grace}
            onChange={setGrace}
            isRequired
            isReadOnly={busy}
          >
            <Label>Overdue grace period (minutes)</Label>
            <Input
              variant="secondary"
              min={5}
              max={1440}
              step={1}
              inputMode="numeric"
            />
            <Description>
              Notify verified administrators when a scheduled time has no
              successful snapshot after this many minutes. Failed backup
              requests also notify administrators.
            </Description>
          </TextField>
        </div>
      </Form>
      {confirmation.dialog}
    </>
  );
}
