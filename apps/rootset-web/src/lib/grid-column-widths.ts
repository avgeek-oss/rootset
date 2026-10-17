export function fillGridColumnWidths(
  widths: readonly number[],
  availableWidth: number,
): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  const extra = widths.length
    ? Math.max(0, availableWidth - total) / widths.length
    : 0;
  return widths.map((width) => width + extra);
}
