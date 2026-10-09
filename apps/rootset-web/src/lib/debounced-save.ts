export class DebouncedSave<T> {
  private pending: T | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving = false;

  constructor(
    private save: (value: T) => Promise<void>,
    private onError: (error: unknown) => void,
    private delay = 350,
  ) {}

  get hasPending() {
    return this.saving || this.pending !== undefined;
  }

  schedule(value: T) {
    this.pending = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delay);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.saving) return;
    while (this.pending !== undefined) {
      const value = this.pending;
      this.pending = undefined;
      this.saving = true;
      try {
        await this.save(value);
      } catch (error) {
        this.pending ??= value;
        this.onError(error);
        return;
      } finally {
        this.saving = false;
      }
      if (this.timer !== undefined) return;
    }
  }
}
