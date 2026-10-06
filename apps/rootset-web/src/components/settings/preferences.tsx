// Adapted from Towbar's Apache-2.0 DateTimePreferencesSettings, using Rootset's API and grid formatter.
"use client";

import { FieldDescription } from "../ui/towbar/design-system/forms/field";
import { FormCard } from "./account/page-parts";
import { toast } from "../ui/towbar/design-system/overlays/toast";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Preferences } from "@rootset/contracts";
import { formatCellValue } from "../cells/drafts";
import { Button } from "../ui/button";
import { useMutation, useResource, write } from "./api";
import {
  DateTimePreferenceFields,
  type DateTimePreferenceOptions,
} from "./date-time-preference-fields";
import type { SettingsPanelProps } from "./types";
import { QueryError, QueryLoading } from "../ui/towbar/web-ui/query-state";

const previewInstant = "2026-09-16T14:30:45.000Z";
const dateFormats: DateTimePreferenceOptions["dateFormats"] = [
  { id: "YYYY-MM-DD", label: "2026-09-16" },
  { id: "DD/MM/YYYY", label: "16/09/2026" },
  { id: "MM/DD/YYYY", label: "09/16/2026" },
];
const timeFormats: DateTimePreferenceOptions["timeFormats"] = [
  { id: "24h", label: "14:30" },
  { id: "12h", label: "2:30 PM" },
];
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
  const mutation = useMutation(() => {
    resource.reload();
    props.onChanged?.();
  });
  const [preferences, setPreferences] = useState<Preferences>({
    timezone: "UTC",
    locale: "en",
    dateFormat: "YYYY-MM-DD",
    timeFormat: "24h",
    theme: "system",
  });
  useEffect(() => {
    if (resource.data) setPreferences(resource.data);
  }, [resource.data]);
  const theme = props.theme;
  useEffect(() => {
    if (theme) setPreferences((previous) => ({ ...previous, theme }));
  }, [resource.data, theme]);
  const options = useMemo<DateTimePreferenceOptions>(() => {
    const current = optionResource.data;
    const timeZones = [
      ...new Set([
        "UTC",
        ...(current?.timezones ?? []),
        preferences.timezone,
        "Asia/Kolkata",
        "Asia/Kathmandu",
        "Asia/Yangon",
        "Europe/Kyiv",
        "America/Nuuk",
        "Pacific/Kanton",
      ]),
    ]
      .filter((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      })
      .sort((left, right) =>
        left === "UTC" ? -1 : right === "UTC" ? 1 : left.localeCompare(right),
      );
    return {
      timeZones,
      dateFormats: dateFormats.filter((option) =>
        current?.dateFormats.includes(option.id),
      ),
      timeFormats: timeFormats.filter((option) =>
        current?.timeFormats.includes(option.id),
      ),
    };
  }, [optionResource.data, preferences.timezone]);
  const dirty = Boolean(
    resource.data &&
    (preferences.timezone !== resource.data.timezone ||
      preferences.dateFormat !== resource.data.dateFormat ||
      preferences.timeFormat !== resource.data.timeFormat),
  );
  const preview = formatCellValue(
    { id: "preview", name: "Preview", type: "date-time" },
    previewInstant,
    {
      timeZone: preferences.timezone,
      locale: preferences.locale,
      dateFormat: preferences.dateFormat,
      timeFormat: preferences.timeFormat,
    },
  );
  const zoneLabel = new Intl.DateTimeFormat(preferences.locale, {
    timeZone: preferences.timezone,
    timeZoneName: "short",
  })
    .formatToParts(new Date(previewInstant))
    .find((part) => part.type === "timeZoneName")?.value;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || mutation.busy) return;
    const result = await mutation.run(
      () =>
        write("/me/preferences", "PATCH", {
          timezone: preferences.timezone,
          dateFormat: preferences.dateFormat,
          timeFormat: preferences.timeFormat,
        }),
      "Preferences updated",
    );
    if (result.ok) toast.success("Preferences updated");
  }

  return (
    <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
      {resource.error || optionResource.error ? (
        <QueryError
          message={(resource.error ?? optionResource.error)!.message}
        />
      ) : !resource.data || !optionResource.data ? (
        <QueryLoading />
      ) : null}
      {resource.data && optionResource.data && (
        <FormCard title="Date and time">
          <form
            className="grid gap-5"
            onSubmit={save}
            aria-busy={mutation.busy}
          >
            <DateTimePreferenceFields
              disabled={mutation.busy}
              onChange={setPreferences}
              options={options}
              preferences={preferences}
              variant="secondary"
            />
            <div className="grid gap-3">
              <div className="grid content-start gap-0" aria-live="polite">
                <span className="text-xs text-muted">Preview</span>
                <span className="text-sm tabular-nums">{preview}</span>
                <span className="text-xs text-muted">
                  {preferences.timezone}
                  {zoneLabel && preferences.timezone !== zoneLabel
                    ? ` (${zoneLabel})`
                    : ""}
                </span>
              </div>
              <FieldDescription>
                Applies to how dates and times are displayed throughout Rootset.
              </FieldDescription>
              {mutation.error ? (
                <p role="alert" className="text-sm text-danger">
                  {mutation.error.message}
                </p>
              ) : null}
              <Button
                className="w-fit min-w-24"
                type="submit"
                isDisabled={!dirty || mutation.busy}
                isPending={mutation.busy}
              >
                Save
              </Button>
            </div>
          </form>
        </FormCard>
      )}
    </div>
  );
}
