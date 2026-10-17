"use client";
import { usePageQuery } from "./page-navigation";
import type { ComponentProps } from "react";
import {
  Button,
  buttonVariants,
} from "@avgeek-oss/design-system/buttons/button";
import { client } from "@rootset/web-client";
import { IdSchema, type RelatedRowFilter } from "@rootset/contracts";
import { Spreadsheet } from "./spreadsheet";
import { RefreshCw } from "./ui/icons";

export function RelatedSpreadsheet({
  relationshipId = null,
  referencedRowId = null,
  ...props
}: ComponentProps<typeof Spreadsheet> & {
  relationshipId?: string | null;
  referencedRowId?: string | null;
}) {
  const linked = relationshipId !== null || referencedRowId !== null;
  const rule = IdSchema.safeParse(relationshipId),
    row = IdSchema.safeParse(referencedRowId);
  const mixed = props.linkedFilter !== null && props.linkedFilter !== undefined;
  const valid = rule.success && row.success && !mixed;
  const relation = usePageQuery({
    queryKey: [
      "related-row-filter",
      props.table.id,
      relationshipId,
      referencedRowId,
    ],
    queryFn: ({ signal }) =>
      client.operation<RelatedRowFilter>(
        "getRelatedRowFilter",
        {
          orgId: props.orgId,
          databaseId: props.databaseId,
          tableId: props.table.id,
          ruleId: rule.success ? rule.data : relationshipId,
          referencedRowId: row.success ? row.data : referencedRowId,
        },
        { signal },
      ),
    enabled: linked && valid,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (
    props.initialRecordId !== null &&
    props.initialRecordId !== undefined &&
    !IdSchema.safeParse(props.initialRecordId).success
  )
    return (
      <div className="empty-state" role="alert">
        <h2>Record unavailable</h2>
        <p>This record link is invalid.</p>
      </div>
    );
  if (!linked) return <Spreadsheet {...props} />;
  if (!valid || relation.isError)
    return (
      <div className="empty-state" role="alert">
        <h2>Related records unavailable</h2>
        <p>
          {!valid
            ? mixed
              ? "This link combines different relationship filters. Open a single relationship link or choose a filter in the table."
              : "This relationship link is invalid."
            : relation.error?.message}
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          {valid && (
            <Button variant="secondary" onPress={() => void relation.refetch()}>
              <RefreshCw />
              Retry relationship
            </Button>
          )}
          <a
            className={buttonVariants({ variant: "secondary" })}
            href={`/databases/${props.databaseId}/tables/${props.table.id}`}
          >
            Open table without this filter
          </a>
        </div>
      </div>
    );
  if (relation.isPending)
    return (
      <div className="empty-state" role="status">
        <p>Loading related records…</p>
      </div>
    );
  return (
    <Spreadsheet
      {...props}
      linkedFilter={JSON.stringify(relation.data.filter)}
    />
  );
}
