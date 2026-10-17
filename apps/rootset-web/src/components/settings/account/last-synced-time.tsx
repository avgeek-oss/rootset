"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { formatDistanceStrict } from "date-fns";
import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import {
  TableCellDescription,
  tableCellStackClassName,
} from "@avgeek-oss/design-system/data-display/table-cell-text";
import { displayTimestamp, useApiQuery } from "./adapter";
import { defaultDateTimePreferences } from "@rootset/contracts";
import type { Preferences } from "../types";

const listeners = new Set<() => void>();
let currentTime = Date.now();
const defaults: Preferences = {
  timezone: "UTC",
  locale: "en",
  dateFormat: defaultDateTimePreferences.dateFormat,
  timeFormat: defaultDateTimePreferences.timeFormat,
  theme: "system",
};
export function RelativeTimeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const interval = setInterval(updateClock, 30_000);
    document.addEventListener("visibilitychange", updateClock);
    updateClock();
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", updateClock);
    };
  }, []);
  return children;
}
export function RelativeTime({
  display = "stacked",
  label,
  value,
}: {
  display?: "stacked" | "relative";
  label: string;
  value?: string;
}) {
  const { data: preferences = defaults } =
    useApiQuery<Preferences>("/me/preferences");
  const now = useSyncExternalStore(
    subscribeToClock,
    () => currentTime,
    () => 0,
  );
  if (!value || !Number.isFinite(Date.parse(value)))
    return <span aria-label={`${label} unavailable`}>—</span>;
  const absolute = displayTimestamp(value, preferences);
  const relative = now
    ? formatDistanceStrict(new Date(value), new Date(now), { addSuffix: true })
    : null;
  if (display === "relative")
    return (
      <time className="whitespace-nowrap tabular-nums" dateTime={value}>
        {relative ? `${label} ${relative}` : "—"}
      </time>
    );
  return (
    <TooltipText
      as="time"
      tooltip={preferences.timezone}
      placement="left"
      aria-label={`${label}: ${absolute} ${preferences.timezone}${relative ? `, ${relative}` : ""}`}
      className={`${tableCellStackClassName} whitespace-nowrap tabular-nums`}
      dateTime={value}
    >
      <span aria-hidden={!relative}>{relative ?? "\u00a0"}</span>
      <TableCellDescription>{absolute}</TableCellDescription>
    </TooltipText>
  );
}
function subscribeToClock(listener: () => void) {
  listeners.add(listener);
  updateClock();
  return () => {
    listeners.delete(listener);
  };
}
function updateClock() {
  currentTime = Date.now();
  for (const notify of listeners) notify();
}
