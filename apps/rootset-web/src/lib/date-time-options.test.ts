import { describe, expect, it } from "vitest";
import {
  dateFormatOptions,
  timeFormatOptions,
  defaultDateTimePreferences,
} from "@rootset/contracts";
import {
  dateFormatOptions as sharedDates,
  timeFormatOptions as sharedTimes,
  defaultDateTimePreferences as sharedDefaults,
} from "@avgeek-oss/design-system/utilities/date-time-preferences";
import {
  dateFormats,
  timeFormats,
  setupPreferenceOptions,
} from "./date-time-options";

describe("published shared date and time preference catalog", () => {
  it("uses library options directly and keeps validated backend IDs and defaults aligned", () => {
    expect(dateFormats).toBe(sharedDates);
    expect(timeFormats).toBe(sharedTimes);
    expect(dateFormatOptions).toEqual(sharedDates);
    expect(timeFormatOptions).toEqual(sharedTimes);
    expect(defaultDateTimePreferences).toEqual(sharedDefaults);
    const setup = setupPreferenceOptions();
    expect(setup.dateFormats).toBe(sharedDates);
    expect(setup.timeFormats).toBe(sharedTimes);
    expect(setup.timeZones[0]).toBe("UTC");
    expect(setup.timeZones).toContain("Asia/Kolkata");
  });
});
