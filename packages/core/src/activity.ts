import { createHash, createHmac } from "node:crypto";
import { assertAccess } from "@rootset/access";
import {
  ActivityInputSchema,
  ActivityCategorySchema,
  canonicalJson,
  getOperation,
  limits,
  RootsetError,
  type Actor,
  type ActivityCategory,
  type ActivityEvent,
  type ActivityPage,
} from "@rootset/contracts";
import {
  withOrgRead,
  ReadCancelledError,
  ReadCancellationFailure,
  type Pool,
  type PoolClient,
} from "@rootset/database";
import { CursorCodec } from "@rootset/table-storage/query";

interface Action {
  operation: string;
  category: ActivityCategory;
  label: string;
  destination: ActivityEvent["destination"];
}
const schemaActions: Action[] = [
  ["database.create", "Database created", "database"],
  ["database.update", "Database updated", "database"],
  ["database.delete", "Database deleted", null],
  ["table.create", "Table created", "table"],
  ["table.update", "Table updated", "table"],
  ["table.delete", "Table deleted", null],
  ["field.create", "Field added", "table"],
  ["field.update", "Field updated", "table"],
  ["field.convert", "Field converted", "table"],
  ["field.delete", "Field deleted", "table"],
  ["fields.reorder", "Fields reordered", "table"],
  ["rule.create", "Unique rule created", "table"],
  ["rule.delete", "Unique rule deleted", "table"],
  ["foreign-key.create", "Foreign key created", "table"],
  ["foreign-key.delete", "Foreign key deleted", "table"],
].map(([operation, label, destination]) => ({
  operation: operation!,
  label: label!,
  category: "schema",
  destination: destination as ActivityEvent["destination"],
}));
const backupActions: Action[] = [
  {
    operation: "database.backup_schedule.update",
    category: "backups",
    label: "Backup schedule saved",
    destination: "backup-schedule",
  },
  {
    operation: "database.backup_schedule.delete",
    category: "backups",
    label: "Backup schedule stopped",
    destination: "backup-schedule",
  },
  {
    operation: "database.backup_policy.update",
    category: "backups",
    label: "Backup protection updated",
    destination: "backup-schedule",
  },
  {
    operation: "database.backup.prune",
    category: "backups",
    label: "Backup package pruned",
    destination: "backup-history",
  },
  {
    operation: "database.restore",
    category: "restores",
    label: "Database restored",
    destination: "database",
  },
];
const jobActions: Action[] = [
  {
    operation: "previewImportRows",
    category: "imports",
    label: "Import validation",
    destination: "imports",
  },
  {
    operation: "importRows",
    category: "imports",
    label: "Record import",
    destination: "imports",
  },
  {
    operation: "exportRows",
    category: "exports",
    label: "Table export",
    destination: "exports",
  },
  {
    operation: "exportView",
    category: "exports",
    label: "View export",
    destination: "exports",
  },
  {
    operation: "exportDatabase",
    category: "exports",
    label: "Database export",
    destination: "database-exports",
  },
  {
    operation: "saveBackupSchedule",
    category: "backups",
    label: "Backup destination verification",
    destination: "backup-schedule",
  },
  {
    operation: "testBackupDestination",
    category: "backups",
    label: "Backup destination test",
    destination: "backup-history",
  },
  {
    operation: "runDatabaseBackup",
    category: "backups",
    label: "Database backup",
    destination: "backup-history",
  },
  {
    operation: "previewDatabaseRestore",
    category: "restores",
    label: "Backup verification",
    destination: "backup-history",
  },
  {
    operation: "restoreDatabaseBackup",
    category: "restores",
    label: "Database restore",
    destination: "backup-history",
  },
  ...[
    ["createTable", "Table creation"],
    ["updateTable", "Table update"],
    ["deleteTable", "Table deletion"],
    ["createField", "Field creation"],
    ["updateField", "Field update"],
    ["deleteField", "Field deletion"],
    ["applySchemaChange", "Schema change"],
    ["reorderFields", "Field reordering"],
    ["createUniqueRule", "Unique rule creation"],
    ["deleteUniqueRule", "Unique rule deletion"],
    ["createForeignKey", "Foreign key creation"],
    ["deleteForeignKey", "Foreign key deletion"],
    ["deleteDatabase", "Database deletion"],
  ].map(([operation, label]): Action => ({
    operation: operation!,
    label: label!,
    category: "schema",
    destination: null,
  })),
];

