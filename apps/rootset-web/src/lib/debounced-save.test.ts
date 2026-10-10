import { afterEach, describe, expect, it, vi } from "vitest";
import { DebouncedSave } from "./debounced-save";

afterEach(() => vi.useRealTimers());

describe("column preference saves", () => {
  it("coalesces a drag burst into one save with the last width", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn<(width: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const saver = new DebouncedSave(save, vi.fn());
    for (let width = 180; width <= 500; width++) {
      saver.schedule(width);
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(save.mock.calls).toEqual([[500]]);
    expect(saver.hasPending).toBe(false);
  });

  it("keeps only the latest snapshot while a previous request is pending", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const save = vi.fn((value: Record<string, number>) =>
      value.name === 200
        ? new Promise<void>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(),
    );
    const saver = new DebouncedSave(save, vi.fn());
    saver.schedule({ name: 200 });
    await vi.advanceTimersByTimeAsync(350);
    saver.schedule({ name: 300, count: 200 });
    await vi.advanceTimersByTimeAsync(350);
    saver.schedule({ name: 400, count: 250 });
    await vi.advanceTimersByTimeAsync(350);
    expect(save).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(save.mock.calls).toEqual([
      [{ name: 200 }],
      [{ name: 400, count: 250 }],
    ]);
    expect(saver.hasPending).toBe(false);
  });

  it("flushes the last width on navigation without waiting for the delay", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn<(width: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const saver = new DebouncedSave(save, vi.fn());
    saver.schedule(250);
    await saver.flush();
    await vi.advanceTimersByTimeAsync(350);
    expect(save.mock.calls).toEqual([[250]]);
  });

  it("retains failed preferences for retry without an automatic retry loop", async () => {
    vi.useFakeTimers();
    const failure = new Error("Unavailable");
    const save = vi
      .fn<(width: number) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const saver = new DebouncedSave(save, onError);
    saver.schedule(250);
    await vi.advanceTimersByTimeAsync(350);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(saver.hasPending).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
    await saver.flush();
    expect(save.mock.calls).toEqual([[250], [250]]);
    expect(saver.hasPending).toBe(false);
  });

  it("waits for the next drag to settle if an earlier save finishes during it", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const save = vi
      .fn<(width: number) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const saver = new DebouncedSave(save, vi.fn());
    saver.schedule(200);
    await vi.advanceTimersByTimeAsync(350);
    saver.schedule(300);
    finish();
    await vi.advanceTimersByTimeAsync(349);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save.mock.calls).toEqual([[200], [300]]);
  });

  it("retries the newest width when an earlier request fails", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const save = vi
      .fn<(width: number) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    const saver = new DebouncedSave(save, vi.fn());
    saver.schedule(200);
    await vi.advanceTimersByTimeAsync(350);
    saver.schedule(300);
    await vi.advanceTimersByTimeAsync(350);
    reject(new Error("Unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    await saver.flush();
    expect(save.mock.calls).toEqual([[200], [300]]);
  });
});
