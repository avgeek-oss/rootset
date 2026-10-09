import {
  canonicalJson,
  formatDisplayDate,
  formatDisplayTime,
  defaultDateTimePreferences,
  limits,
  parseStrictJson,
  validateCell,
  type FieldDefinition,
  type JsonValue,
  type Preferences,
} from "@rootset/contracts";
import {
  formatUtcDateTime,
  localDateTimeToUtc,
  timeInputToUtc,
  utcDateTimeToLocal,
  utcTimeToInput,
} from "./temporal";

export interface CellDraft {
  text: string;
  isNull: boolean;
  selectedInstant?: string;
  originalTemporalValue?: string;
}

export function formatJsonDraft(text: string): string {
  return JSON.stringify(
    parseStrictJson(text, { maxBytes: limits.requestBytes }),
    null,
    2,
  );
}

const numberFormatters = new Map<string, Intl.NumberFormat>();

export type DisplayPreferences = Pick<Preferences, "dateFormat" | "timeFormat">;
export interface CellDisplayOptions {
  timeZone?: string;
  locale?: string;
  dateFormat?: Preferences["dateFormat"];
  timeFormat?: Preferences["timeFormat"];
}

function numberFormatter(locale: string, integer: boolean): Intl.NumberFormat {
  const key = `${locale}\0${integer}`;
  const cached = numberFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(
    locale,
    integer ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 17 },
  );
  if (numberFormatters.size >= 16)
    numberFormatters.delete(numberFormatters.keys().next().value!);
  numberFormatters.set(key, formatter);
  return formatter;
}

export function createCellDraft(
  field: FieldDefinition,
  value: JsonValue,
  timeZone = "UTC",
): CellDraft {
  if (value === null)
    return {
      text: field.type === "boolean" ? "false" : "",
      isNull: !field.required,
    };
  switch (field.type) {
    case "json":
      return { text: formatJsonDraft(canonicalJson(value)), isNull: false };
    case "date-time":
      return {
        text: utcDateTimeToLocal(String(value), timeZone).slice(0, -7),
        isNull: false,
        selectedInstant: String(value),
        originalTemporalValue: String(value),
      };
    case "time":
      return {
        text: utcTimeToInput(String(value)).slice(0, 5),
        isNull: false,
        originalTemporalValue: String(value),
      };
    default:
      return { text: String(value), isNull: false };
  }
}

export function parseCellDraft(
  field: FieldDefinition,
  draft: CellDraft,
  timeZone = "UTC",
): JsonValue {
  if (draft.isNull) return validateCell(field, null);
  if (
    draft.originalTemporalValue &&
    (field.type === "time" || field.type === "date-time")
  ) {
    const original = createCellDraft(
      field,
      draft.originalTemporalValue,
      timeZone,
    );
    if (
      draft.text === original.text &&
      draft.selectedInstant === original.selectedInstant
    )
      return validateCell(field, draft.originalTemporalValue);
  }
  let value: JsonValue;
  switch (field.type) {
    case "text":
    case "uri":
    case "url":
    case "image":
      value = draft.text;
      break;
    case "integer": {
      const input = draft.text.trim();
      if (!/^-?\d+$/.test(input)) throw new Error("Enter a whole number.");
      value = Number(input);
      break;
    }
    case "float": {
      const input = draft.text.trim();
      if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(input))
        throw new Error("Enter a finite number.");
      value = Number(input);
      break;
    }
    case "boolean": {
      if (draft.text !== "true" && draft.text !== "false")
        throw new Error("Choose true or false.");
      value = draft.text === "true";
      break;
    }
    case "date":
      value = draft.text;
      break;
    case "time":
      if (!/^\d{2}:\d{2}$/.test(draft.text))
        throw new Error("Enter a time in hours and minutes.");
      value = timeInputToUtc(draft.text);
      break;
    case "date-time":
      if (!/^\d{4,5}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.text))
        throw new Error("Enter a local date and time in hours and minutes.");
      value = localDateTimeToUtc(draft.text, timeZone, draft.selectedInstant);
      break;
    case "json":
      value = parseStrictJson(draft.text, { maxBytes: limits.requestBytes });
      break;
  }
  return validateCell(field, value);
}

