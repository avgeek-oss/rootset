import { createHash, createHmac } from "node:crypto";
import { assertAccess } from "@rootset/access";
import {
  ActivityInputSchema,
  ActivityFilterInputSchema,
  ActivityDetailsInputSchema,
  schemaActions,
  backupActions,
  jobActions,
  type ActivityInput,
  type ActivityAction,
  type ActivityFilterOptions,
  ActivityCategorySchema,
  canonicalJson,
  getOperation,
  limits,
  RootsetError,
  type Actor,
  type ActivityCategory,
  type ActivityEvent,
  type ActivityPage,
  type ActivityDetails,
  type JsonValue,
} from "@rootset/contracts";
import {
  withOrgRead,
  ReadCancelledError,
  ReadCancellationFailure,
  type Pool,
  type PoolClient,
} from "@rootset/database";
import { CursorCodec } from "@rootset/table-storage/query";
import {
  resourceActivityDetails,
  jobActivityDetails,
} from "./activity-details";

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
    workspaceId: actor.workspaceId ?? null,
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
  event_name: string;
  actor_key: string;
  status: ActivityEvent["status"];
  actor_id: string | null;
  actor_kind: string;
  actor_name: string;
  actor_email: string | null;
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

type ReadContext = { signal?: AbortSignal; responseBudget?: number };
interface ActivityAccess {
  current: Actor;
  records: boolean;
  backups: boolean;
  actions: ActivityAction[];
  jobs: ActivityAction[];
  availableCategories: ActivityCategory[];
}
function avatarUrl(email: string | null, kind: string | null): string | null {
  return email && !["operator", "system", "automation"].includes(kind ?? "")
    ? `https://www.gravatar.com/avatar/${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}?s=160&d=404&r=g`
    : null;
}
function activityParameters(
  actor: Actor,
  access: ActivityAccess,
  input: ActivityInput,
  cutoff: string | null,
  tuple: unknown[] | null,
  limit: number,
  eventId?: string,
): unknown[] {
  return [
    actor.orgId,
    JSON.stringify(access.actions),
    JSON.stringify(access.jobs),
    access.records,
    actor.role === "admin",
    `${actor.kind}:${actor.id}`,
    actor.userId ?? null,
    access.backups,
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
    input.event ?? null,
    input.actor ?? null,
    input.resource ?? null,
    eventId?.split(":")[0] ?? null,
    eventId?.split(":")[1] ?? null,
    eventId?.split(":")[2] ?? null,
    input.workspaceId,
  ];
}
const automationActorSql =
  "coalesce(s.actor->>'kind','system') IN ('operator','system')";
