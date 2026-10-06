"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { useResource } from "./api";
import { DateLabel, Loading, Record, RecordList, Section, Status } from "./ui";

interface InstallationStatus {
  healthy: boolean;
  version: string;
  migrationVersion: string;
  dependencies: Record<string, string>;
  workerHeartbeatAt: string | null;
}

export function InstallationSettings() {
  const status = useResource<InstallationStatus | null>(
    "/installation/status",
    null,
  );
  return (
    <Section
      title="Installation health"
      description="SMTP delivery and object storage are configured in the installation environment file."
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
  );
}
