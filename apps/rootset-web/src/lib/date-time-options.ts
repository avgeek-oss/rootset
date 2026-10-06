import {
  availableTimeZones,
  dateFormatOptions,
  timeFormatOptions,
} from "@rootset/contracts";
import type { DateTimePreferenceOptions } from "@avgeek-oss/design-system/patterns/settings/date-time-preference-fields";
export const dateFormats = dateFormatOptions.map((option) => ({ ...option }));
export const timeFormats = timeFormatOptions.map((option) => ({ ...option }));
export function setupPreferenceOptions(): DateTimePreferenceOptions {
  return { dateFormats, timeFormats, timeZones: availableTimeZones() };
}
