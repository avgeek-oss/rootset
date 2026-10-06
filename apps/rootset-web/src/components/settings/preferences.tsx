"use client";

import { useMemo } from "react";
import { PreferencesSettings as LibraryPreferencesSettings } from "@avgeek-oss/design-system";
import type {
  DateTimePreferenceOptions,
  DateTimePreferences,
} from "@avgeek-oss/design-system/patterns/settings/date-time-preference-fields";
import {
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { PreferencesSchema, type Preferences } from "@rootset/contracts";
import { formatCellValue } from "../cells/drafts";
import { dateFormats, timeFormats } from "../../lib/date-time-options";
import { useResource, write } from "./api";
import type { SettingsPanelProps } from "./types";

const previewInstant = "2026-09-16T14:30:45.000Z";
type PreferenceOptions = {
  timezones: string[];
  dateFormats: Preferences["dateFormat"][];
  timeFormats: Preferences["timeFormat"][];
};

export function PreferencesSettings(props: SettingsPanelProps) {
  const resource = useResource<Preferences | null>("/me/preferences", null);
  const optionResource = useResource<PreferenceOptions | null>(
    "/preferences/options",
    null,
  );
  const options = useMemo<DateTimePreferenceOptions>(
    () => ({
      timeZones: optionResource.data?.timezones ?? [],
      dateFormats: dateFormats.filter((option) =>
        optionResource.data?.dateFormats.some((format) => format === option.id),
      ),
      timeFormats: timeFormats.filter((option) =>
        optionResource.data?.timeFormats.some((format) => format === option.id),
      ),
    }),
    [optionResource.data],
  );
  if (resource.error || optionResource.error)
    return (
      <QueryError
        message={(resource.error ?? optionResource.error)!.message}
        onRetry={() => {
          resource.reload();
          optionResource.reload();
        }}
      />
    );
  if (!resource.data || !optionResource.data) return <QueryLoading />;
  const preferences = resource.data;
  return (
    <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
      <LibraryPreferencesSettings
        key={JSON.stringify(preferences)}
        value={{
          timeZone: preferences.timezone,
          dateFormat: preferences.dateFormat,
          timeFormat: preferences.timeFormat,
        }}
        options={options}
        formatPreview={(value) => (
          <PreferencePreview value={value} locale={preferences.locale} />
        )}
        onSave={async (value) => {
          const updated = PreferencesSchema.parse({
            ...preferences,
            timezone: value.timeZone,
            dateFormat: value.dateFormat,
            timeFormat: value.timeFormat,
          });
          await write("/me/preferences", "PATCH", {
            timezone: updated.timezone,
            dateFormat: updated.dateFormat,
            timeFormat: updated.timeFormat,
          });
          resource.reload();
          window.dispatchEvent(new Event("rootset:account-refresh"));
          props.onChanged?.();
        }}
      />
    </div>
  );
}

function PreferencePreview({
  value,
  locale,
}: {
  value: DateTimePreferences;
  locale: string;
}) {
  return formatCellValue(
    { id: "preview", name: "Preview", type: "date-time" },
    previewInstant,
    {
      timeZone: value.timeZone,
      locale,
      dateFormat: PreferencesSchema.shape.dateFormat.parse(value.dateFormat),
      timeFormat: PreferencesSchema.shape.timeFormat.parse(value.timeFormat),
    },
  );
}
