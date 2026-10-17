import { RootsetError, limits, type JsonValue } from "./models";
import { validUnicode } from "./values";

export interface JsonDecoderOptions {
  maxBytes?: number;
  maxDepth?: number;
  safeIntegers?: boolean;
  onNumber?: (information: NumberLexeme) => void;
}
export interface NumberLexeme {
  path: (string | number)[];
  pointer: string;
  lexeme: string;
  value: number;
  integer: boolean;
  safeInteger: boolean;
}
function trailingZeroCount(digits: string): number {
  let end = digits.length;
  while (end > 0 && digits[end - 1] === "0") end--;
  return digits.length - end;
}
export function analyseNumberLexeme(
  lexeme: string,
  path: (string | number)[] = [],
): NumberLexeme {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lexeme);
  if (!parts)
    throw new RootsetError(
      "VALIDATION_FAILED",
      "Invalid numeric spelling",
      400,
    );
  const value = Number(lexeme);
  if (!Number.isFinite(value))
    throw new RootsetError("VALIDATION_FAILED", "Number is not finite", 400);
  const fraction = parts[3] ?? "";
  const shift = Number(parts[4] ?? "0") - fraction.length;
  const digits = `${parts[2]}${fraction}`.replace(/^0+/, "") || "0";
  const trailing = trailingZeroCount(digits);
  const integer = digits === "0" || shift >= 0 || trailing >= -shift;
  const safeInteger =
    integer &&
    (digits === "0" || digits.length + shift <= 16) &&
    Number.isSafeInteger(value);
  return {
    path,
    pointer: path.length
      ? `/${path.map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`
      : "",
    lexeme,
    value: Object.is(value, -0) ? 0 : value,
    integer,
    safeInteger,
  };
}
/** Reject duplicate keys and numeric loss before JSON.parse can discard them. */
export function parseStrictJson(
  text: string,
  options: JsonDecoderOptions = {},
): JsonValue {
  const maxBytes = options.maxBytes ?? limits.requestBytes;
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    throw new RootsetError(
      "PAYLOAD_TOO_LARGE",
      "JSON payload exceeds its byte budget",
      413,
    );
  if (!validUnicode(text))
    throw new RootsetError(
      "VALIDATION_FAILED",
      "JSON contains invalid Unicode or U+0000",
      400,
    );
  const maxDepth = options.maxDepth ?? limits.jsonDepth;
  let offset = 0;
  const fail = (message: string): never => {
    throw new RootsetError(
      "VALIDATION_FAILED",
      `Invalid JSON: ${message}`,
      400,
      { offset },
    );
  };
  const whitespace = () => {
    while (offset < text.length && /[ \t\r\n]/.test(text[offset]!)) offset++;
  };
  function string(): string {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') {
        let value: string;
        try {
          value = JSON.parse(text.slice(start, offset)) as string;
        } catch {
          return fail("invalid string escape");
        }
        if (!validUnicode(value))
          fail("string contains invalid Unicode or U+0000");
        return value;
      }
      if (character === "\\") offset++;
      else if (character && character.charCodeAt(0) < 32)
        fail("unescaped control character");
    }
    return fail("unterminated string");
  }
  function numeric(path: (string | number)[]): number {
    const start = offset;
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(offset),
    );
    if (!match) return fail("invalid number");
    const spelling = match[0];
    offset += spelling.length;
    const information = analyseNumberLexeme(spelling, path);
    const value = information.value;
    if (options.safeIntegers !== false) {
      const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(
        spelling,
      )!;
      const fraction = parts[3] ?? "";
      const shift = Number(parts[4] ?? "0") - fraction.length;
      const digits = `${parts[2]}${fraction}`.replace(/^0+/, "") || "0";
      // Integral lexemes can exceed the safe range even when Number rounds them.
      const trailing = trailingZeroCount(digits);
      if (digits !== "0" && (shift >= 0 || trailing >= -shift)) {
        const integralDigits =
          shift >= 0 ? digits.length + shift : digits.length + shift;
        if (integralDigits > 16)
          fail("integral number exceeds the safe integer range");
        if (Math.abs(value) > Number.MAX_SAFE_INTEGER)
          fail("integral number exceeds the safe integer range");
        if (shift >= 0 && shift < 17) {
          const exact = BigInt(digits) * 10n ** BigInt(shift);
          if (exact > BigInt(Number.MAX_SAFE_INTEGER))
            fail("integral number exceeds the safe integer range");
        }
      }
      // A nonintegral decimal near MAX_SAFE_INTEGER must not round to an integer.
      if (Number.isInteger(value) && !Number.isSafeInteger(value))
        fail("number would lose integer precision");
    }
    if (offset === start) return fail("invalid number");
    options.onNumber?.(information);
    return Object.is(value, -0) ? 0 : value;
  }
  function value(depth: number, path: (string | number)[]): JsonValue {
    whitespace();
    const character = text[offset];
    if (character === '"') return string();
    if (character === "-" || (character && /\d/.test(character)))
      return numeric(path);
    for (const [literal, result] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return result;
      }
    }
    if (character !== "[" && character !== "{") return fail("expected a value");
    if (depth >= maxDepth) fail(`nesting exceeds ${maxDepth} levels`);
    offset++;
    whitespace();
    if (character === "[") {
      const array: JsonValue[] = [];
      if (text[offset] === "]") {
        offset++;
        return array;
      }
      while (true) {
        array.push(value(depth + 1, [...path, array.length]));
        whitespace();
        const separator = text[offset++];
        if (separator === "]") return array;
        if (separator !== ",")
          return fail("expected array comma or closing bracket");
      }
    }
    const object = Object.create(null) as Record<string, JsonValue>;
    if (text[offset] === "}") {
      offset++;
      return object;
    }
    while (true) {
      whitespace();
      if (text[offset] !== '"') return fail("expected an object key");
      const key = string();
      if (Object.hasOwn(object, key)) return fail("duplicate object key");
      whitespace();
      if (text[offset++] !== ":") return fail("expected a colon");
      object[key] = value(depth + 1, [...path, key]);
      whitespace();
      const separator = text[offset++];
      if (separator === "}") return object;
      if (separator !== ",")
        return fail("expected object comma or closing brace");
    }
  }
  const result = value(0, []);
  whitespace();
  if (offset !== text.length) fail("trailing content");
  return result;
}
export function decodeJsonBytes(
  bytes: Uint8Array,
  options: JsonDecoderOptions = {},
): JsonValue {
  const maximum = options.maxBytes ?? limits.requestBytes;
  if (bytes.byteLength > maximum)
    throw new RootsetError(
      "PAYLOAD_TOO_LARGE",
      "JSON payload exceeds its byte budget",
      413,
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RootsetError("VALIDATION_FAILED", "JSON is not valid UTF-8", 400);
  }
  return parseStrictJson(text, options);
}
