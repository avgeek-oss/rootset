import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";

export interface PasswordPolicyOptions {
  breachCheck?: boolean;
  maximumActive?: number;
  maximumWaiting?: number;
}

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

export async function isPasswordCompromised(
  password: string,
  request = fetch,
): Promise<boolean> {
  // SHA-1 is used only for HIBP's range lookup, never for credential storage.
  const digest = createHash("sha1")
    .update(password)
    .digest("hex")
    .toUpperCase();
  try {
    const response = await request(
      `https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`,
      {
        headers: {
          "Add-Padding": "true",
          "User-Agent": "Rootset Password Checker",
        },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      },
    );
    if (!response.ok || !response.body)
      throw new Error("Password corpus unavailable");
    let text = "";
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString("ascii");
        if (text.length > 2_000_000)
          throw new Error("Password corpus response too large");
      }
    } finally {
      await reader.cancel();
    }
    if (
      !text.trim() ||
      !text
        .trim()
        .split(/\r?\n/u)
        .every((line) => /^[A-F0-9]{35}:\d+$/u.test(line))
    )
      throw new Error("Invalid password corpus response");
    return text
      .split(/\r?\n/u)
      .some(
        (line) =>
          line.startsWith(`${digest.slice(5)}:`) && Number(line.slice(36)) > 0,
      );
  } catch {
    throw new APIError("SERVICE_UNAVAILABLE", {
      message:
        "Password safety check is temporarily unavailable. Try again shortly.",
    });
  }
}

export class PasswordPolicy {
  private readonly gate: PasswordVerificationGate;
  private readonly breachCheck: boolean;
  constructor(options: PasswordPolicyOptions = {}) {
    this.gate = new PasswordVerificationGate(
      options.maximumActive ?? 2,
      options.maximumWaiting ?? 16,
    );
    this.breachCheck = options.breachCheck ?? true;
  }
  hash = async (password: string): Promise<string> =>
    this.gate.run(async () => {
      if (this.breachCheck && (await isPasswordCompromised(password)))
        throw new APIError("BAD_REQUEST", {
          message:
            "This password has appeared in a data breach. Choose a different password.",
        });
      return hashPassword(password);
    });
  verify = (input: { hash: string; password: string }): Promise<boolean> =>
    this.gate.run(() => verifyPassword(input));
}
