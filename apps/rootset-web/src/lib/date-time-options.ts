import { availableTimeZones } from "@rootset/contracts";
import {
  dateFormatOptions,
  timeFormatOptions,
} from "@avgeek-oss/design-system/utilities/date-time-preferences";
import type { DateTimePreferenceOptions } from "@avgeek-oss/design-system/patterns/settings/date-time-preference-fields";

export const dateFormats = dateFormatOptions;
export const timeFormats = timeFormatOptions;

export function setupPreferenceOptions(): DateTimePreferenceOptions {
  return {
    dateFormats,
    timeFormats,
    timeZones: availableTimeZones(),
  };
}