const actorKeySql = `CASE WHEN ${automationActorSql} THEN 'automation' ELSE coalesce('user:'||(s.actor->>'userId'),coalesce(s.actor->>'kind','system')||':'||coalesce(s.actor->>'id','rootset-worker')) END`;
const activitySourceSql = `
          WITH actions AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(operation text,category text,label text,destination text)),
          job_actions AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(operation text,category text,label text,destination text)),
          source AS NOT MATERIALIZED (
            SELECT 'm:'||m.id event_key,m.committed_at occurred_at,'records'::text category,'Records changed'::text summary,'records.changed'::text event_name,'succeeded'::text status,m.actor,t.database_id,t.id table_id,
              m.id mutation_id,NULL::varchar(26) job_id,NULL::text file_name,'record'::text destination,NULL::text related_database_id
            FROM rootset_control.mutations m JOIN rootset_control.tables t ON t.id=m.table_id AND t.org_id=m.org_id
            WHERE m.org_id=$1 AND $4::boolean AND coalesce(m.context->>'source','') NOT IN ('import','schema')
              AND ($22::text IS NULL OR ($22='m' AND m.id=$23::text))
              AND EXISTS(SELECT 1 FROM rootset_control.cell_changes c WHERE c.org_id=$1 AND c.mutation_id=m.id AND c.table_id=m.table_id)
            UNION ALL
            SELECT 'r:'||h.id,h.changed_at,a.category,a.label,h.operation,'succeeded',h.actor,h.database_id,h.table_id,NULL,NULL,NULL,a.destination,
              CASE WHEN h.operation='database.restore' THEN h.after_value->>'sourceDatabaseId' ELSE NULL END
            FROM rootset_control.resource_history h JOIN actions a ON a.operation=h.operation WHERE h.org_id=$1
              AND ($22::text IS NULL OR ($22='r' AND h.id=CASE WHEN $22='r' THEN $23::bigint END))
            UNION ALL
            SELECT 'j:'||e.id,e.occurred_at,a.category,
              a.label||CASE e.state WHEN 'queued' THEN ' requested' WHEN 'succeeded' THEN ' completed'
                WHEN 'failed' THEN ' failed' WHEN 'cancelled' THEN ' cancelled' WHEN 'partially_completed' THEN ' partially completed' END,
              'job.'||j.operation_id||'.'||e.state,
              CASE WHEN e.state='queued' THEN 'requested' ELSE e.state END,j.actor,
              CASE WHEN j.target_type='database' THEN j.target_id WHEN j.target_type='table' THEN t.database_id ELSE j.input->>'sourceDatabaseId' END,
              CASE WHEN j.target_type='table' THEN j.target_id ELSE NULL END,NULL,j.id,
              CASE WHEN a.category='imports' THEN left(j.input->>'fileName',255) ELSE NULL END,a.destination,NULL
            FROM rootset_control.activity_job_events e JOIN rootset_control.jobs j ON j.org_id=e.org_id AND j.id=e.job_id
            JOIN job_actions a ON a.operation=j.operation_id
            LEFT JOIN rootset_control.tables t ON t.org_id=j.org_id AND t.id=j.target_id AND j.target_type='table'
            WHERE e.org_id=$1 AND ($5::boolean OR j.requester_id=$6 OR ($7::text IS NOT NULL AND j.actor->>'userId'=$7))
              AND ($22::text IS NULL OR ($22='j' AND e.id=$23::text))
              AND NOT (e.state='succeeded' AND (a.category='schema' OR j.operation_id IN ('restoreDatabaseBackup','saveBackupSchedule')))
            UNION ALL
            SELECT 'a:'||a.id||':'||v.phase,v.occurred_at,'backups',
              CASE WHEN a.kind='failed' THEN 'Backup failure' ELSE 'Backup overdue' END||' '||v.phase,
              'backup.'||a.kind||'.'||v.phase,
              CASE WHEN v.phase='resolved' THEN 'resolved' ELSE 'failed' END,
              '{"kind":"system"}'::jsonb,a.database_id,NULL,NULL,NULL,NULL,'backup-history',NULL
            FROM rootset_control.backup_alerts a CROSS JOIN LATERAL (VALUES ('detected',a.detected_at),('resolved',a.resolved_at)) v(phase,occurred_at)
            WHERE a.org_id=$1 AND $8::boolean AND v.occurred_at IS NOT NULL
              AND ($22::text IS NULL OR ($22='a' AND a.id=$23::text AND v.phase=$24::text))
          ), visible AS NOT MATERIALIZED (
            SELECT s.*,d.name database_name,d.state database_state,t.name table_name,t.state table_state,
              ${actorKeySql} actor_key,coalesce(s.actor->>'id',NULL) actor_id,coalesce(s.actor->>'kind','system') actor_kind,u.email actor_email,
              CASE WHEN ${automationActorSql} THEN 'Automation' ELSE coalesce(nullif(u.name,''),CASE s.actor->>'kind' WHEN 'session' THEN 'Former member' WHEN 'personal_key' THEN 'Personal API key' WHEN 'workspace_key' THEN 'Workspace API key' WHEN 'oauth' THEN 'Connected application' ELSE 'Former member' END) END actor_name
            FROM source s
            LEFT JOIN rootset_control.databases d ON d.org_id=$1 AND d.id=s.database_id
            LEFT JOIN rootset_control.tables t ON t.org_id=$1 AND t.id=s.table_id
            LEFT JOIN rootset_control.users u ON u.id=s.actor->>'userId'
            WHERE d.workspace_id=$25 AND s.occurred_at<=coalesce($9::timestamptz,statement_timestamp()) AND ($10::timestamptz IS NULL OR s.occurred_at>=$10::timestamptz)
              AND ($11::timestamptz IS NULL OR s.occurred_at<=$11::timestamptz)
              AND ($12::text IS NULL OR s.database_id=$12 OR s.related_database_id=$12) AND ($13::text IS NULL OR s.table_id=$13)
              AND ($14::text IS NULL OR s.category=$14)
              AND ($19::text IS NULL OR s.event_name=$19)
              AND ($20::text IS NULL OR ${actorKeySql}=$20)
              AND ($21::text IS NULL OR coalesce('table:'||s.table_id,'database:'||s.database_id)=$21)
              AND ($15::timestamptz IS NULL OR (s.occurred_at,s.event_key COLLATE "C")<($15::timestamptz,$16::text COLLATE "C"))
          )`;

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
  async details(
    actor: Actor,
    raw: unknown,
    context: ReadContext = {},
  ): Promise<ActivityDetails> {
    const input = ActivityDetailsInputSchema.parse(raw);
    assertAccess(actor, { scope: "history:read", orgId: input.orgId });
    return this.withAccess(actor, context, async (access, client) => {
      const source = (
        await client.query<{
          event_name: string;
          occurred_at: string;
          actor_name: string;
          database_id: string | null;
          database_name: string | null;
          table_id: string | null;
          table_name: string | null;
          mutation_id: string | null;
          job_id: string | null;
          before_value: unknown;
          after_value: unknown;
          resource_id: string | null;
          input: unknown;
          state: string;
          attempt: number;
          kind: string;
          backup_id: string | null;
          occurrence_at: string;
        }>(
          `${activitySourceSql}
          SELECT v.event_name,${utc("v.occurred_at")} occurred_at,v.actor_name,v.database_id,v.database_name,v.table_id,v.table_name,v.mutation_id,v.job_id,
            h.before_value,h.after_value,h.resource_id,j.input,e.state,e.attempt,a.kind,a.backup_id,${utc("a.occurrence_at")} occurrence_at
          FROM visible v
          LEFT JOIN rootset_control.resource_history h ON $22='r' AND h.org_id=$1 AND h.id=CASE WHEN $22='r' THEN $23::bigint END
          LEFT JOIN rootset_control.jobs j ON j.org_id=$1 AND j.id=v.job_id
          LEFT JOIN rootset_control.activity_job_events e ON $22='j' AND e.org_id=$1 AND e.id=$23
          LEFT JOIN rootset_control.backup_alerts a ON $22='a' AND a.org_id=$1 AND a.id=$23
          WHERE v.event_key=$26
            AND ($17::text IS NULL OR strpos(lower(v.summary),lower($17))>0)
          LIMIT $18`,
          [
            ...activityParameters(
              access.current,
              access,
              { orgId: input.orgId, workspaceId: input.workspaceId },
              null,
              null,
              1,
              input.eventId,
            ),
            input.eventId,
          ],
        )
      ).rows[0];
      if (!source)
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "Audit event was not found",
          404,
        );
      let details: Record<string, JsonValue>;
      if (source.mutation_id) {
        const operations = await client.query<{
          operation: string;
          rows: number;
        }>(
          `SELECT operation,count(DISTINCT row_id)::integer rows FROM rootset_control.cell_changes
          WHERE org_id=$1 AND mutation_id=$2 GROUP BY operation ORDER BY operation`,
          [input.orgId, source.mutation_id],
        );
        const fields = await client.query<{ id: string; name: string }>(
          `SELECT DISTINCT field_id id,field_definition->>'name' name FROM rootset_control.cell_changes
          WHERE org_id=$1 AND mutation_id=$2 ORDER BY id LIMIT $3`,
          [input.orgId, source.mutation_id, limits.maxFields],
        );
        details = {
          operations: operations.rows.map((item) => ({
            operation: item.operation,
            records: item.rows,
          })),
          fields: fields.rows,
        };
      } else if (source.job_id) {
        details = jobActivityDetails(
          source.input,
          source.job_id,
          source.state,
          source.attempt,
        );
      } else if (input.eventId.startsWith("a:")) {
        details = {
          kind: source.kind,
          backupId: source.backup_id,
          scheduledFor: iso(source.occurrence_at),
        };
      } else {
        details = resourceActivityDetails(
          source.event_name,
          source.before_value,
          source.after_value,
        );
        if (source.event_name === "database.backup.prune")
          details.backupId = source.resource_id;
      }
      return {
        event: source.event_name,
        occurredAt: iso(source.occurred_at),
        actor: source.actor_name,
        resource: source.table_id
          ? { type: "table", id: source.table_id, name: source.table_name! }
          : source.database_id
            ? {
                type: "database",
                id: source.database_id,
                name: source.database_name!,
              }
            : null,
        context: details,
      };
    });
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
      event: input.event ?? null,
      actor: input.actor ?? null,
      resource: input.resource ?? null,
      q: input.q || null,
      from: input.from ?? null,
      to: input.to ?? null,
      limit,
    };
    const binding = {
      orgId: actor.orgId,
      workspaceId: actor.workspaceId ?? null,
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
    return this.withAccess(actor, context, async (access, client) => {
      const { current, availableCategories } = access;
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
          table_database_id: string | null;
          table_name: string | null;
          table_state: ResourceState | null;
          cutoff: string;
        }>(
          `SELECT d.id database_id,d.name database_name,d.state database_state,t.id table_id,t.database_id table_database_id,t.name table_name,t.state table_state,${utc("clock_timestamp()")} cutoff
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
              scope.table_database_id !== input.databaseId))) ||
        (input.databaseId && !scope.database_id)
      )
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "Resource was not found",
          404,
        );
      const cutoff = tuple ? (tuple[0] as string) : scope.cutoff;
      const rows = (
        await client.query<SourceRow>(
          `
          ${activitySourceSql}, candidates AS (
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
          SELECT p.event_key,${utc("p.occurred_at")} occurred_at,p.category,p.summary,p.event_name,p.status,p.actor_key,p.actor_id,p.actor_kind,p.actor_name,p.actor_email,
            p.database_id,p.database_name,p.database_state,p.table_id,p.table_name,p.table_state,p.job_id,p.file_name,p.destination,
            c.affected_rows,CASE WHEN c.affected_rows=1 AND NOT c.deleted THEN c.row_id ELSE NULL END row_id
          FROM page p LEFT JOIN LATERAL (
            SELECT count(DISTINCT row_id) affected_rows,min(row_id) row_id,bool_or(operation='delete') deleted FROM rootset_control.cell_changes
            WHERE org_id=$1 AND mutation_id=p.mutation_id AND p.mutation_id IS NOT NULL
          ) c ON p.mutation_id IS NOT NULL
          ORDER BY p.occurred_at DESC,p.event_key COLLATE "C" DESC`,
          activityParameters(current, access, input, cutoff, tuple, limit),
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
          event: row.event_name,
          status: row.status,
          occurredAt: iso(row.occurred_at),
          actor: {
            id: row.actor_id,
            key: row.actor_key,
            kind: row.actor_kind,
            name: row.actor_name,
            avatarUrl: avatarUrl(row.actor_email, row.actor_kind),
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
      return page;
    });
  }
  async filters(
    actor: Actor,
    value: unknown,
    context: ReadContext = {},
  ): Promise<ActivityFilterOptions> {
    const input = ActivityFilterInputSchema.parse(value);
    assertAccess(actor, { scope: "history:read", orgId: input.orgId });
    return this.withAccess(actor, context, async (access, client) => {
      const limit = input.limit ?? 50;
      const select =
        input.kind === "actors"
          ? "SELECT actor_key value,max(actor_name) label,'actor'::text kind,CASE WHEN actor_key<>'automation' THEN max(actor_email) END email,CASE WHEN actor_key='automation' THEN 'automation' ELSE max(actor_kind) END description FROM visible GROUP BY actor_key"
          : "SELECT coalesce('table:'||table_id,'database:'||database_id) value,max(coalesce(table_name,database_name)) label,CASE WHEN table_id IS NULL THEN 'database' ELSE 'table' END kind,NULL::text email,CASE WHEN table_id IS NOT NULL THEN max(database_name) END description FROM visible WHERE coalesce(table_name,database_name) IS NOT NULL GROUP BY table_id,database_id";
      const rows = (
        await client.query<{
          value: string;
          label: string;
          kind: "actor" | "database" | "table";
          email: string | null;
          description: string | null;
        }>(
          `${activitySourceSql}, options AS (${select}) SELECT * FROM options
          WHERE ($17::text IS NULL OR strpos(lower(concat_ws(' ',label,value,kind,description,
            CASE WHEN kind='actor' AND description='session' THEN 'User' END)),lower($17))>0)
          ORDER BY CASE WHEN kind='database' OR (kind='actor' AND description='automation') THEN 0
            WHEN kind='table' OR (kind='actor' AND (description='session' OR value LIKE 'user:%')) THEN 1 ELSE 2 END,
            lower(label),value COLLATE "C" LIMIT $18`,
          activityParameters(
            access.current,
            access,
            { orgId: input.orgId, workspaceId: input.workspaceId, q: input.q },
            null,
            null,
            limit,
          ),
        )
      ).rows;
      return {
        data: rows.slice(0, limit).map((row) => ({
          value: row.value,
          label: row.label,
          kind: row.kind,
          avatarUrl: avatarUrl(row.email, row.description),
          description: row.description,
        })),
        hasMore: rows.length > limit,
      };
    });
  }
  private async withAccess<T>(
    actor: Actor,
    context: ReadContext,
    read: (access: ActivityAccess, client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const initialAuthority = authority(actor);
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
            assertAccess(fresh, { scope: "history:read", orgId: actor.orgId });
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
          const remaining = limits.queryTimeoutMs - (Date.now() - started);
          if (remaining <= 0) throw new ReadCancelledError();
          await client.query("SELECT set_config('statement_timeout',$1,true)", [
            `${remaining}ms`,
          ]);
          const result = await read(
            { current, records, backups, actions, jobs, availableCategories },
            client,
          );
          if (
            Buffer.byteLength(JSON.stringify(result)) >
            Math.min(
              context.responseBudget ?? limits.restResultBytes,
              limits.restResultBytes,
            )
          )
            throw new RootsetError(
              "RESULT_TOO_LARGE",
              "Activity metadata exceeds this response budget",
              413,
            );
          checkAuthority(await this.options.refreshActor(current, client));
          return result;
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
