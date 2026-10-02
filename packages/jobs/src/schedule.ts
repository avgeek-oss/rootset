import { CronExpressionParser } from "cron-parser";
import { RootsetError } from "@rootset/contracts";

const formatters = new Map<string, Intl.DateTimeFormat>();
function localMinute(date: Date, timezone: string): string {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  return formatter.format(date);
}

export function validateSchedule(cron: string, timezone: string): void {
  if (cron.trim().split(/\s+/).length !== 5)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "A backup schedule requires exactly five cron fields",
    );
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    CronExpressionParser.parse(cron, {
      tz: timezone,
      currentDate: new Date(),
    }).next();
  } catch {
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Cron expression or IANA schedule timezone is invalid",
    );
  }
}

export function previewSchedule(
  cron: string,
  timezone: string,
  from = new Date(),
  count = 5,
): string[] {
  validateSchedule(cron, timezone);
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 20 ||
    !Number.isFinite(from.getTime())
  )
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Preview requires a valid UTC start and 1-20 occurrences",
    );
  const parser = CronExpressionParser.parse(cron, {
    tz: timezone,
    currentDate: from,
    endDate: new Date(from.getTime() + 100 * 366 * 86400_000),
  });
  const result: string[] = [];
  while (result.length < count) {
    let candidate: Date;
    try {
      candidate = parser.next().toDate();
    } catch {
      break;
    }
    const local = localMinute(candidate, timezone);
    // cron-parser adjusts nonexistent wall times; require the requested local fields
    // to match again, which skips spring-forward shifts instead of delaying them.
    const localParts = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(candidate);
    const part = (name: string) =>
      localParts.find((value) => value.type === name)?.value ?? "";
    const localDate = new Date(
      `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:00Z`,
    );
    const wallParser = CronExpressionParser.parse(cron, {
      tz: "UTC",
      currentDate: new Date(localDate.getTime() - 60_000),
      endDate: localDate,
    });
    try {
      if (wallParser.next().toDate().getTime() !== localDate.getTime())
        continue;
    } catch {
      continue;
    }
    let repeated = false;
    // Timezone transitions can move the clock by 30 minutes, one hour or two
    // hours. Compare earlier occurrences including historical date-line shifts.
    for (let minutes = 1; minutes <= 26 * 60; minutes++) {
      if (
        localMinute(
          new Date(candidate.getTime() - minutes * 60_000),
          timezone,
        ) === local
      ) {
        repeated = true;
        break;
      }
    }
    if (!repeated) result.push(candidate.toISOString());
  }
  return result;
}
