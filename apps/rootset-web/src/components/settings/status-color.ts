import type { ChipProps } from "@avgeek-oss/design-system/data-display/chip";

export function statusColor(value: string): ChipProps["color"] {
  switch (value) {
    case "active":
    case "succeeded":
      return "success";
    case "failed":
    case "disabled":
      return "danger";
    case "running":
    case "verifying":
    case "partially_completed":
      return "warning";
    default:
      return "default";
  }
}
