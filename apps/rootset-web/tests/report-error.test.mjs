import { test } from "node:test";
import assert from "node:assert/strict";
import { reportError } from "./report-error.mjs";

test("request timeout reports retain the failure but exclude Playwright credential call logs", () => {
  const safe = reportError(
    new Error(
      "apiRequestContext.post: Timeout 30000ms\nCall log:\n - cookie: rootset.session_token=private-fixture\n - authorization: Bearer private-token",
    ),
  );
  assert.equal(safe, "apiRequestContext.post: Timeout 30000ms");
  assert.ok(!safe.includes("private-"));
});
test("diagnostics redact direct headers and credential query values", () => {
  const safe = reportError(
    new Error(
      "Download refused\nCookie: private-cookie\nAuthorization: Bearer private-bearer\nhttps://example.test/verify?token=private-token&state=public-state\notpauth://totp/example?secret=private-factor",
    ),
  );
  assert.ok(!safe.includes("private-"));
  assert.ok(safe.includes("public-state"));
  assert.ok(safe.includes("Download refused"));
});
