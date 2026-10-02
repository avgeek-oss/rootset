"use client";

import { Button } from "@heroui/react";
import {
  CapacityConfigurationSchema,
  DeletionRetentionSchema,
  type CapacityConfiguration,
  type CapacityStatus,
  type DeletionRetention,
} from "@rootset/contracts";
import type { OperationalMetrics } from "@rootset/observability/schema";
import { useEffect, useState } from "react";
import { performAction, useMutation, useResource } from "./api";
import { JobTracker } from "./jobs";
import {
  DateLabel,
  Feedback,
  Field,
  Form,
  Loading,
  Record,
  RecordList,
  Section,
  Status,
  Toggle,
} from "./ui";
import type { SettingsPanelProps } from "./types";
import { InstallationMetrics, StorageCapacity } from "./installation-metrics";

interface InstallationConfiguration {
  baseUrl: string;
  signupEnabled: false;
  smtpConfigured: boolean;
  objectStorageConfigured: boolean;
  limits: Record<string, number>;
  operatorRecoveryEnabled: boolean;
  restartRequired?: boolean;
  storage: CapacityConfiguration;
  deletionRetention: DeletionRetention;
}
interface InstallationStatus {
  healthy: boolean;
  version: string;
  migrationVersion: string;
  dependencies: Record<string, string>;
  workerHeartbeatAt: string | null;
  metrics: OperationalMetrics;
  storage: CapacityStatus | null;
}

