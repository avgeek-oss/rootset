// Adapted from Towbar's Apache-2.0 DateTimePreferenceFields. Rootset uses its own preference values.
"use client";

import { useMemo, useState } from "react";
import {
  Autocomplete,
  Label,
  ListBox,
  SearchField,
  Select,
} from "@heroui/react";
import type { Preferences } from "@rootset/contracts";
import { timeZoneOffset } from "../../lib/time-zone-offset";

export type DateTimePreferenceOptions = {
  dateFormats: Array<{ id: Preferences["dateFormat"]; label: string }>;
  timeFormats: Array<{ id: Preferences["timeFormat"]; label: string }>;
  timeZones: string[];
};

export function DateTimePreferenceFields({
  disabled,
  onChange,
  options,
  preferences,
  variant = "primary",
}: {
  disabled?: boolean;
  onChange: (preferences: Preferences) => void;
  options: DateTimePreferenceOptions;
  preferences: Preferences;
  variant?: "primary" | "secondary";
}) {
  const [offsetInstant, setOffsetInstant] = useState(() => new Date());
  const offsets = useMemo(
    () =>
      new Map(
        options.timeZones.map((zone) => [
          zone,
          timeZoneOffset(zone, offsetInstant),
        ]),
      ),
    [options.timeZones, offsetInstant],
  );
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          variant={variant}
          fullWidth
          isRequired
          isDisabled={disabled}
          value={preferences.dateFormat}
          onChange={(key) => {
            const option = options.dateFormats.find((item) => item.id === key);
            if (option) onChange({ ...preferences, dateFormat: option.id });
          }}
        >
          <Label isRequired>Date format</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {options.dateFormats.map((option) => (
                <ListBox.Item
                  id={option.id}
                  key={option.id}
                  textValue={option.label}
                >
                  {option.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <Select
          variant={variant}
          fullWidth
          isRequired
          isDisabled={disabled}
          value={preferences.timeFormat}
          onChange={(key) => {
            const option = options.timeFormats.find((item) => item.id === key);
            if (option) onChange({ ...preferences, timeFormat: option.id });
          }}
        >
          <Label isRequired>Time format</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {options.timeFormats.map((option) => (
                <ListBox.Item
                  id={option.id}
                  key={option.id}
                  textValue={option.label}
                >
                  {option.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      <Select
        variant={variant}
        fullWidth
        isRequired
        isDisabled={disabled}
        value={preferences.timezone}
        onOpenChange={(open) => {
          if (open) setOffsetInstant(new Date());
        }}
        onChange={(key) => {
          if (typeof key === "string" && options.timeZones.includes(key))
            onChange({ ...preferences, timezone: key });
        }}
      >
        <Label isRequired>Time zone</Label>
        <Select.Trigger>
          <Select.Value className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-3">
              <span className="truncate">{preferences.timezone}</span>
              <span className="ml-auto shrink-0 tabular-nums text-muted">
                {offsets.get(preferences.timezone)}
              </span>
            </span>
          </Select.Value>
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover className="w-(--trigger-width) min-w-[min(18rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden">
          <Autocomplete.Filter
            filter={(text, search) =>
              text
                .toLocaleLowerCase()
                .includes(search.trim().toLocaleLowerCase())
            }
          >
            <SearchField
              aria-label="Search time zones"
              className="px-2 pt-2"
              variant="secondary"
            >
              <SearchField.Group className="rounded-md">
                <SearchField.SearchIcon />
                <SearchField.Input
                  className="text-base sm:text-sm"
                  placeholder="Search time zones…"
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={
                    typeof window !== "undefined" &&
                    window.matchMedia("(pointer: fine)").matches
                  }
                />
                <SearchField.ClearButton aria-label="Clear time zone search" />
              </SearchField.Group>
            </SearchField>
            <ListBox>
              {options.timeZones.map((zone) => (
                <ListBox.Item id={zone} key={zone} textValue={zone}>
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="truncate">{zone}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-muted">
                      {offsets.get(zone)}
                    </span>
                  </span>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Autocomplete.Filter>
        </Select.Popover>
      </Select>
    </>
  );
}
