import { parseUtcDateTime, parseUtcTime, validDate } from "@rootset/contracts";

export interface LocalDateTimeCandidate {
  instant: string;
  offsetSeconds: number;
  label: string;
}

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");
const localPattern =
  /^(\d{4,5}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
const displayFormatters = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  key: string,
  create: () => Intl.DateTimeFormat,
): Intl.DateTimeFormat {
  const cached = cache.get(key);
  if (cached) return cached;
  const formatter = create();
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, formatter);
  return formatter;
}

function calendarEpoch(parts: CalendarParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}

function parseLocal(value: string): CalendarParts {
  const match = localPattern.exec(value);
  const localYear = Number(match?.[1]?.split("-")[0]);
  const dateForValidation =
    localYear === 0 || localYear === 10000
      ? match?.[1]?.replace(/^\d+/, "0400")
      : match?.[1];
  if (
    !match ||
    localYear < 0 ||
    localYear > 10000 ||
    !dateForValidation ||
    !validDate(dateForValidation) ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4] ?? 0) > 59
  ) {
    throw new Error(
      "Enter a valid local date and time, with up to three fractional digits.",
    );
  }
  const [year, month, day] = match[1]!.split("-").map(Number);
  return {
    year: year!,
    month: month!,
    day: day!,
    hour: Number(match[2]),
    minute: Number(match[3]),
    second: Number(match[4] ?? 0),
    millisecond: Number((match[5] ?? "").padEnd(3, "0")),
  };
}

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  return cachedFormatter(
    zoneFormatters,
    timeZone,
    () =>
      new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        era: "short",
      }),
  );
}

function zonedParts(
  epoch: number,
  formatter: Intl.DateTimeFormat,
): CalendarParts {
  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(epoch))
    values[part.type] = part.value;
  const year = Number(values.year);
  return {
    year: values.era === "BC" ? 1 - year : year,
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: ((epoch % 1000) + 1000) % 1000,
  };
}

function localString(parts: CalendarParts): string {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(parts.millisecond, 3)}`;
}

function offsetLabel(seconds: number): string {
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor((absolute % 3600) / 60);
  const remainder = absolute % 60;
  return `UTC${seconds < 0 ? "-" : "+"}${pad(hours)}:${pad(minutes)}${remainder ? `:${pad(remainder)}` : ""}`;
}

/** Date-time inputs are calendar values; they must never be parsed in the browser's timezone. */
export function getLocalDateTimeCandidates(
  value: string,
  timeZone: string,
): LocalDateTimeCandidate[] {
  const local = parseLocal(value);
  const formatter = zoneFormatter(timeZone);
  const localEpoch = calendarEpoch(local);
  const offsets = new Set<number>();
  // Sample both sides of the requested date, including full-day political offset changes.
  for (let hours = -72; hours <= 72; hours += 6) {
    const epoch = localEpoch + hours * 3_600_000;
    offsets.add((calendarEpoch(zonedParts(epoch, formatter)) - epoch) / 1000);
  }
  const candidates: LocalDateTimeCandidate[] = [];
  for (const offsetSeconds of offsets) {
    const epoch = localEpoch - offsetSeconds * 1000;
    if (calendarEpoch(zonedParts(epoch, formatter)) !== localEpoch) continue;
    const instant = new Date(epoch).toISOString();
    try {
      parseUtcDateTime(instant);
    } catch {
      continue;
    }
    candidates.push({
      instant,
      offsetSeconds,
      label: `${offsetLabel(offsetSeconds)} · ${instant}`,
    });
  }
  return candidates.sort((left, right) =>
    left.instant.localeCompare(right.instant),
  );
}

export function localDateTimeToUtc(
  value: string,
  timeZone: string,
  selectedInstant?: string,
): string {
  const candidates = getLocalDateTimeCandidates(value, timeZone);
  if (!candidates.length)
    throw new Error(
      `This local time does not exist in ${timeZone}, or maps outside UTC years 0001–9999. Choose a supported local time.`,
    );
  if (candidates.length === 1) return candidates[0]!.instant;
  const selected = candidates.find(
    (candidate) => candidate.instant === selectedInstant,
  );
  if (!selected)
    throw new Error(
      "This local time occurs twice. Choose the intended UTC offset before saving.",
    );
  return selected.instant;
}

export function utcDateTimeToLocal(value: string, timeZone: string): string {
  const canonical = parseUtcDateTime(value);
  const parts = zonedParts(Date.parse(canonical), zoneFormatter(timeZone));
  return localString(parts);
}

/** UTC time-only cells have no date and therefore no DST/timezone conversion. */
export function utcTimeToInput(value: string): string {
  return parseUtcTime(value).slice(0, -1);
}

export function timeInputToUtc(value: string): string {
  const expanded = /^\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
  return parseUtcTime(`${expanded}Z`);
}

export function formatUtcDateTime(
  value: string,
  timeZone = "UTC",
  locale = "en-GB",
): string {
  const canonical = parseUtcDateTime(value);
  const beforeCommonEra =
    zonedParts(Date.parse(canonical), zoneFormatter(timeZone)).year < 1;
  return cachedFormatter(
    displayFormatters,
    `${locale}\0${timeZone}\0${beforeCommonEra}`,
    () =>
      new Intl.DateTimeFormat(
        locale,
        beforeCommonEra
          ? {
              timeZone,
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
              era: "short",
            }
          : {
              timeZone,
              dateStyle: "medium",
              timeStyle: "medium",
            },
      ),
  ).format(Date.parse(canonical));
}
