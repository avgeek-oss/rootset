"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { useQuery } from "@tanstack/react-query";
import { browserArtifactDownloadPath, client } from "@rootset/web-client";
import type {
  HistoryArchiveSchema,
  HistoryRetentionPolicySchema,
} from "@rootset/contracts";
import { useEffect, useState } from "react";
import type { z } from "zod";
import {
  performAction,
  describeError,
  read,
  tablePath,
  useMutation,
  useResource,
} from "./api";
import {
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
import { JobTracker } from "./jobs";
import type { Artifact, SettingsPanelProps } from "./types";

type Policy = z.infer<typeof HistoryRetentionPolicySchema>;
type Archive = z.infer<typeof HistoryArchiveSchema>;
const DEFAULT_POLICY: Policy = {
  enabled: false,
  retentionDays: 365,
  cron: "0 3 * * *",
  timezone: "UTC",
  maxRuntimeSeconds: 3600,
};

export function HistoryRetentionSettings(props: SettingsPanelProps) {
  const path =
    props.databaseId && props.tableId
      ? tablePath(props.orgId, props.databaseId, props.tableId)
      : undefined;
  const policy = useResource<Policy>(
    path ? `${path}/history-retention-policy` : undefined,
    DEFAULT_POLICY,
  );
  const [archiveCursors, setArchiveCursors] = useState<(string | undefined)[]>([
    undefined,
  ]);
  const archivePage = useQuery({
    queryKey: [
      "history-archives",
      props.orgId,
      props.databaseId,
      props.tableId,
      archiveCursors.at(-1),
    ],
    enabled: Boolean(path),
    queryFn: ({ signal }) =>
      client.operation<{
        data: Archive[];
        nextCursor?: string | null;
        hasMore?: boolean;
      }>(
        "listHistoryArchives",
        {
          orgId: props.orgId,
          databaseId: props.databaseId,
          tableId: props.tableId,
          limit: 50,
          ...(archiveCursors.at(-1) ? { cursor: archiveCursors.at(-1) } : {}),
        },
        { signal },
      ),
  });
  const archives = {
    data: archivePage.data?.data ?? [],
    loading: archivePage.isPending,
    error: archivePage.isError ? describeError(archivePage.error) : undefined,
    reload: () => {
      void archivePage.refetch();
    },
  };
  const authority = useResource<{ principal: { role: string } } | null>(
    "/context",
    null,
  );
  const [draft, setDraft] = useState(DEFAULT_POLICY);
  const [before, setBefore] = useState("");
  const [jobId, setJobId] = useState<string>();
  const [inspectedJobId, setInspectedJobId] = useState<string>();
  const mutation = useMutation(() => {
    policy.reload();
    archives.reload();
  });
  const confirmation = useConfirmation();
  const canManage = authority.data && authority.data.principal.role === "admin";
  useEffect(() => {
    setDraft({
      enabled: policy.data.enabled,
      retentionDays: policy.data.retentionDays,
      cron: policy.data.cron,
      timezone: policy.data.timezone,
      maxRuntimeSeconds: policy.data.maxRuntimeSeconds,
    });
  }, [policy.data]);
  if (!path) return null;
  const target = {
    orgId: props.orgId,
    databaseId: props.databaseId,
    tableId: props.tableId,
  };
  return (
    <>
      <Section
        title="Cell history retention"
        description="Hot history is retained indefinitely by default. An opt-in schedule encrypts and verifies an archive before removing covered events from hot storage. Cold archives remain retained."
      >
        <Loading {...policy} retry={policy.reload} />
        <Feedback {...mutation} />
        <p>
          Current policy:{" "}
          <strong>
            {policy.data.enabled
              ? `Archive hot history after ${policy.data.retentionDays} days`
              : "Retain hot history indefinitely"}
          </strong>
        </p>
        {policy.data.suspension && (
          <p role="alert">
            The schedule is suspended: {policy.data.suspension.code} since{" "}
            <DateLabel value={policy.data.suspension.at} />. Review and save the
            policy before resuming.
          </p>
        )}
        {canManage && (
          <Form
            busy={mutation.busy}
            submit="Save history policy"
            onSubmit={async () => {
              await mutation.run(
                () =>
                  performAction("setHistoryRetentionPolicy", {
                    ...target,
                    ...draft,
                  }),
                "History retention policy saved.",
              );
            }}
          >
            <Toggle
              label="Archive older hot history on a schedule"
              selected={draft.enabled}
              onChange={(enabled) =>
                setDraft((previous) => ({ ...previous, enabled }))
              }
            />
            <Field
              label="Hot history retention days"
              type="number"
              min={1}
              max={36500}
              step={1}
              value={String(draft.retentionDays)}
              onChange={(value) =>
                setDraft((previous) => ({
                  ...previous,
                  retentionDays: Number(value),
                }))
              }
              required
            />
            <Field
              label="History archive cron"
              value={draft.cron}
              onChange={(cron) =>
                setDraft((previous) => ({ ...previous, cron }))
              }
              required
              description="A standard five-field cron. The schedule uses the timezone below."
            />
            <Field
              label="History archive timezone"
              value={draft.timezone}
              onChange={(timezone) =>
                setDraft((previous) => ({ ...previous, timezone }))
              }
              required
              description="An IANA timezone, for example UTC or Asia/Kolkata."
            />
            <Field
              label="History archive maximum runtime (seconds)"
              type="number"
              min={60}
              max={86400}
              step={1}
              value={String(draft.maxRuntimeSeconds)}
              onChange={(value) =>
                setDraft((previous) => ({
                  ...previous,
                  maxRuntimeSeconds: Number(value),
                }))
              }
              required
            />
          </Form>
        )}
      </Section>
      {canManage && (
        <Section
          title="Archive history now"
          description="Archives events strictly before the UTC cutoff. Purging starts only after encrypted archive verification succeeds. Live cell history identifies archived ranges instead of silently omitting them."
        >
          <Form
            busy={mutation.busy}
            submit="Review history archive"
            onSubmit={async () => {
              if (
                !(await confirmation.confirm(
                  "Archive older cell history?",
                  `Archive history strictly before ${before}. This retains a verified cold archive and removes only its covered events from hot storage.`,
                  "Archive history",
                ))
              )
                return;
              const result = await mutation.run(
                () =>
                  performAction<{ jobId: string }>("archiveHistory", {
                    ...target,
                    before,
                  }),
                "History archive queued. Its job must succeed before the covered hot events are removed.",
              );
              if (result.ok) setJobId(result.value.jobId);
            }}
          >
            <Field
              label="Archive history before (UTC)"
              value={before}
              onChange={setBefore}
              required
              description="An explicit UTC date-time, for example 2026-01-01T00:00:00Z."
            />
          </Form>
          {jobId && (
            <JobTracker
              orgId={props.orgId}
              jobId={jobId}
              onTerminal={() => archives.reload()}
            />
          )}
        </Section>
      )}
      <Section
        title="Retained history archives"
        description="Manifests show the covered UTC range, verification state and retained artifact. A failed or cancelled job leaves unverified history in hot storage."
      >
        <Loading {...archives} retry={archives.reload} />
        <Button variant="secondary" onPress={archives.reload}>
          Refresh history archives
        </Button>
        <RecordList>
          {archives.data.map((archive) => (
            <Record
              key={archive.id}
              title={
                <>
                  Before <DateLabel value={archive.to} /> ·{" "}
                  <Status value={archive.state} />
                </>
              }
              description={
                <>
                  From{" "}
                  {archive.from ? (
                    <DateLabel value={archive.from} />
                  ) : (
                    "earliest retained event"
                  )}{" "}
                  · {archive.cellEvents.toLocaleString()} cell changes ·{" "}
                  {archive.rowEvents.toLocaleString()} row events
                  <br />
                  Verified{" "}
                  {archive.verifiedAt ? (
                    <DateLabel value={archive.verifiedAt} />
                  ) : (
                    "pending"
                  )}{" "}
                  · checksum {archive.checksum ?? "pending"}
                  {archive.error && <p role="alert">{archive.error}</p>}
                </>
              }
            >
              {archive.artifactId && archive.verifiedAt && (
                <Button
                  variant="secondary"
                  onPress={() =>
                    void mutation.run(async () => {
                      const artifact = await read<Artifact>(
                        `/orgs/${props.orgId}/artifacts/${archive.artifactId}`,
                      );
                      if (!artifact.downloadUrl)
                        throw new Error(
                          "The verified archive download is unavailable. Retry or contact your administrator.",
                        );
                      window.open(
                        browserArtifactDownloadPath(
                          props.orgId,
                          archive.artifactId!,
                        ),
                        "_blank",
                        "noopener,noreferrer",
                      );
                    }, "Verified archive download opened.")
                  }
                >
                  Download verified archive
                </Button>
              )}
              <Button
                variant="secondary"
                onPress={() => setInspectedJobId(archive.jobId)}
              >
                Inspect archive job
              </Button>
            </Record>
          ))}
        </RecordList>
        {!archives.loading && !archives.error && archives.data.length === 0 && (
          <Empty>
            No history has been archived. Hot history remains available.
          </Empty>
        )}
        {inspectedJobId && (
          <JobTracker orgId={props.orgId} jobId={inspectedJobId} />
        )}
        <div className="settings-actions">
          <Button
            variant="secondary"
            isDisabled={archivePage.isFetching || archiveCursors.length === 1}
            onPress={() =>
              setArchiveCursors((previous) => previous.slice(0, -1))
            }
          >
            Previous archive page
          </Button>
          <Button
            variant="secondary"
            isDisabled={
              archivePage.isFetching ||
              !archivePage.data?.hasMore ||
              !archivePage.data?.nextCursor
            }
            onPress={() =>
              setArchiveCursors((previous) => [
                ...previous,
                archivePage.data?.nextCursor ?? undefined,
              ])
            }
          >
            Older history archives
          </Button>
        </div>
      </Section>
      {confirmation.dialog}
    </>
  );
}
