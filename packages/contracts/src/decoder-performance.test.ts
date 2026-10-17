import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

test("numeric decoding finishes on long zero runs followed by a nonzero digit", async () => {
  const decoder = new URL("./decoder.ts", import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import { analyseNumberLexeme, parseStrictJson } from ${JSON.stringify(decoder)};
    const zeroes = '0'.repeat(500000);
    const fractional = '1.' + zeroes + '1';
    const information = analyseNumberLexeme(fractional);
    assert.equal(information.integer, false);
    assert.equal(information.safeInteger, false);
    assert.equal(parseStrictJson(fractional), 1);
    assert.equal(parseStrictJson(fractional, { safeIntegers: false }), 1);
    const integral = '1' + zeroes + 'e-500000';
    assert.equal(analyseNumberLexeme(integral).safeInteger, true);
    assert.equal(parseStrictJson(integral), 1);
  `;
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", program],
    { timeout: 10000, maxBuffer: 16384 },
  );
  assert.equal(result.stderr, "");
});