function can(actor: Actor, scopes: string[], admin = false): boolean {
  try {
    for (const scope of scopes)
      assertAccess(actor, { scope, ...(admin ? { roles: ["admin"] } : {}) });
    return true;
  } catch (error) {
    if (error instanceof RootsetError && error.status === 403) return false;
    throw error;
  }
}
function authority(actor: Actor): string {
  return canonicalJson({
    kind: actor.kind,
    id: actor.id,
    orgId: actor.orgId,
    userId: actor.userId ?? null,
    credentialId: actor.credentialId ?? null,
    clientId: actor.clientId ?? null,
    role: actor.role,
    membershipVersion: actor.membershipVersion ?? 0,
    scopes: [...new Set(actor.scopes)].sort(),
  });
}
type ResourceState = NonNullable<ActivityEvent["table"]>["state"];
interface SourceRow {
  event_key: string;
  occurred_at: string;
  category: ActivityCategory;
  summary: string;
  status: ActivityEvent["status"];
  actor_id: string | null;
  actor_kind: string;
  actor_name: string;
  database_id: string | null;
  database_name: string | null;
  database_state: ResourceState | null;
  table_id: string | null;
  table_name: string | null;
  table_state: ResourceState | null;
  row_id: string | null;
  affected_rows: string | null;
  job_id: string | null;
  file_name: string | null;
  destination: ActivityEvent["destination"];
}
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const iso = (value: string) => new Date(value).toISOString();
const cursorError = () =>
  new RootsetError(
    "CURSOR_INVALID",
    "Activity cursor is invalid; refresh the activity page",
    409,
  );

