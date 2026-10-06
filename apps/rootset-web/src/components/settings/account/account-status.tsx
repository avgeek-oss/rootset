import { StatusIndicator } from "@avgeek-oss/design-system";

type AccountStatus =
  | "healthy"
  | "disabled"
  | "current"
  | "active"
  | "pending"
  | "verified"
  | "unverified";

export function StatusBadge({
  status,
  label,
  tooltip,
}: {
  status: AccountStatus;
  label?: string;
  tooltip?: string;
}) {
  return (
    <StatusIndicator
      label={label ?? status.charAt(0).toUpperCase() + status.slice(1)}
      color={
        status === "healthy" ||
        status === "verified" ||
        status === "current" ||
        status === "active"
          ? "success"
          : status === "pending" || status === "unverified"
            ? "warning"
            : "default"
      }
      description={tooltip}
    />
  );
}
