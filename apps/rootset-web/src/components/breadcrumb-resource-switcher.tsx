"use client";

import { DatabaseIcon, TableIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouter } from "next/navigation";
import { ListBox } from "@avgeek-oss/design-system/forms/select";
import { BreadcrumbSelect as Select } from "@avgeek-oss/design-system/navigation/breadcrumbs";
import {
  Autocomplete,
  SearchField,
} from "@avgeek-oss/design-system/pickers/autocomplete";
import { dataHref } from "./settings/navigation";

export function BreadcrumbResourceSwitcher({
  currentId,
  databaseId,
  label,
  kind,
  resources,
}: {
  currentId: string;
  databaseId?: string;
  label: string;
  kind: "database" | "table";
  resources: readonly {
    id: string;
    name: string;
    description?: string | null;
  }[];
}) {
  const router = useRouter();
  const plural = kind === "database" ? "databases" : "tables";
  const options = [...resources].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return (
    <Select.Root
      aria-label={`Switch ${kind}`}
      selectedKey={currentId}
      onSelectionChange={(key) => {
        const id = String(key ?? "");
        if (id !== currentId && options.some((option) => option.id === id))
          router.push(
            kind === "database" ? dataHref(id) : dataHref(databaseId, id),
          );
      }}
    >
      <Select.Trigger>
        <Select.Value className="min-w-0 truncate">{label}</Select.Value>
      </Select.Trigger>
      <Select.Popover className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden">
        <Autocomplete.Filter
          filter={(text, search) =>
            text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
          }
        >
          <SearchField
            aria-label={`Search ${plural}`}
            className="px-2 pt-2"
            variant="secondary"
          >
            <SearchField.Group className="rounded-md">
              <SearchField.SearchIcon />
              <SearchField.Input
                className="text-base sm:text-sm"
                placeholder={`Search ${plural}…`}
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
                autoFocus={
                  typeof window !== "undefined" &&
                  window.matchMedia("(pointer: fine)").matches
                }
              />
              <SearchField.ClearButton aria-label={`Clear ${plural} search`} />
            </SearchField.Group>
          </SearchField>
          <ListBox
            className="max-h-80 overflow-y-auto"
            renderEmptyState={() => (
              <p className="px-3 py-4 text-sm text-muted">
                No matching {plural}.
              </p>
            )}
          >
            {options.map((option) => (
              <ListBox.Item
                id={option.id}
                key={option.id}
                textValue={`${option.name} ${option.description ?? ""}`}
              >
                <HugeiconsIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted"
                  icon={kind === "database" ? DatabaseIcon : TableIcon}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.name}</span>
                  {option.description ? (
                    <span className="block truncate text-xs text-muted">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Autocomplete.Filter>
      </Select.Popover>
    </Select.Root>
  );
}
