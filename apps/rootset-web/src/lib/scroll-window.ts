import type { Row } from "@rootset/contracts";

export function mergeScrollWindow(
  current: Row[],
  start: number,
  incoming: Row[],
  incomingStart: number,
  direction: "next" | "previous",
) {
  const page =
    direction === "previous"
      ? incoming.slice(0, Math.max(0, start - incomingStart))
      : incoming;
  const combined =
    direction === "next" ? [...current, ...page] : [...page, ...current];
  let bytes = combined.reduce(
    (sum, row) => sum + new TextEncoder().encode(JSON.stringify(row)).length,
    0,
  );
  let trimmed = 0;
  while (
    combined.length > page.length &&
    (combined.length > 1000 || bytes > 32 * 1024 * 1024)
  ) {
    const removed = direction === "next" ? combined.shift()! : combined.pop()!;
    bytes -= new TextEncoder().encode(JSON.stringify(removed)).length;
    trimmed++;
  }
  return {
    rows: combined,
    start: direction === "next" ? start + trimmed : incomingStart,
    offset: direction === "next" ? (trimmed ? -trimmed : 0) : page.length,
    trimmed,
  };
}
