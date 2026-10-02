import { z } from "zod";
import {
  CapacityConfigurationSchema,
  IdSchema,
  RootsetError,
} from "@rootset/contracts";
import { type Pool, type PoolClient, type Queryable } from "@rootset/database";

export { CapacityConfigurationSchema } from "@rootset/contracts";
export type CapacityConfiguration = z.infer<typeof CapacityConfigurationSchema>;
export interface CapacityRequest {
  reserveBytes: bigint;
  operation: string;
}
export interface CapacityReservation {
  orgId: string;
  transactionId: string;
  enabled: boolean;
  reserveBytes: string;
  databaseBeforeBytes?: string;
  organisationBeforeBytes?: string;
}
export interface CapacityAdmission {
  begin(
    client: PoolClient,
    orgId: string,
    request: CapacityRequest,
  ): Promise<CapacityReservation>;
  finish(client: PoolClient, reservation: CapacityReservation): Promise<void>;
  withSessionAdmission<T>(
    client: PoolClient,
    orgId: string,
    request: CapacityRequest,
    work: (validate: () => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

export async function acquireCapacitySessionLock(
  client: PoolClient,
  mode: "shared" | "exclusive" = "exclusive",
  timeoutMilliseconds = 10000,
): Promise<void> {
  const functionName =
    mode === "shared" ? "pg_try_advisory_lock_shared" : "pg_try_advisory_lock";
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const row = (
      await client.query<{ acquired: boolean }>(
        `SELECT ${functionName}(hashtextextended('rootset:storage-capacity',0)) AS acquired`,
      )
    ).rows[0];
    if (row?.acquired) return;
    if (Date.now() >= deadline)
      throw new RootsetError(
        "STORAGE_ADMISSION_BUSY",
        "Storage admission is busy; retry the unchanged request after the active operation completes",
        503,
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function mapCapacityError(error: unknown): RootsetError | null {
  if (error instanceof RootsetError) return error;
  if (!error || typeof error !== "object") return null;
  const item = error as { code?: string; message?: string };
  if (item.code === "P0001" && item.message?.startsWith("ROOTSET_CAPACITY:")) {
    const reason = item.message.slice("ROOTSET_CAPACITY:".length);
    return new RootsetError(
      reason,
      reason === "STORAGE_ADMISSION_BUSY"
        ? "Storage admission is busy; retry the unchanged request after the active operation completes"
        : reason === "STORAGE_POLICY_CHANGED"
          ? "Storage capacity policy changed during admission; retry the unchanged request under the current limits"
          : reason === "STORAGE_REPORT_STALE"
            ? "PostgreSQL filesystem capacity report is missing or stale. Restore the database-host reporter or revise the configured free-space policy."
            : reason === "STORAGE_RESERVATION_REQUIRED"
              ? "This storage write requires a transaction capacity reservation."
              : reason === "STORAGE_RESERVATION_EXCEEDED"
                ? "The operation exceeded its reserved storage budget. Retry a smaller batch or reserve sufficient schema space."
                : "Storage admission failed. Increase the applicable quota, free PostgreSQL storage through approved maintenance, or reduce the operation size.",
      503,
    );
  }
  return null;
}
function capacityError(error: unknown): never {
  const mapped = mapCapacityError(error);
  if (mapped) throw mapped;
  throw error;
}

export class CapacityService implements CapacityAdmission {
  constructor(readonly pool: Pool) {}
  async configuration(
    connection: Queryable = this.pool,
  ): Promise<CapacityConfiguration> {
    const row = (
      await connection.query<{ configuration: unknown }>(
        "SELECT rootset_control.capacity_configuration() AS configuration",
      )
    ).rows[0];
    return CapacityConfigurationSchema.parse(row?.configuration ?? {});
  }
  async configure(
    client: PoolClient,
    patch: Partial<CapacityConfiguration>,
  ): Promise<CapacityConfiguration> {
    const current = await this.configuration(client);
    const parsed = CapacityConfigurationSchema.parse({ ...current, ...patch });
    try {
      await client.query(
        "SELECT rootset_control.configure_capacity($1::jsonb)",
        [JSON.stringify(parsed)],
      );
    } catch (error) {
      capacityError(error);
    }
    return this.configuration(client);
  }
  async status(
    connection: Queryable = this.pool,
    orgId?: string,
  ): Promise<CapacityStatus> {
    const row = (
      await connection.query<{ status: CapacityStatus }>(
        "SELECT rootset_control.capacity_status($1::varchar) AS status",
        [orgId ? IdSchema.parse(orgId) : null],
      )
    ).rows[0];
    if (!row)
      throw new RootsetError(
        "DEPENDENCY_UNAVAILABLE",
        "Storage capacity status is unavailable",
        503,
      );
    return {
      ...row.status,
      disk: {
        ...row.status.disk,
        reportedAt: row.status.disk.reportedAt
          ? new Date(row.status.disk.reportedAt).toISOString()
          : null,
      },
    };
  }
  async begin(
    client: PoolClient,
    orgId: string,
    request: CapacityRequest,
  ): Promise<CapacityReservation> {
    if (
      request.reserveBytes < 0n ||
      request.reserveBytes > 9223372036854775807n ||
      !request.operation ||
      request.operation.length > 120
    )
      throw new RootsetError(
        "VALIDATION_FAILED",
        "A nonnegative bigint byte reservation and operation name are required",
      );
    try {
      const row = (
        await client.query<{ reservation: CapacityReservation }>(
          "SELECT rootset_control.begin_capacity_admission($1,$2::bigint,$3) AS reservation",
          [
            IdSchema.parse(orgId),
            request.reserveBytes.toString(),
            request.operation,
          ],
        )
      ).rows[0];
      if (!row)
        throw new RootsetError(
          "DEPENDENCY_UNAVAILABLE",
          "Storage admission is unavailable",
          503,
        );
      return row.reservation;
    } catch (error) {
      return capacityError(error);
    }
  }
  async finish(
    client: PoolClient,
    reservation: CapacityReservation,
  ): Promise<void> {
    if (!reservation.enabled) return;
    try {
      await client.query(
        "SELECT rootset_control.finish_capacity_admission($1,$2)",
        [reservation.orgId, reservation.transactionId],
      );
    } catch (error) {
      capacityError(error);
    }
  }
  async run<T>(
    client: PoolClient,
    orgId: string,
    request: CapacityRequest,
    work: () => Promise<T>,
  ): Promise<T> {
    const reservation = await this.begin(client, orgId, request);
    const result = await work();
    await this.finish(client, reservation);
    return result;
  }
  async withSessionAdmission<T>(
    client: PoolClient,
    orgId: string,
    request: CapacityRequest,
    work: (validate: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const originalOrg =
      (
        await client.query<{ org: string | null }>(
          "SELECT current_setting('rootset.org_id',true) AS org",
        )
      ).rows[0]?.org ?? "";
    let mode: "exclusive" | "shared" = "shared",
      held = false;
    try {
      await client.query("SELECT set_config('rootset.org_id',$1,false)", [
        IdSchema.parse(orgId),
      ]);
      const enabled = (
        await client.query<{ enabled: boolean }>(
          "SELECT rootset_control.capacity_admission_enabled($1) AS enabled",
          [orgId],
        )
      ).rows[0]!.enabled;
      mode = enabled ? "exclusive" : "shared";
      await acquireCapacitySessionLock(client, mode);
      held = true;
      const currentEnabled = (
        await client.query<{ enabled: boolean }>(
          "SELECT rootset_control.capacity_admission_enabled($1) AS enabled",
          [orgId],
        )
      ).rows[0]!.enabled;
      if (currentEnabled !== enabled)
        throw new RootsetError(
          "STORAGE_POLICY_CHANGED",
          "Storage capacity policy changed during admission; retry the unchanged request under the current limits",
          503,
        );
      await client.query("BEGIN");
      let reservation: CapacityReservation;
      try {
        await client.query("SELECT set_config('rootset.org_id',$1,true)", [
          IdSchema.parse(orgId),
        ]);
        reservation = await this.begin(client, orgId, request);
        await this.finish(client, reservation);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      const validate = async () => {
        if (!reservation.enabled) return;
        try {
          await client.query(
            "SELECT rootset_control.validate_capacity_allocation($1,$2::bigint,$3::bigint,$4::bigint)",
            [
              orgId,
              reservation.databaseBeforeBytes,
              reservation.organisationBeforeBytes,
              reservation.reserveBytes,
            ],
          );
        } catch (error) {
          capacityError(error);
        }
      };
      await client.query("SELECT set_config('rootset.org_id',$1,false)", [
        orgId,
      ]);
      const result = await work(validate);
      await validate();
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      if (held)
        await client.query(
          mode === "shared"
            ? "SELECT pg_advisory_unlock_shared(hashtextextended('rootset:storage-capacity',0))"
            : "SELECT pg_advisory_unlock(hashtextextended('rootset:storage-capacity',0))",
        );
      await client.query("SELECT set_config('rootset.org_id',$1,false)", [
        originalOrg,
      ]);
    }
  }
}
export interface CapacityStatus {
  installation: {
    usedBytes: string;
    quotaBytes: string | null;
    availableQuotaBytes: string | null;
    metric: "postgresql_database_bytes";
  };
  organisation: null | {
    orgId: string;
    nativeRelationBytes: string;
    retainedControlTupleBytes: string;
    usedBytes: string;
    quotaBytes: string | null;
    availableQuotaBytes: string | null;
    metric: "native_relation_and_retained_control_tuple_bytes";
  };
  disk: {
    minimumFreeBytes: string | null;
    reportedAvailableBytes: string | null;
    reportedTotalBytes: string | null;
    headroomClaimsBytes: string;
    effectiveAvailableBytes: string | null;
    reportedAt: string | null;
    reportMaxAgeSeconds: number;
    fresh: boolean;
    volumes: Array<{
      name: string;
      availableBytes: string;
      totalBytes: string;
    }>;
  };
  admission: {
    enabled: boolean;
    state: "available" | "quota_exceeded" | "disk_pressure" | "report_stale";
    reason: string | null;
  };
}
