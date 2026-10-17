import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";

export function SpreadsheetLoading() {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted"
      role="status"
    >
      <Spinner size="sm" color="current" aria-hidden />
      Loading records…
    </div>
  );
}
