"use client";

import { useMemo, useState } from "react";
import { Description, FieldError, Label } from "@heroui/react";
import { Select, ListBox } from "@avgeek-oss/design-system/forms/select";
import {
  Autocomplete,
  SearchField,
} from "@avgeek-oss/design-system/pickers/autocomplete";
import { timeZoneOffset } from "@avgeek-oss/design-system/lib/time-zone-offset";
import { availableTimeZones, isTimeZone } from "@rootset/contracts";

export function TimeZoneSelect({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const zones = useMemo(
    () => [
      ...new Set([
        ...availableTimeZones(),
        ...(isTimeZone(value) ? [value] : []),
      ]),
    ],
    [value],
  );
  const [offsetInstant, setOffsetInstant] = useState(() => new Date());
  const offsets = useMemo(
    () =>
      new Map(zones.map((zone) => [zone, timeZoneOffset(zone, offsetInstant)])),
    [zones, offsetInstant],
  );
  return (
    <Select
      variant="secondary"
      className="settings-field"
      isRequired
      isInvalid={Boolean(error)}
      value={value}
      onOpenChange={(open) => {
        if (open) setOffsetInstant(new Date());
      }}
      onChange={(key) => {
        if (typeof key === "string" && zones.includes(key)) onChange(key);
      }}
    >
      <Label>Time zone</Label>
      <Select.Trigger>
        <Select.Value className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate">{value}</span>
            <span className="ml-auto shrink-0 tabular-nums text-muted">
              {offsets.get(value)}
            </span>
          </span>
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="flex w-(--trigger-width) min-w-[min(18rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden">
        <Autocomplete.Filter
          filter={(text, search) =>
            text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
          }
        >
          <SearchField
            aria-label="Search time zones"
            className="relative z-10 shrink-0 bg-overlay px-2 pt-2 pb-2"
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
          <ListBox className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {zones.map((zone) => (
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
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        <Description>The cron schedule uses this time zone.</Description>
      )}
    </Select>
  );
}
