import type { DateTimePreferenceOptions } from "@avgeek-oss/design-system/patterns/settings/date-time-preference-fields";

export const dateFormats = [
  { id: "YYYY-MM-DD", label: "2026-09-16" },
  { id: "DD/MM/YYYY", label: "16/09/2026" },
  { id: "MM/DD/YYYY", label: "09/16/2026" },
];
export const timeFormats = [
  { id: "24h", label: "14:30" },
  { id: "12h", label: "2:30 PM" },
];

export function setupPreferenceOptions(): DateTimePreferenceOptions {
  return {
    dateFormats,
    timeFormats,
    timeZones: ["UTC", ...Intl.supportedValuesOf("timeZone")],
  };
}
