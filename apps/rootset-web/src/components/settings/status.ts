import type { ChipProps } from "@avgeek-oss/design-system/data-display/chip";
import {
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  HelpCircleIcon,
  Loading03Icon,
  PauseCircleIcon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";

export function statusLabel(value: string): string {
  const label = value.replaceAll("_", " ").toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function statusIcon(value: string) {
  switch (value) {
    case "active":
    case "succeeded":
      return CheckmarkCircle02Icon;
    case "failed":
    case "disabled":
    case "cancelled":
      return CancelCircleIcon;
    case "queued":
      return Clock01Icon;
    case "verifying":
      return Shield01Icon;
    case "partially_completed":
      return PauseCircleIcon;
    case "building":
    case "running":
    case "snapshotting":
    case "uploading":
      return Loading03Icon;
    default:
      return HelpCircleIcon;
  }
}

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