export function InstallationSettings(props: SettingsPanelProps) {
  const configuration = useResource<InstallationConfiguration | null>(
    "/installation/configuration",
    null,
  );
  const status = useResource<InstallationStatus | null>(
    "/installation/status",
    null,
  );
  const mutation = useMutation(() => {
    configuration.reload();
    status.reload();
  });
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [recipient, setRecipient] = useState("");
  const [jobId, setJobId] = useState("");
  const [capacity, setCapacity] = useState({
    installationQuotaBytes: "",
    defaultOrganisationQuotaBytes: "",
    minimumFreeBytes: "",
    reportMaxAgeSeconds: "30",
    organisationOverrides: "",
  });
  const [retention, setRetention] = useState({
    organisationDays: "",
    accountAuditDays: "",
  });
  const [smtp, setSmtp] = useState({
    host: "",
    port: "587",
    secure: false,
    from: "",
    user: "",
    password: "",
  });
  const [storage, setStorage] = useState({
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    accessKeyId: "",
    secretAccessKey: "",
  });
  useEffect(() => {
    if (!configuration.data) return;
    setLimits(configuration.data.limits);
    const policy = configuration.data.storage;
    setCapacity({
      installationQuotaBytes: policy.installationQuotaBytes ?? "",
      defaultOrganisationQuotaBytes: policy.defaultOrganisationQuotaBytes ?? "",
      minimumFreeBytes: policy.minimumFreeBytes ?? "",
      reportMaxAgeSeconds: String(policy.reportMaxAgeSeconds),
      organisationOverrides: policy.organisationOverrides
        .map(({ orgId, quotaBytes }) => `${orgId}=${quotaBytes ?? "none"}`)
        .join("\n"),
    });
    setRetention({
      organisationDays:
        configuration.data.deletionRetention.organisationDays === null
          ? ""
          : String(configuration.data.deletionRetention.organisationDays),
      accountAuditDays:
        configuration.data.deletionRetention.accountAuditDays === null
          ? ""
          : String(configuration.data.deletionRetention.accountAuditDays),
    });
  }, [configuration.data]);
  return (
    <>
      <Feedback {...mutation} />
      <Section
        title="Installation health"
        description="Installation authority is separate from organisation ownership. These settings require a deployment-authorised operator."
      >
        <Loading {...status} retry={status.reload} />
        {status.data && (
          <>
            <p>
              <Status value={status.data.healthy ? "healthy" : "degraded"} /> ·
              version {status.data.version} · migration{" "}
              {status.data.migrationVersion}
            </p>
            <p className="settings-muted">
              Worker heartbeat:{" "}
              <DateLabel value={status.data.workerHeartbeatAt} />
            </p>
            <RecordList>
              {Object.entries(status.data.dependencies).map(([name, state]) => (
                <Record key={name} title={name}>
                  <Status value={state} />
                </Record>
              ))}
            </RecordList>
          </>
        )}
        <Button variant="secondary" onPress={status.reload}>
          Refresh health
        </Button>
      </Section>
      {status.data && (
        <>
          <StorageCapacity capacity={status.data.storage} />
          <InstallationMetrics metrics={status.data.metrics} />
        </>
      )}
      <Section title="Configuration">
        <Loading {...configuration} retry={configuration.reload} />
        {configuration.data && (
          <>
            <RecordList>
              <Record
                title="Installation URL"
                description={configuration.data.baseUrl}
              />
              <Record title="Public signup" description="Disabled" />
              <Record
                title="Email delivery"
                description={
                  configuration.data.smtpConfigured
                    ? "Configured"
                    : "Not configured"
                }
              />
              <Record
                title="Encrypted object storage"
                description={
                  configuration.data.objectStorageConfigured
                    ? "Configured"
                    : "Not configured"
                }
              />
              <Record
                title="Operator recovery"
                description={
                  configuration.data.operatorRecoveryEnabled
                    ? "Enabled"
                    : "Disabled"
                }
              />
            </RecordList>
            <p className="settings-muted">
              Secret values are encrypted in control storage and never returned
              to this screen. Deployment configuration is used until an operator
              saves an override.
            </p>
            {configuration.data.restartRequired && (
              <p role="status" className="settings-feedback">
                Configuration overrides are saved. Restart the API and workers
                to apply them, then check dependency health.
              </p>
            )}
            <Form
              busy={mutation.busy}
              onSubmit={async () => {
                await mutation.run(
                  () =>
                    performAction("updateInstallationConfiguration", {
                      limits,
                    }),
                  "Installation limits updated.",
                );
              }}
            >
              {Object.entries(limits).map(([name, value]) => (
                <Field
                  key={name}
                  label={name.replaceAll("_", " ")}
                  type="number"
                  min={1}
                  value={String(value)}
                  onChange={(next) =>
                    setLimits((previous) => ({
                      ...previous,
                      [name]: Number(next),
                    }))
                  }
                  required
                />
              ))}
            </Form>
          </>
        )}
      </Section>
      {configuration.data && (
        <>
          <Section
            title="Storage admission policy"
            description="Quota and reserve values are exact byte counts. Leave a quota blank for no configured ceiling. A configured disk reserve refuses growth when the filesystem report is stale or its measured headroom is insufficient."
          >
            <Form
              busy={mutation.busy}
              submit="Save storage policy"
              onSubmit={async () => {
                await mutation.run(() => {
                  const policy = CapacityConfigurationSchema.parse({
                    installationQuotaBytes:
                      capacity.installationQuotaBytes.trim() || null,
                    defaultOrganisationQuotaBytes:
                      capacity.defaultOrganisationQuotaBytes.trim() || null,
                    minimumFreeBytes: capacity.minimumFreeBytes.trim() || null,
                    reportMaxAgeSeconds: Number(capacity.reportMaxAgeSeconds),
                    organisationOverrides: capacity.organisationOverrides.trim()
                      ? capacity.organisationOverrides
                          .trim()
                          .split(/\r?\n/)
                          .map((line) => {
                            const [orgId, quotaBytes, extra] = line
                              .split("=")
                              .map((part) => part.trim());
                            if (extra !== undefined || !orgId || !quotaBytes)
                              throw new Error(
                                "Use one organisation ID=bytes or organisation ID=none entry per line.",
                              );
                            return {
                              orgId,
                              quotaBytes:
                                quotaBytes === "none" ? null : quotaBytes,
                            };
                          })
                      : [],
                  });
                  return performAction("updateInstallationConfiguration", {
                    storage: policy,
                  });
                }, "Storage admission policy saved.");
              }}
            >
              <Field
                label="Installation quota (bytes)"
                value={capacity.installationQuotaBytes}
                pattern="0|[1-9][0-9]{0,18}"
                onChange={(installationQuotaBytes) =>
                  setCapacity((previous) => ({
                    ...previous,
                    installationQuotaBytes,
                  }))
                }
              />
              <Field
                label="Default organisation quota (bytes)"
                value={capacity.defaultOrganisationQuotaBytes}
                pattern="0|[1-9][0-9]{0,18}"
                onChange={(defaultOrganisationQuotaBytes) =>
                  setCapacity((previous) => ({
                    ...previous,
                    defaultOrganisationQuotaBytes,
                  }))
                }
              />
              <Field
                label="Minimum free disk reserve (bytes)"
                value={capacity.minimumFreeBytes}
                pattern="0|[1-9][0-9]{0,18}"
                onChange={(minimumFreeBytes) =>
                  setCapacity((previous) => ({ ...previous, minimumFreeBytes }))
                }
              />
              <Field
                label="Maximum filesystem report age (seconds)"
                type="number"
                min={5}
                max={3600}
                required
                value={capacity.reportMaxAgeSeconds}
                onChange={(reportMaxAgeSeconds) =>
                  setCapacity((previous) => ({
                    ...previous,
                    reportMaxAgeSeconds,
                  }))
                }
              />
              <Field
                label="Organisation quota overrides"
                multiline
                value={capacity.organisationOverrides}
                description="One organisation ID=bytes entry per line. Use ID=none to remove the ceiling for that organisation. IDs are checked and duplicate entries are rejected."
                onChange={(organisationOverrides) =>
                  setCapacity((previous) => ({
                    ...previous,
                    organisationOverrides,
                  }))
                }
              />
            </Form>
          </Section>
          <Section
            title="Deleted account and organisation retention"
            description="Blank means indefinite retention. Setting a duration permits the worker to purge the corresponding retained records after that many days. Backup expiry and cell-history archival have separate policies."
          >
            <Form
              busy={mutation.busy}
              submit="Save deletion retention"
              onSubmit={async () => {
                await mutation.run(
                  () =>
                    performAction("updateInstallationConfiguration", {
                      deletionRetention: DeletionRetentionSchema.parse({
                        organisationDays: retention.organisationDays.trim()
                          ? Number(retention.organisationDays)
                          : null,
                        accountAuditDays: retention.accountAuditDays.trim()
                          ? Number(retention.accountAuditDays)
                          : null,
                      }),
                    }),
                  "Deletion retention saved.",
                );
              }}
            >
              <Field
                label="Deleted organisation retention (days)"
                type="number"
                min={1}
                max={36500}
                value={retention.organisationDays}
                onChange={(organisationDays) =>
                  setRetention((previous) => ({
                    ...previous,
                    organisationDays,
                  }))
                }
              />
              <Field
                label="Deleted account audit retention (days)"
                type="number"
                min={1}
                max={36500}
                value={retention.accountAuditDays}
                onChange={(accountAuditDays) =>
                  setRetention((previous) => ({
                    ...previous,
                    accountAuditDays,
                  }))
                }
              />
            </Form>
          </Section>
        </>
      )}
      <Section
        title="SMTP delivery"
        description="Save an encrypted installation override. Leave the password empty to preserve the existing secret. Changing configuration requires identity approval and a restart."
      >
        <Form
          busy={mutation.busy}
          submit="Save SMTP configuration"
          onSubmit={async () => {
            const result = await mutation.run(
              () =>
                performAction<InstallationConfiguration>(
                  "updateInstallationConfiguration",
                  {
                    smtp: {
                      host: smtp.host,
                      port: Number(smtp.port),
                      secure: smtp.secure,
                      from: smtp.from,
                      ...(smtp.user ? { user: smtp.user } : {}),
                      ...(smtp.password ? { password: smtp.password } : {}),
                    },
                  },
                ),
              "SMTP override saved. Restart the API and workers, then run an email test.",
            );
            if (result.ok)
              setSmtp((previous) => ({ ...previous, password: "" }));
          }}
        >
          <div className="settings-inline">
            <Field
              label="SMTP host"
              value={smtp.host}
              onChange={(host) =>
                setSmtp((previous) => ({ ...previous, host }))
              }
              required
            />
            <Field
              label="Port"
              type="number"
              min={1}
              max={65535}
              value={smtp.port}
              onChange={(port) =>
                setSmtp((previous) => ({ ...previous, port }))
              }
              required
            />
          </div>
          <Toggle
            label="TLS from connection start"
            selected={smtp.secure}
            onChange={(secure) =>
              setSmtp((previous) => ({ ...previous, secure }))
            }
            description="Enable for implicit TLS such as port 465. STARTTLS connections normally use port 587."
          />
          <Field
            label="From email address"
            type="email"
            value={smtp.from}
            onChange={(from) => setSmtp((previous) => ({ ...previous, from }))}
            required
          />
          <Field
            label="SMTP username"
            value={smtp.user}
            onChange={(user) => setSmtp((previous) => ({ ...previous, user }))}
          />
          <Field
            label="SMTP password (write only)"
            type="password"
            value={smtp.password}
            onChange={(password) =>
              setSmtp((previous) => ({ ...previous, password }))
            }
            autoComplete="new-password"
          />
        </Form>
      </Section>
      <Section
        title="S3-compatible object storage"
        description="Backups and artifacts use the installation destination. Credentials are encrypted, write only, and require operator identity approval. Restart the API and workers after saving."
      >
        <Form
          busy={mutation.busy}
          submit="Save object-storage configuration"
          onSubmit={async () => {
            const result = await mutation.run(
              () =>
                performAction<InstallationConfiguration>(
                  "updateInstallationConfiguration",
                  {
                    objectStorage: {
                      endpoint: storage.endpoint,
                      region: storage.region,
                      bucket: storage.bucket,
                      ...(storage.accessKeyId
                        ? { accessKeyId: storage.accessKeyId }
                        : {}),
                      ...(storage.secretAccessKey
                        ? { secretAccessKey: storage.secretAccessKey }
                        : {}),
                    },
                  },
                ),
              "Object-storage override saved. Restart the API and workers, then verify a backup.",
            );
            if (result.ok)
              setStorage((previous) => ({
                ...previous,
                accessKeyId: "",
                secretAccessKey: "",
              }));
          }}
        >
          <Field
            label="S3 endpoint"
            type="url"
            value={storage.endpoint}
            onChange={(endpoint) =>
              setStorage((previous) => ({ ...previous, endpoint }))
            }
            required
          />
          <div className="settings-inline">
            <Field
              label="Region"
              value={storage.region}
              onChange={(region) =>
                setStorage((previous) => ({ ...previous, region }))
              }
              required
            />
            <Field
              label="Bucket"
              value={storage.bucket}
              onChange={(bucket) =>
                setStorage((previous) => ({ ...previous, bucket }))
              }
              required
            />
          </div>
          <Field
            label="Access key ID (write only)"
            type="password"
            value={storage.accessKeyId}
            onChange={(accessKeyId) =>
              setStorage((previous) => ({ ...previous, accessKeyId }))
            }
            autoComplete="new-password"
          />
          <Field
            label="Secret access key (write only)"
            type="password"
            value={storage.secretAccessKey}
            onChange={(secretAccessKey) =>
              setStorage((previous) => ({ ...previous, secretAccessKey }))
            }
            autoComplete="new-password"
            description="Leave credential fields empty to preserve existing secrets."
          />
        </Form>
      </Section>
      <Section
        title="Test email delivery"
        description="A test is a durable job. A queued response does not confirm delivery."
      >
        <Form
          busy={mutation.busy}
          submit="Queue test email"
          onSubmit={async () => {
            const result = await mutation.run(
              () =>
                performAction<{ jobId: string }>("testEmail", { recipient }),
              "Test email queued.",
            );
            if (result.ok) setJobId(result.value.jobId);
          }}
        >
          <Field
            label="Recipient email"
            type="email"
            autoComplete="email"
            value={recipient}
            onChange={setRecipient}
            required
          />
        </Form>
        {jobId && <JobTracker orgId={props.orgId} jobId={jobId} />}
      </Section>
    </>
  );
}
