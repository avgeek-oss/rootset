"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  buttonVariants,
} from "@avgeek-oss/design-system/buttons/button";
import { ResourceTable } from "@avgeek-oss/design-system/patterns/resource-table";
import { ApiError, client } from "@rootset/web-client";
import type { RowRelationships } from "@rootset/contracts";
import { reverseRelationshipPath } from "../lib/foreign-key-navigation";
import { ArrowUpRight, RefreshCw } from "./ui/icons";

export function RecordRelationships({
  target,
  rowId,
  version,
  disabled,
  onAccessLost,
  onReloadRecord,
}: {
  target: { orgId: string; databaseId: string; tableId: string };
  rowId: string;
  version: string;
  disabled: boolean;
  onAccessLost(): void;
  onReloadRecord(): void;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const relations = useQuery({
    queryKey: ["record-relationships", target.tableId, rowId, version, cursor],
    queryFn: ({ signal }) =>
      client.operation<RowRelationships>(
        "getRowRelationships",
        {
          ...target,
          rowId,
          expectedVersion: version,
          limit: 20,
          ...(cursor ? { cursor } : {}),
        },
        { signal },
      ),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (
      relations.error instanceof ApiError &&
      [401, 403, 404].includes(relations.error.status)
    )
      onAccessLost();
  }, [relations.error, onAccessLost]);
  const changed =
    relations.error instanceof ApiError &&
    relations.error.code === "ROW_VERSION_CONFLICT";
  return (
    <section className="min-w-0 space-y-4" aria-label="Related records">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">Related records</h3>
        <Button
          type="button"
          isIconOnly
          variant="secondary"
          aria-label="Refresh related records"
          isDisabled={disabled || relations.isFetching}
          onPress={() => void relations.refetch()}
        >
          <RefreshCw />
        </Button>
      </div>
      <p className="text-sm text-muted">
        References to the saved record. Unsaved field changes are not included.
      </p>
      {relations.isError ? (
        <div className="space-y-3">
          <p role="alert">{relations.error.message}</p>
          <Button
            type="button"
            variant="secondary"
            isDisabled={disabled || relations.isFetching}
            onPress={() =>
              changed ? onReloadRecord() : void relations.refetch()
            }
          >
            {changed ? "Reload record" : "Retry related records"}
          </Button>
        </div>
      ) : relations.isPending ? (
        <p role="status" className="text-sm text-muted">
          Loading related records…
        </p>
      ) : (
        <>
          <ResourceTable
            ariaLabel="Related records"
            items={relations.data.data}
            getRowKey={(relation) => relation.id}
            tableClassName="min-w-md"
            emptyTitle="No incoming relationships"
            emptyDescription="No foreign keys reference this table."
            columns={[
              {
                key: "table",
                header: "Table",
                cell: (relation) => (
                  <div className="space-y-1">
                    <p className="font-medium">{relation.tableName}</p>
                    <p className="text-xs text-muted">
                      {relation.fieldNames.join(", ")}
                    </p>
                  </div>
                ),
              },
              {
                key: "count",
                header: "Records",
                cell: (relation) => relation.count.toLocaleString(),
              },
              {
                key: "open",
                header: "Actions",
                headerClassName: "text-right",
                cell: (relation) =>
                  relation.tableState !== "active" ? (
                    <span className="text-sm text-muted">Maintenance</span>
                  ) : relation.hasKey ? (
                    <a
                      className={buttonVariants({ variant: "secondary" })}
                      href={reverseRelationshipPath(
                        target.databaseId,
                        relation.tableId,
                        relation.id,
                        rowId,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open related records in ${relation.tableName} (new tab)`}
                    >
                      Open records
                      <ArrowUpRight />
                    </a>
                  ) : (
                    <span className="text-sm text-muted">
                      No referenced key
                    </span>
                  ),
              },
            ]}
          />
          {(cursors.length > 0 || relations.data.nextCursor) && (
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="secondary"
                isDisabled={disabled || relations.isFetching || !cursors.length}
                onPress={() => setCursors((current) => current.slice(0, -1))}
              >
                Previous relationships
              </Button>
              <Button
                type="button"
                variant="secondary"
                isDisabled={
                  disabled || relations.isFetching || !relations.data.nextCursor
                }
                onPress={() => {
                  if (relations.data.nextCursor)
                    setCursors((current) => [
                      ...current,
                      relations.data.nextCursor!,
                    ]);
                }}
              >
                Next relationships
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
