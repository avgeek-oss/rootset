import { Temporal } from "@js-temporal/polyfill";
import { CronExpressionParser } from "cron-parser";
import {
  BackupTimingSchema,
  RootsetError,
  type BackupTiming,
} from "@rootset/contracts";

function expression(timing: BackupTiming, currentDate: Date) {
  const checked = BackupTimingSchema.safeParse({
    cron: timing.cron,
    timezone: timing.timezone,
  });
  if (!checked.success)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Use a five-field cron expression and a valid IANA timezone",
      400,
    );
  try {
    return CronExpressionParser.parse(checked.data.cron, {
      tz: checked.data.timezone,
      currentDate,
    });
  } catch {
    throw new RootsetError(
      "VALIDATION_FAILED",
      "The cron schedule is invalid",
      400,
    );
  }
}
function occurrence(date: Date, timezone: string): Date {
  const local = Temporal.Instant.fromEpochMilliseconds(
    date.getTime(),
  ).toZonedDateTimeISO(timezone);
  const first = Temporal.ZonedDateTime.from(
    {
      timeZone: timezone,
      year: local.year,
      month: local.month,
      day: local.day,
      hour: local.hour,
      minute: local.minute,
      second: local.second,
    },
    { disambiguation: "earlier" },
  );
  return new Date(first.epochMilliseconds);
}
export function nextBackupRuns(
  timing: BackupTiming,
  after = new Date(),
  count = 3,
): string[] {
  try {
    const cron = expression(timing, after);
    const runs: string[] = [];
    for (let iterations = 0; runs.length < count; iterations++) {
      if (iterations >= 10000)
        throw new Error("Cron iteration budget exhausted");
      const next = occurrence(cron.next().toDate(), timing.timezone);
      if (
        next.getTime() > after.getTime() &&
        next.toISOString() !== runs.at(-1)
      )
        runs.push(next.toISOString());
    }
    return runs;
  } catch (error) {
    if (error instanceof RootsetError) throw error;
    throw new RootsetError(
      "VALIDATION_FAILED",
      "The cron schedule has no upcoming occurrence",
      400,
    );
  }
}
export function latestBackupRun(timing: BackupTiming, now: Date): Date {
  const cron = expression(timing, new Date(now.getTime() + 1));
  let latest: Date | undefined;
  for (let iterations = 0; iterations < 10000; iterations++) {
    const raw = cron.prev().toDate();
    if (latest && raw.getTime() <= latest.getTime()) return latest;
    const candidate = occurrence(raw, timing.timezone);
    if (!latest || candidate.getTime() > latest.getTime()) latest = candidate;
    if (candidate.getTime() === raw.getTime()) return latest;
  }
  throw new RootsetError(
    "VALIDATION_FAILED",
    "The cron schedule exceeded its iteration budget",
    400,
  );
}
