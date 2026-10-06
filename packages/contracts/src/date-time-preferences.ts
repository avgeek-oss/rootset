export const dateFormatOptions = [
  { id: "day-short-month-year", label: "16 Sept 2026" },
  { id: "short-month-day-year", label: "Sept 16, 2026" },
  { id: "year-month-day", label: "2026-09-16" },
  { id: "day-month-year", label: "16/09/2026" },
  { id: "month-day-year", label: "09/16/2026" },
] as const;
export const timeFormatOptions = [
  { id: "24-hour", label: "14:30" },
  { id: "12-hour", label: "2:30 PM" },
  { id: "24-hour-seconds", label: "14:30:45" },
  { id: "12-hour-seconds", label: "2:30:45 PM" },
] as const;
export const defaultDateTimePreferences = {
  dateFormat: "day-short-month-year",
  timeFormat: "24-hour",
  timeZone: "UTC",
} as const;
export type DateFormat = (typeof dateFormatOptions)[number]["id"];
export type TimeFormat = (typeof timeFormatOptions)[number]["id"];
export const legacyDateFormatAliases = {
  "YYYY-MM-DD": "year-month-day",
  "DD/MM/YYYY": "day-month-year",
  "MM/DD/YYYY": "month-day-year",
} as const;
export const legacyTimeFormatAliases = {
  "24h": "24-hour",
  "12h": "12-hour",
} as const;

export function normalizePreferenceAliases(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const dates: Record<string, string> = legacyDateFormatAliases;
  const times: Record<string, string> = legacyTimeFormatAliases;
  return {
    ...input,
    ...(typeof input.dateFormat === "string"
      ? {
          dateFormat: Object.hasOwn(dates, input.dateFormat)
            ? dates[input.dateFormat]
            : input.dateFormat,
        }
      : {}),
    ...(typeof input.timeFormat === "string"
      ? {
          timeFormat: Object.hasOwn(times, input.timeFormat)
            ? times[input.timeFormat]
            : input.timeFormat,
        }
      : {}),
  };
}

export function isTimeZone(value: string) {
  if (!value || value.length > 100 || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function availableTimeZones() {
  return [
    ...new Set(
      [
        "UTC",
        ...Intl.supportedValuesOf("timeZone"),
        "Asia/Kolkata",
        "Asia/Kathmandu",
        "Asia/Yangon",
        "Europe/Kyiv",
        "America/Nuuk",
        "Pacific/Kanton",
      ].filter(isTimeZone),
    ),
  ].sort((left, right) =>
    left === "UTC" ? -1 : right === "UTC" ? 1 : left.localeCompare(right),
  );
}

const calendarMonth = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  month: "short",
});
export function formatDisplayDate(value: string, format: DateFormat): string {
  const [rawYear, month, day] = value.split("-");
  const year = rawYear === "0000" ? "0001" : rawYear;
  const shortMonth = calendarMonth.format(
    new Date(`2000-${month}-${day}T00:00:00.000Z`),
  );
  const dates: Record<DateFormat, string> = {
    "day-short-month-year": `${Number(day)} ${shortMonth} ${year}`,
    "short-month-day-year": `${shortMonth} ${Number(day)}, ${year}`,
    "year-month-day": `${year}-${month}-${day}`,
    "day-month-year": `${day}/${month}/${year}`,
    "month-day-year": `${month}/${day}/${year}`,
  };
  return `${dates[format]}${rawYear === "0000" ? " BCE" : ""}`;
}
export function formatDisplayTime(value: string, format: TimeFormat): string {
  const [hourText, minute, second] = value.split(".")[0]!.split(":");
  const hour = Number(hourText);
  const twelveHour = format.startsWith("12");
  const seconds = format.endsWith("seconds") ? `:${second}` : "";
  return `${twelveHour ? hour % 12 || 12 : hourText}:${minute}${seconds}${twelveHour ? (hour < 12 ? " AM" : " PM") : ""}`;
}

export function createDateTimeFormatter(preferences: {
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  timeZone: string;
}) {
  const numeric = new Intl.DateTimeFormat("en-GB", {
    timeZone: preferences.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    era: "short",
  });
  return (value: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value))
      return {
        date: formatDisplayDate(value, preferences.dateFormat),
        time: null,
        dateTime: null,
      };
    const parts = Object.fromEntries(
      numeric
        .formatToParts(new Date(value))
        .map((part) => [part.type, part.value]),
    );
    const year = parts.era === "BC" ? "0000" : parts.year!.padStart(4, "0");
    const date = formatDisplayDate(
      `${year}-${parts.month}-${parts.day}`,
      preferences.dateFormat,
    );
    const time = formatDisplayTime(
      `${parts.hour}:${parts.minute}:${parts.second}`,
      preferences.timeFormat,
    );
    return { date, time, dateTime: `${time}, ${date}` };
  };
}