export class ActivityReader {
  private readonly cursors: CursorCodec;
  constructor(
    private readonly options: {
      pool: Pool;
      secret: string;
      refreshActor: (actor: Actor, client: PoolClient) => Promise<Actor>;
    },
  ) {
    this.cursors = new CursorCodec(
      createHmac("sha256", options.secret)
        .update("rootset:activity:v1")
        .digest(),
    );
  }
  async list(
    actor: Actor,
    value: unknown,
    context: { signal?: AbortSignal; responseBudget?: number } = {},
  ): Promise<ActivityPage> {
    const input = ActivityInputSchema.parse(value);
    assertAccess(actor, { scope: "history:read", orgId: input.orgId });
    const initialAuthority = authority(actor);
    const limit = input.limit ?? 50;
    const filter = {
      databaseId: input.databaseId ?? null,
      tableId: input.tableId ?? null,
      category: input.category ?? null,
      q: input.q || null,
      from: input.from ?? null,
      to: input.to ?? null,
      limit,
    };
    const binding = {
      orgId: actor.orgId,
      tableId: actor.orgId,
      schemaVersion: 1,
      membershipVersion: actor.membershipVersion ?? 0,
      actorId: actor.id,
      queryHash: createHash("sha256")
        .update(
          canonicalJson({
            domain: "activity:v1",
            authority: initialAuthority,
            filter,
          }),
        )
        .digest("hex"),
    };
    const tuple = input.cursor
      ? this.cursors.decode(input.cursor, binding)
      : null;
    if (
      tuple &&
      (tuple.length !== 3 ||
        typeof tuple[0] !== "string" ||
        !timestamp.test(tuple[0]) ||
        !(
          (tuple[1] === null && tuple[2] === null) ||
          (typeof tuple[1] === "string" &&
            timestamp.test(tuple[1]) &&
            typeof tuple[2] === "string" &&
            /^[mrja]:[A-Za-z0-9:_-]{1,100}$/.test(tuple[2]))
        ))
    )
      throw cursorError();
    const signal = context.signal
      ? AbortSignal.any([
          context.signal,
          AbortSignal.timeout(limits.queryTimeoutMs),
        ])
      : AbortSignal.timeout(limits.queryTimeoutMs);
    const started = Date.now();
    try {
      return await withOrgRead(
        this.options.pool,
        actor.orgId,
        async (client) => {
          const current = await this.options.refreshActor(actor, client);
          const checkAuthority = (fresh: Actor) => {
            if (authority(fresh) !== initialAuthority)
              throw new RootsetError(
                "FORBIDDEN",
                "Your access changed; refresh the activity page",
                403,
              );
            assertAccess(fresh, { scope: "history:read", orgId: input.orgId });
          };
          checkAuthority(current);
          const records = can(current, ["rows:read"]);
          const schema = can(current, ["schema:read"]);
          const backups = can(current, ["backups:read"], true);
          const actions = [
            ...(schema ? schemaActions : []),
            ...(backups ? backupActions : []),
          ];
          const jobs = can(current, ["jobs:read"])
            ? jobActions.filter((action) => {
                const operation = getOperation(action.operation);
                return (
                  can(
                    current,
                    operation.scopes,
                    operation.minimumRole === "admin",
                  ) &&
                  (!operation.personal || !!current.userId)
                );
              })
            : [];
          const permittedCategories = new Set([
            ...(records ? ["records" as const] : []),
            ...actions.map((a) => a.category),
            ...jobs.map((a) => a.category),
          ]);
          const availableCategories = ActivityCategorySchema.options.filter(
            (category) => permittedCategories.has(category),
          );
          if (input.category && !availableCategories.includes(input.category))
            throw new RootsetError(
              "FORBIDDEN",
              "Your access does not allow this activity category",
              403,
            );
          const scope = (
            await client.query<{
              database_id: string | null;
              database_name: string | null;
              database_state: ResourceState | null;
              table_id: string | null;
              table_name: string | null;
              table_state: ResourceState | null;
              cutoff: string;
            }>(
              `SELECT d.id database_id,d.name database_name,d.state database_state,t.id table_id,t.name table_name,t.state table_state,${utc("clock_timestamp()")} cutoff
          FROM (SELECT 1) anchor
          LEFT JOIN rootset_control.tables t ON t.org_id=$1 AND t.id=$2
          LEFT JOIN rootset_control.databases d ON d.org_id=$1 AND d.id=coalesce($3,t.database_id)`,
              [actor.orgId, input.tableId ?? null, input.databaseId ?? null],
            )
          ).rows[0]!;
          if (
            (input.tableId &&
              (!scope.table_id ||
                (input.databaseId &&
                  scope.database_id !== input.databaseId))) ||
            (input.databaseId && !scope.database_id)
          )
            throw new RootsetError(
              "RESOURCE_NOT_FOUND",
              "Resource was not found",
              404,
            );
          // A table ID cannot be paired with an unrelated database, including archived resources.
          if (input.tableId && input.databaseId) {
            const matches = await client.query(
              "SELECT 1 FROM rootset_control.tables WHERE org_id=$1 AND id=$2 AND database_id=$3",
              [actor.orgId, input.tableId, input.databaseId],
            );
            if (!matches.rowCount)
              throw new RootsetError(
                "RESOURCE_NOT_FOUND",
                "Resource was not found",
                404,
              );
          }
          const cutoff = tuple ? (tuple[0] as string) : scope.cutoff;
          const remaining = limits.queryTimeoutMs - (Date.now() - started);
          if (remaining <= 0) throw new ReadCancelledError();
          await client.query("SELECT set_config('statement_timeout',$1,true)", [
            `${remaining}ms`,
          ]);
          const rows = (
            await client.query<SourceRow>(
              `
          WITH actions AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(operation text,category text,label text,destination text)),
          job_actions AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(operation text,category text,label text,destination text)),
          source AS NOT MATERIALIZED (
            SELECT 'm:'||m.id event_key,m.committed_at occurred_at,'records'::text category,'Records changed'::text summary,'succeeded'::text status,m.actor,t.database_id,t.id table_id,
              m.id mutation_id,NULL::varchar(26) job_id,NULL::text file_name,'record'::text destination,NULL::text related_database_id
            FROM rootset_control.mutations m JOIN rootset_control.tables t ON t.id=m.table_id AND t.org_id=m.org_id
            WHERE m.org_id=$1 AND $4::boolean AND coalesce(m.context->>'source','') NOT IN ('import','schema')
              AND EXISTS(SELECT 1 FROM rootset_control.cell_changes c WHERE c.org_id=$1 AND c.mutation_id=m.id AND c.table_id=m.table_id)
            UNION ALL
            SELECT 'r:'||h.id,h.changed_at,a.category,a.label,'succeeded',h.actor,h.database_id,h.table_id,NULL,NULL,NULL,a.destination,
              CASE WHEN h.operation='database.restore' THEN h.after_value->>'sourceDatabaseId' ELSE NULL END
            FROM rootset_control.resource_history h JOIN actions a ON a.operation=h.operation WHERE h.org_id=$1
            UNION ALL
            SELECT 'j:'||e.id,e.occurred_at,a.category,a.label,CASE WHEN e.state='queued' THEN 'requested' ELSE e.state END,j.actor,
              CASE WHEN j.target_type='database' THEN j.target_id WHEN j.target_type='table' THEN t.database_id ELSE j.input->>'sourceDatabaseId' END,
              CASE WHEN j.target_type='table' THEN j.target_id ELSE NULL END,NULL,j.id,
              CASE WHEN a.category='imports' THEN left(j.input->>'fileName',255) ELSE NULL END,a.destination,NULL
            FROM rootset_control.activity_job_events e JOIN rootset_control.jobs j ON j.org_id=e.org_id AND j.id=e.job_id
            JOIN job_actions a ON a.operation=j.operation_id
            LEFT JOIN rootset_control.tables t ON t.org_id=j.org_id AND t.id=j.target_id AND j.target_type='table'
            WHERE e.org_id=$1 AND ($5::boolean OR j.requester_id=$6 OR ($7::text IS NOT NULL AND j.actor->>'userId'=$7))
              AND NOT (e.state='succeeded' AND (a.category='schema' OR j.operation_id IN ('restoreDatabaseBackup','saveBackupSchedule')))
            UNION ALL
            SELECT 'a:'||a.id||':'||v.phase,v.occurred_at,'backups',
              CASE WHEN a.kind='failed' THEN 'Backup failure alert' ELSE 'Backup overdue alert' END,
              CASE WHEN v.phase='resolved' THEN 'resolved' ELSE 'failed' END,
              '{"kind":"system"}'::jsonb,a.database_id,NULL,NULL,NULL,NULL,'backup-history',NULL
            FROM rootset_control.backup_alerts a CROSS JOIN LATERAL (VALUES ('detected',a.detected_at),('resolved',a.resolved_at)) v(phase,occurred_at)
            WHERE a.org_id=$1 AND $8::boolean AND v.occurred_at IS NOT NULL
          ), visible AS NOT MATERIALIZED (
            SELECT s.*,d.name database_name,d.state database_state,t.name table_name,t.state table_state,
              coalesce(s.actor->>'id',NULL) actor_id,coalesce(s.actor->>'kind','system') actor_kind,
              coalesce(nullif(u.name,''),CASE WHEN s.actor->>'id'='backup-retention' THEN 'Rootset worker' ELSE CASE s.actor->>'kind' WHEN 'session' THEN 'Former member' WHEN 'personal_key' THEN 'Personal API key' WHEN 'team_key' THEN 'Team API key' WHEN 'oauth' THEN 'Connected application' WHEN 'operator' THEN 'Operator' ELSE 'Rootset worker' END END) actor_name
            FROM source s
            LEFT JOIN rootset_control.databases d ON d.org_id=$1 AND d.id=s.database_id
            LEFT JOIN rootset_control.tables t ON t.org_id=$1 AND t.id=s.table_id
            LEFT JOIN rootset_control.users u ON u.id=s.actor->>'userId'
            WHERE s.occurred_at<=$9::timestamptz AND ($10::timestamptz IS NULL OR s.occurred_at>=$10::timestamptz)
              AND ($11::timestamptz IS NULL OR s.occurred_at<=$11::timestamptz)
              AND ($12::text IS NULL OR s.database_id=$12 OR s.related_database_id=$12) AND ($13::text IS NULL OR s.table_id=$13)
              AND ($14::text IS NULL OR s.category=$14)
              AND ($15::timestamptz IS NULL OR (s.occurred_at,s.event_key COLLATE "C")<($15::timestamptz,$16::text COLLATE "C"))
          ), candidates AS (
            ${ActivityCategorySchema.options
              .map(
                (
                  category,
                ) => `(SELECT * FROM visible WHERE category='${category}'
              AND ($17::text IS NULL OR strpos(lower(concat_ws(' ',summary,actor_name,actor_id,database_name,table_name,file_name,status)),lower($17))>0)
              ORDER BY occurred_at DESC,event_key COLLATE "C" DESC LIMIT $18)`,
              )
              .join(" UNION ALL ")}
          ), page AS (
            SELECT * FROM candidates ORDER BY occurred_at DESC,event_key COLLATE "C" DESC LIMIT $18
          )
          SELECT p.event_key,${utc("p.occurred_at")} occurred_at,p.category,p.summary,p.status,p.actor_id,p.actor_kind,p.actor_name,
            p.database_id,p.database_name,p.database_state,p.table_id,p.table_name,p.table_state,p.job_id,p.file_name,p.destination,
            c.affected_rows,CASE WHEN c.affected_rows=1 AND NOT c.deleted THEN c.row_id ELSE NULL END row_id
          FROM page p LEFT JOIN LATERAL (
            SELECT count(DISTINCT row_id) affected_rows,min(row_id) row_id,bool_or(operation='delete') deleted FROM rootset_control.cell_changes
            WHERE org_id=$1 AND mutation_id=p.mutation_id AND p.mutation_id IS NOT NULL
          ) c ON p.mutation_id IS NOT NULL
          ORDER BY p.occurred_at DESC,p.event_key COLLATE "C" DESC`,
              [
                actor.orgId,
                JSON.stringify(actions),
                JSON.stringify(jobs),
                records,
                current.role === "admin",
                `${current.kind}:${current.id}`,
                current.userId ?? null,
                backups,
                cutoff,
                input.from ?? null,
                input.to ?? null,
                input.databaseId ?? null,
                input.tableId ?? null,
                input.category ?? null,
                tuple?.[1] ?? null,
                tuple?.[2] ?? null,
                input.q || null,
                limit + 1,
              ],
            )
          ).rows;
          const page: ActivityPage = {
            data: [],
            asOf: iso(cutoff),
            startCursor: this.cursors.encode(binding, [cutoff, null, null]),
            hasMore: rows.length > limit,
            nextCursor: null,
            availableCategories,
            scope: {
              database: scope.database_id
                ? {
                    id: scope.database_id,
                    name: scope.database_name!,
                    state: scope.database_state!,
                  }
                : null,
              table: scope.table_id
                ? {
                    id: scope.table_id,
                    name: scope.table_name!,
                    state: scope.table_state!,
                  }
                : null,
            },
          };
          const byteLimit = Math.min(
            context.responseBudget ?? limits.restResultBytes,
            limits.restResultBytes,
          );
          let last: SourceRow | undefined;
          for (const row of rows.slice(0, limit)) {
            const active =
              row.database_state === "active" &&
              (!row.table_id || row.table_state === "active");
            const event: ActivityEvent = {
              id: row.event_key,
              category: row.category,
              summary: row.summary,
              status: row.status,
              occurredAt: iso(row.occurred_at),
              actor: {
                id: row.actor_id,
                kind: row.actor_kind,
                name: row.actor_name,
              },
              database:
                row.database_id && row.database_name
                  ? {
                      id: row.database_id,
                      name: row.database_name,
                      state: row.database_state!,
                    }
                  : null,
              table:
                row.table_id && row.table_name
                  ? {
                      id: row.table_id,
                      name: row.table_name,
                      state: row.table_state!,
                    }
                  : null,
              rowId: row.row_id,
              affectedRows:
                row.affected_rows === null ? null : Number(row.affected_rows),
              jobId: row.job_id,
              fileName: row.file_name,
              destination: !active
                ? null
                : row.destination === "record" && !row.row_id
                  ? "table"
                  : row.destination,
            };
            const nextCursor = this.cursors.encode(binding, [
              cutoff,
              row.occurred_at,
              row.event_key,
            ]);
            const candidate = {
              ...page,
              data: [...page.data, event],
              nextCursor,
              hasMore: true,
            };
            if (Buffer.byteLength(JSON.stringify(candidate)) > byteLimit) {
              if (!last)
                throw new RootsetError(
                  "RESULT_TOO_LARGE",
                  "An activity event exceeds this response budget",
                  413,
                );
              page.hasMore = true;
              break;
            }
            page.data.push(event);
            last = row;
          }
          if (page.hasMore && last)
            page.nextCursor = this.cursors.encode(binding, [
              cutoff,
              last.occurred_at,
              last.event_key,
            ]);
          if (Buffer.byteLength(JSON.stringify(page)) > byteLimit)
            throw new RootsetError(
              "RESULT_TOO_LARGE",
              "Activity metadata exceeds this response budget",
              413,
            );
          checkAuthority(await this.options.refreshActor(current, client));
          return page;
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ReadCancellationFailure)
        throw new RootsetError(
          "UPSTREAM_UNAVAILABLE",
          "Activity could not be read safely; try again",
          503,
        );
      if (
        error instanceof ReadCancelledError ||
        signal.aborted ||
        (error as { code?: string }).code === "57014"
      )
        throw new RootsetError(
          "REQUEST_TIMEOUT",
          "Activity read timed out; narrow the search and try again",
          408,
        );
      throw error;
    }
  }
}
