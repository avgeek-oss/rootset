import { APIError } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";

export class PasswordVerificationGate {
  #active = 0;
  #waiting: Array<() => void> = [];
  constructor(
    private readonly maximumActive: number,
    private readonly maximumWaiting: number,
  ) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active < this.maximumActive) this.#active++;
    else {
      if (this.#waiting.length >= this.maximumWaiting)
        throw new APIError("SERVICE_UNAVAILABLE", {
          code: "AUTHENTICATION_BUSY",
          message: "Sign-in is busy. Try again shortly",
        });
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    try {
      return await operation();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
}

export class PasswordPolicy {
  private readonly gate = new PasswordVerificationGate(2, 16);
  hash = (password: string): Promise<string> =>
    this.gate.run(() => hashPassword(password));
  verify = (input: { hash: string; password: string }): Promise<boolean> =>
    this.gate.run(() => verifyPassword(input));
}
