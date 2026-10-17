"use client";

import { useSearchParams } from "next/navigation";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@avgeek-oss/design-system/buttons/toggle-button";
import { Tooltip } from "@avgeek-oss/design-system/overlays/tooltip";
import { GridViewIcon, TableIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type ResourceView = "grid" | "table";

export function useResourceView() {
  const parameters = useSearchParams();
  const view: ResourceView =
    parameters.get("layout") === "table" ? "table" : "grid";
  function setView(next: ResourceView) {
    const url = new URL(window.location.href);
    if (next === "grid") url.searchParams.delete("layout");
    else url.searchParams.set("layout", next);
    if (url.href !== window.location.href)
      window.history.pushState(
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
  }
  return [view, setView] as const;
}

export function ResourceViewToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ResourceView;
  onChange(value: ResourceView): void;
}) {
  return (
    <ToggleButtonGroup
      aria-label={`${label} view`}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        if (keys.has("grid")) onChange("grid");
        else if (keys.has("table")) onChange("table");
      }}
      className="shrink-0"
    >
      <Tooltip>
        <ToggleButton
          id="grid"
          isIconOnly
          aria-label="Grid view"
          className="size-9 min-w-9"
        >
          <HugeiconsIcon
            icon={GridViewIcon}
            size={16}
            className="size-4"
            aria-hidden
          />
        </ToggleButton>
        <Tooltip.Content>Grid view</Tooltip.Content>
      </Tooltip>
      <Tooltip>
        <ToggleButton
          id="table"
          isIconOnly
          aria-label="Table view"
          className="size-9 min-w-9"
        >
          <HugeiconsIcon
            icon={TableIcon}
            size={16}
            className="size-4"
            aria-hidden
          />
        </ToggleButton>
        <Tooltip.Content>Table view</Tooltip.Content>
      </Tooltip>
    </ToggleButtonGroup>
  );
}
