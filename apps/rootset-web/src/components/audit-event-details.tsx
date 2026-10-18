"use client";

import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryLoading } from "@avgeek-oss/design-system";
import type { ActivityDetails } from "@rootset/contracts";
import { client } from "@rootset/web-client";
import { AuditLogError } from "./audit-log-error";
import { Dialog } from "./dialog";
const JsonEditor = lazy(() =>
  import("./json-editor").then((module) => ({ default: module.JsonEditor })),
);

export function AuditEventDetails({
  orgId,
  eventId,
  onClose,
}: {
  orgId: string;
  eventId: string;
  onClose(): void;
}) {
  const details = useQuery({
    queryKey: ["activity-details", orgId, eventId],
    queryFn: ({ signal }) =>
      client.operation<ActivityDetails>(
        "getActivityDetails",
        { orgId, eventId },
        { signal },
      ),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  return (
    <Dialog title="Audit event details" onClose={onClose} wide>
      <div className="min-w-0">
        {details.isError ? (
          <AuditLogError
            error={details.error}
            message="Event details could not be loaded."
            onRetry={() => void details.refetch()}
          />
        ) : details.isPending ? (
          <QueryLoading />
        ) : (
          <Suspense fallback={<QueryLoading />}>
            <JsonEditor
              label="Audit event JSON"
              value={JSON.stringify(details.data.context, null, 2)}
              onChange={() => {}}
              readOnly
            />
          </Suspense>
        )}
      </div>
    </Dialog>
  );
}
