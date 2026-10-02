export class MutationAttempt {
  private digest: string | null = null;
  private key: string | null = null;
  forInput(input: unknown): string {
    const digest = JSON.stringify(input);
    if (digest !== this.digest || !this.key) {
      this.digest = digest;
      this.key = crypto.randomUUID();
    }
    return this.key;
  }
  clear() {
    this.digest = null;
    this.key = null;
  }
}