export function validateCellDraft(
  field: FieldDefinition,
  draft: CellDraft,
  timeZone = "UTC",
): string | null {
  try {
    parseCellDraft(field, draft, timeZone);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "This value is invalid.";
  }
}

/** A visible preview does bounded work; it does not stringify an entire JSON value. */
export function jsonCellPreview(value: JsonValue, maximum = 160): string {
  const cap = Math.max(8, Math.floor(maximum));
  let remaining = cap;
  function append(text: string): string {
    if (!remaining) return "";
    const output =
      text.length > remaining
        ? `${text.slice(0, Math.max(0, remaining - 1))}…`
        : text;
    remaining -= output.length;
    return output;
  }
  function visit(input: JsonValue, depth: number): string {
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "number"
    )
      return append(String(input));
    if (typeof input === "string") {
      const bounded =
        input.length > remaining ? `${input.slice(0, remaining)}…` : input;
      return append(JSON.stringify(bounded));
    }
    if (depth > 1) return append(Array.isArray(input) ? "[…]" : "{…}");
    if (Array.isArray(input)) {
      let result = append("[");
      for (let i = 0; i < Math.min(input.length, 4) && remaining > 2; i++) {
        if (i) result += append(", ");
        result += visit(input[i]!, depth + 1);
      }
      if (input.length > 4) result += append(", …");
      return result + append("]");
    }
    let result = append("{");
    let count = 0;
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      if (count++ === 4 || remaining < 8) {
        result += append(", …");
        break;
      }
      if (count > 1) result += append(", ");
      result += append(`${JSON.stringify(key.slice(0, 40))}: `);
      result += visit(input[key]!, depth + 1);
    }
    return result + append("}");
  }
  return visit(value, 0);
}

export function formatCellValue(
  field: FieldDefinition,
  value: JsonValue,
  options?: CellDisplayOptions,
): string;
export function formatCellValue(
  field: FieldDefinition,
  value: JsonValue,
  timeZone?: string,
  locale?: string,
  preferences?: DisplayPreferences,
): string;
export function formatCellValue(
  field: FieldDefinition,
  value: JsonValue,
  timeZoneOrOptions: string | CellDisplayOptions = "UTC",
  localeArgument = "en-GB",
  preferenceArgument?: DisplayPreferences,
): string {
  const options =
    typeof timeZoneOrOptions === "string"
      ? { timeZone: timeZoneOrOptions, locale: localeArgument }
      : timeZoneOrOptions;
  const timeZone = options.timeZone ?? "UTC";
  const locale = options.locale ?? "en-GB";
  const preferences =
    preferenceArgument ??
    (options.dateFormat || options.timeFormat
      ? {
          dateFormat:
            options.dateFormat ?? defaultDateTimePreferences.dateFormat,
          timeFormat:
            options.timeFormat ?? defaultDateTimePreferences.timeFormat,
        }
      : undefined);
  if (value === null) return "—";
  switch (field.type) {
    case "date-time": {
      if (!preferences)
        return formatUtcDateTime(String(value), timeZone, locale);
      const [date, clock] = utcDateTimeToLocal(String(value), timeZone).split(
        "T",
      );
      return `${formatDisplayTime(clock!, preferences.timeFormat.startsWith("12") ? "12-hour" : "24-hour")}, ${formatDisplayDate(date!, preferences.dateFormat)}`;
    }
    case "time":
      return `${preferences ? formatDisplayTime(utcTimeToInput(String(value)), preferences.timeFormat.startsWith("12") ? "12-hour" : "24-hour") : utcTimeToInput(String(value)).slice(0, 5)} UTC`;
    case "date":
      return preferences
        ? formatDisplayDate(String(value), preferences.dateFormat)
        : String(value);
    case "integer":
      return numberFormatter(locale, true).format(Number(value));
    case "float":
      return numberFormatter(locale, false).format(Number(value));
    case "boolean":
      return value ? "true" : "false";
    case "json":
      return jsonCellPreview(value);
    case "text":
    case "uri":
    case "url":
    case "image":
      return String(value).length > 512
        ? `${String(value).slice(0, 511)}…`
        : String(value);
  }
}
