import type { Row } from "@rootset/contracts";

export interface RowWindow {
  key: string;
  start: number;
  rows: Row[];
  nextCursor: string | null;
  bytes: number;
}

export class RowWindowCache {
  private windows = new Map<string, RowWindow>();
  private bytes = 0;
  constructor(
    readonly maxBytes = 32 * 1024 * 1024,
    readonly maxWindows = 5,
  ) {}
  get size() {
    return this.windows.size;
  }
  get byteSize() {
    return this.bytes;
  }
  get(key: string): RowWindow | undefined {
    const window = this.windows.get(key);
    if (window) {
      this.windows.delete(key);
      this.windows.set(key, window);
    }
    return window;
  }
  set(window: Omit<RowWindow, "bytes">): void {
    const old = this.windows.get(window.key);
    if (old) {
      this.bytes -= old.bytes;
      this.windows.delete(window.key);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(window.rows)).length;
    if (bytes > this.maxBytes) return;
    this.windows.set(window.key, { ...window, bytes });
    this.bytes += bytes;
    while (this.windows.size > this.maxWindows || this.bytes > this.maxBytes) {
      const oldest = this.windows.entries().next().value as
        [string, RowWindow] | undefined;
      if (!oldest) break;
      this.windows.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
  }
  clear() {
    this.windows.clear();
    this.bytes = 0;
  }
}

export function visibleRange(
  scroll: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan = 4,
) {
  const start = Math.max(0, Math.floor(scroll / rowHeight) - overscan);
  const end = Math.min(
    count,
    Math.ceil((scroll + viewport) / rowHeight) + overscan,
  );
  return { start, end };
}

export function visibleColumns(
  widths: number[],
  scrollLeft: number,
  viewportWidth: number,
  frozen = 0,
) {
  let left = 0;
  const visible: {
    index: number;
    left: number;
    width: number;
    frozen: boolean;
  }[] = [];
  widths.forEach((width, index) => {
    if (
      index < frozen ||
      (left + width >= scrollLeft - 100 &&
        left < scrollLeft + viewportWidth + 100)
    )
      visible.push({ index, left, width, frozen: index < frozen });
    left += width;
  });
  return visible;
}
