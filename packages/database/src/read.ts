import {
  Client,
  type Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

export class ReadCancelledError extends DOMException {
  constructor() {
    super("Client request ended before its table read completed", "AbortError");
  }
}
export class ReadCancellationFailure extends Error {
  constructor() {
    super("Native read cancellation could not be confirmed safely");
    this.name = "ReadCancellationFailure";
  }
}
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw new ReadCancelledError();
};

async function endJoined(client: Client): Promise<void> {
  const ignore = () => {};
  client.on("error", ignore);
  const timer = setTimeout(() => client.connection.stream.destroy(), 1000);
  try {
    await client.end();
  } finally {
    clearTimeout(timer);
    client.removeListener("error", ignore);
  }
}

async function cancelOwned(
  pool: Pool,
  target: { pid: number; backendStart: string },
): Promise<void> {
  const control = new Client({
    ...pool.options,
    connectionTimeoutMillis: 1000,
    query_timeout: 0,
    application_name: "rootset_read_cancel",
  });
  const ignoreControlError = () => {};
  control.on("error", ignoreControlError);
  const timer = setTimeout(() => control.connection.stream.destroy(), 2000);
  try {
    await control.connect();
    await control.query("SET statement_timeout='1s'");
    const result = await control.query<{ state: string; delivered: boolean }>(
      "SELECT state,CASE WHEN state='active' THEN pg_cancel_backend(pid) ELSE false END AS delivered FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND usename=current_user AND datname=current_database() AND backend_type='client backend'",
      [target.pid, target.backendStart],
    );
    const backend = result.rows[0];
    if (!backend || (backend.state === "active" && !backend.delivered))
      throw new ReadCancellationFailure();
  } catch {
    throw new ReadCancellationFailure();
  } finally {
    clearTimeout(timer);
    try {
      await endJoined(control);
    } catch {
      throw new ReadCancellationFailure();
    } finally {
      control.removeListener("error", ignoreControlError);
    }
  }
}

/** Only read operations opt in; checked-out transaction ownership survives every cancellation race. */
export async function withOrgRead<T>(
  pool: Pool,
  orgId: string,
  work: (client: PoolClient) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  check(signal);
  if (
    !Number.isFinite(pool.options.connectionTimeoutMillis) ||
    Number(pool.options.connectionTimeoutMillis) <= 0
  )
    throw new ReadCancellationFailure();
  // pg-pool has no public waiter-removal API. Join its bounded checkout and release a late lease without issuing SQL.
  const client = await pool.connect().catch((error) => {
    check(signal);
    throw error;
  });
  let discard = false,
    began = false;
  const targetError = () => {
    discard = true;
  };
  client.on("error", targetError);
  try {
    check(signal);
    if (client.pipeline) throw new ReadCancellationFailure();
    const backend = (
      await client.query<{ pid: number; backend_start: string }>(
        "SELECT pg_backend_pid() AS pid,backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()",
      )
    ).rows[0];
    if (
      !backend ||
      !Number.isSafeInteger(backend.pid) ||
      typeof backend.backend_start !== "string"
    )
      throw new ReadCancellationFailure();
    const target = { pid: backend.pid, backendStart: backend.backend_start };
    let active = false;
    const query = async <R extends QueryResultRow = QueryResultRow>(
      sql: string,
      values?: unknown[],
    ): Promise<QueryResult<R>> => {
      check(signal);
      if (active || typeof sql !== "string")
        throw new ReadCancellationFailure();
      active = true;
      let cancellation: Promise<void> | undefined;
      const abort = () => {
        discard = true;
        cancellation ??= cancelOwned(pool, target).catch((error) => {
          // If control fails, only this still-owned socket is closed. No lease can escape while either task runs.
          client.connection.stream.destroy();
          throw error;
        });
        void cancellation.catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        check(signal);
        const result = await client.query<R>(sql, values);
        check(signal);
        return result;
      } catch (error) {
        check(signal);
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        try {
          if (cancellation) await cancellation;
        } finally {
          active = false;
        }
      }
    };
    const owned = new Proxy(client, {
      get(c, member) {
        if (member === "query") return query;
        const value = Reflect.get(c, member, c);
        return typeof value === "function" ? value.bind(c) : value;
      },
    });
    await owned.query("BEGIN");
    began = true;
    await owned.query("SET LOCAL client_connection_check_interval='100ms'");
    await owned.query("SELECT set_config('rootset.org_id',$1,true)", [orgId]);
    const result = await work(owned);
    check(signal);
    await owned.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    discard ||= signal.aborted || error instanceof ReadCancellationFailure;
    if (began && !discard) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    throw error;
  } finally {
    // A cancelled lease never returns to the pool. Closing the joined session rolls back its transient state.
    discard ||= signal.aborted;
    try {
      if (discard) await endJoined(client);
    } finally {
      client.release(discard);
      client.removeListener("error", targetError);
    }
  }
}
