import {
  RootsetError,
  limits,
  decodeJsonBytes,
  parseStrictJson,
  type NumberLexeme,
} from "@rootset/contracts";
const numbers = new WeakMap<object, NumberLexeme[]>();
export function numberLexemes(value: unknown): NumberLexeme[] {
  return value && typeof value === "object" ? (numbers.get(value) ?? []) : [];
}

export async function readJson(
  request: Request,
  maximum = limits.requestBytes,
  deadlineMs: number = limits.requestTimeoutMs,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Use application/json for this request.",
      415,
    );
  const length = request.headers.get("content-length");
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > maximum))
    throw new RootsetError(
      "PAYLOAD_TOO_LARGE",
      "Request exceeds the body budget.",
      413,
    );
  if (!request.body)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "JSON request body is required.",
      400,
    );
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0,
    completed = false;
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          new RootsetError(
            "REQUEST_TIMEOUT",
            "JSON request body exceeded its read deadline.",
            408,
          ),
        ),
      deadlineMs,
    );
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        completed = true;
        break;
      }
      size += value.byteLength;
      if (size > maximum) {
        throw new RootsetError(
          "PAYLOAD_TOO_LARGE",
          "Request exceeds the body budget.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout!);
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const numericLexemes: NumberLexeme[] = [];
  const value = decodeJsonBytes(bytes, {
    maxBytes: maximum,
    maxDepth: 40,
    safeIntegers: false,
    onNumber: (information) => numericLexemes.push(information),
  });
  if (value && typeof value === "object") numbers.set(value, numericLexemes);
  return value;
}

export function decodeJson(text: string): unknown {
  return parseStrictJson(text, { maxDepth: 40, safeIntegers: false });
}
