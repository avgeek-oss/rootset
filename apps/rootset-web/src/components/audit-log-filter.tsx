"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListBox, Select } from "@avgeek-oss/design-system/forms/select";
import {
  Autocomplete,
  SearchField,
} from "@avgeek-oss/design-system/pickers/autocomplete";
import {
  activityEventDefinitions,
  type ActivityCategory,
  type ActivityFilterOptions,
  type ActivityIcon,
} from "@rootset/contracts";
import { client } from "@rootset/web-client";
import { AuditEventIcon } from "./audit-event-icon";
import { AuditLogError } from "./audit-log-error";
import { AuditActorIcon, isAutomationActor } from "./audit-actor-icon";

export interface AuditFilterValue {
  value: string;
  label: string;
  icon: ActivityIcon | "actor" | "resource" | "event";
  avatarUrl?: string | null;
  actorKind?: string | null;
  description?: string;
  databaseName?: string;
}

const labels = {
  events: { label: "Event", all: "All events", icon: "event" },
  actors: { label: "Actor", all: "All actors", icon: "actor" },
  resources: { label: "Resource", all: "All resources", icon: "resource" },
} as const;
const actorKinds: Record<string, string> = {
  session: "User",
  personal_key: "Personal API key",
  team_key: "Team API key",
  oauth: "Connected application",
};

export function AuditLogFilter({
  orgId,
  kind,
  value,
  onChange,
  categories,
}: {
  orgId: string;
  kind: "events" | "actors" | "resources";
  value: AuditFilterValue | null;
  onChange: (value: AuditFilterValue | null) => void;
  categories?: ActivityCategory[];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);
  const remote = kind !== "events";
  const query = useQuery({
    queryKey: ["activity-filter-options", orgId, kind, term],
    queryFn: ({ signal }) =>
      client.operation<ActivityFilterOptions>(
        "listActivityFilterOptions",
        { orgId, kind, q: term, limit: 50 },
        { signal },
      ),
    enabled: remote && open,
    retry: false,
    gcTime: 0,
  });
  const loading = remote && (query.isFetching || search.trim() !== term);
  const options: AuditFilterValue[] =
    kind === "events"
      ? activityEventDefinitions
          .filter((event) => !categories || categories.includes(event.category))
          .map((event) => ({
            value: event.name,
            label: event.label,
            icon: event.icon,
          }))
      : loading || query.isError
        ? []
        : (query.data?.data ?? []).map((option) => ({
            ...option,
            icon: option.kind === "actor" ? "actor" : option.kind,
            actorKind: option.kind === "actor" ? option.description : undefined,
            databaseName:
              option.kind === "table"
                ? (option.description ?? undefined)
                : undefined,
            description:
              option.kind === "table"
                ? `Table${option.description ? ` (${option.description})` : ""}`
                : option.kind === "database"
                  ? "Database"
                  : (actorKinds[option.description ?? ""] ?? undefined),
          }));
  const names = labels[kind];
  const selectedIcon =
    value?.icon === "actor" && isAutomationActor(value.actorKind)
      ? "automation"
      : (value?.icon ?? names.icon);
  function icon(option: AuditFilterValue) {
    return option.icon === "actor" ? (
      <AuditActorIcon
        kind={option.actorKind}
        name={option.label}
        avatarUrl={option.avatarUrl}
      />
    ) : (
      <AuditEventIcon icon={option.icon} />
    );
  }
  return (
    <Select
      variant="secondary"
      className="settings-field"
      aria-label={names.label}
      value={value?.value ?? "all"}
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
      onChange={(key) =>
        onChange(
          key === "all"
            ? null
            : (options.find((option) => option.value === key) ?? value),
        )
      }
    >
      <Select.Trigger>
        <Select.Value className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <AuditEventIcon icon={selectedIcon} />
            <span className="truncate">{value?.label ?? names.all}</span>
          </span>
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="flex w-(--trigger-width) min-w-[min(20rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden">
        <Autocomplete.Filter
          inputValue={search}
          onInputChange={setSearch}
          filter={(text, search) =>
            remote ||
            text === names.all ||
            text.toLowerCase().includes(search.trim().toLowerCase())
          }
        >
          <SearchField
            aria-label={`Search ${kind}`}
            variant="secondary"
            className="shrink-0 px-2 pt-2 pb-2"
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input
                className="text-base sm:text-sm"
                placeholder={`Search ${kind}…`}
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
                autoFocus={
                  typeof window !== "undefined" &&
                  window.matchMedia("(pointer: fine)").matches
                }
              />
              <SearchField.ClearButton
                aria-label={`Clear ${names.label.toLowerCase()} search`}
              />
            </SearchField.Group>
          </SearchField>
          <ListBox
            className="max-h-72 min-h-0 flex-1 overflow-y-auto overscroll-contain"
            renderEmptyState={() =>
              loading ? "Loading…" : `No matching ${kind}`
            }
          >
            <ListBox.Item id="all" textValue={names.all}>
              <AuditEventIcon icon={names.icon} />
              <span className="min-w-0 flex-1">{names.all}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
            {options.map((option) => (
              <ListBox.Item
                id={option.value}
                key={option.value}
                textValue={`${option.label} ${option.value}`}
                aria-label={
                  option.description
                    ? `${option.label}, ${option.description}`
                    : option.label
                }
              >
                {icon(option)}
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate">{option.label}</span>
                  {option.description && (
                    <span className="text-xs text-muted">
                      {option.databaseName ? (
                        <>
                          Table (
                          <em className="italic">{option.databaseName}</em>)
                        </>
                      ) : (
                        option.description
                      )}
                    </span>
                  )}
                </span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Autocomplete.Filter>
        {loading && (
          <p role="status" className="px-3 py-2 text-sm text-muted">
            Loading {kind}…
          </p>
        )}
        {query.isError && !query.isFetching && (
          <div className="min-w-0 px-3 py-2">
            <AuditLogError
              error={query.error}
              message={`${names.label} options could not be loaded.`}
              onRetry={() => void query.refetch()}
            />
          </div>
        )}
        {!loading && query.data?.hasMore && (
          <p role="status" className="px-3 py-2 text-sm text-muted">
            More matches available. Keep typing to narrow the results.
          </p>
        )}
      </Select.Popover>
    </Select>
  );
}
