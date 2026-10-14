export interface RowResultCount {
  count: number;
  approximate: boolean;
}

export function rowResultCount(
  page: {
    start: number;
    length: number;
    hasMore: boolean;
    total?: number | null;
    estimate?: number | null;
  },
  previous: RowResultCount | null,
): RowResultCount | null {
  if (page.total != null) return { count: page.total, approximate: false };
  const end = page.start + page.length;
  if (!page.hasMore && (page.start === 0 || page.length > 0))
    return { count: end, approximate: false };
  const known =
    previous && !previous.approximate
      ? previous
      : page.estimate != null
        ? { count: page.estimate, approximate: true }
        : previous;
  if (!known) return null;
  const minimum = end + (page.hasMore ? 1 : 0);
  return minimum > known.count ? { count: minimum, approximate: true } : known;
}
