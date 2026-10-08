import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availableTimeZones,
  createDateTimeFormatter,
  dateFormatOptions,
  defaultDateTimePreferences,
  formatDisplayTime,
  isTimeZone,
  timeFormatOptions,
} from "./date-time-preferences";
import { PreferencesSchema } from "./models";
import { DateSchema, DateTimeSchema } from "./values";

const stored = {
  timezone: "UTC",
  locale: "en",
  theme: "system",
  dateFormat: defaultDateTimePreferences.dateFormat,
  timeFormat: defaultDateTimePreferences.timeFormat,
};

test("display preferences offer all Towbar formats with canonical defaults", () => {
  assert.deepEqual(defaultDateTimePreferences, {
    dateFormat: "day-short-month-year",
    timeFormat: "24-hour",
    timeZone: "UTC",
  });
  for (const date of dateFormatOptions)
    for (const time of timeFormatOptions) {
      const formatter = createDateTimeFormatter({
        dateFormat: date.id,
        timeFormat: time.id,
        timeZone: "UTC",
      });
      assert.deepEqual(formatter("2026-09-16T14:30:45.123Z"), {
        date: date.label,
        time: time.label,
        dateTime: `${time.label}, ${date.label}`,
      });
      assert.deepEqual(formatter("2026-09-16"), {
        date: date.label,
        time: null,
        dateTime: null,
      });
      assert.ok(
        PreferencesSchema.safeParse({
          ...stored,
          dateFormat: date.id,
          timeFormat: time.id,
        }).success,
      );
    }
  assert.equal(
    formatDisplayTime("00:05:06.123", "12-hour-seconds"),
    "12:05:06 AM",
  );
  assert.equal(formatDisplayTime("12:05:06.123", "12-hour"), "12:05 PM");
});

test("display preferences reject obsolete aliases and unknown formats", () => {
  for (const dateFormat of [
    "YYYY-MM-DD",
    "DD/MM/YYYY",
    "MM/DD/YYYY",
    "constructor",
    "invalid",
  ])
    assert.equal(
      PreferencesSchema.safeParse({ ...stored, dateFormat }).success,
      false,
    );
  for (const timeFormat of ["24h", "12h", "constructor", "invalid"])
    assert.equal(
      PreferencesSchema.safeParse({ ...stored, timeFormat }).success,
      false,
    );
});

test("timezone and domain UTC validation stay strict while display converts", () => {
  const zones = availableTimeZones();
  assert.equal(zones[0], "UTC");
  assert.ok(zones.includes("Asia/Kolkata"));
  assert.equal(new Set(zones).size, zones.length);
  for (const zone of [
    "",
    "invalid/zone",
    "+05:30",
    "-05:00",
    "x".repeat(101),
  ]) {
    assert.equal(isTimeZone(zone), false);
    assert.equal(
      PreferencesSchema.safeParse({ ...stored, timezone: zone }).success,
      false,
    );
  }
  const formatter = createDateTimeFormatter({
    dateFormat: "year-month-day",
    timeFormat: "24-hour-seconds",
    timeZone: "America/New_York",
  });
  assert.equal(
    formatter("2026-03-08T06:59:59.123Z").dateTime,
    "01:59:59, 2026-03-08",
  );
  assert.equal(
    formatter("2026-03-08T07:00:00.123Z").dateTime,
    "03:00:00, 2026-03-08",
  );
  assert.equal(formatter("2026-09-16").date, "2026-09-16");
  assert.ok(DateSchema.safeParse("0001-01-01").success);
  assert.ok(DateTimeSchema.safeParse("2026-09-16T14:30:45.123Z").success);
  assert.equal(
    DateTimeSchema.safeParse("2026-09-16T14:30:45.123+05:30").success,
    false,
  );
  assert.equal(
    createDateTimeFormatter({
      dateFormat: "year-month-day",
      timeFormat: "24-hour-seconds",
      timeZone: "America/New_York",
    })("0001-01-01T00:00:00.000Z").dateTime,
    "19:03:58, 0001-12-31 BCE",
  );
});
