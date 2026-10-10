import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  decryptProtected,
  encryptProtected,
  emailTemplates,
  renderEmail,
} from "./index";
const encryption = { encryptionKey: randomBytes(32).toString("base64") };
test("protected payloads round-trip with the installation key and reject wrong keys or modification", () => {
  const input = {
    actionUrl: "https://rootset.dev/verify?token=protected",
    name: "Test",
  };
  const encrypted = encryptProtected(input, encryption);
  assert.equal(encrypted.includes("protected"), false);
  assert.throws(() =>
    decryptProtected(encrypted.replace(/^v1:/, "v2:"), encryption),
  );
  assert.deepEqual(decryptProtected(encrypted, encryption), input);
  assert.throws(() => decryptProtected(`${encrypted}x`, encryption));
  assert.throws(() =>
    decryptProtected(encrypted, {
      encryptionKey: randomBytes(32).toString("base64"),
    }),
  );
});
test("AUTH-12 all security templates render branded escaped HTML and plain text", async () => {
  for (const template of Object.keys(
    emailTemplates,
  ) as (keyof typeof emailTemplates)[]) {
    const result = await renderEmail(
      template,
      {
        name: "<script>alert(1)</script>",
        organisationName: "A & B",
        actionUrl: "https://rootset.dev/action",
        expiresAt: "2026-10-02T13:45:00.000Z",
      },
      "https://rootset.dev",
    );
    assert.ok(result.subject.includes("Rootset"));
    assert.ok(result.html.includes("Rootset"));
    assert.ok(result.text.includes("Rootset"));
    assert.ok(!result.html.includes("<script>"));
    assert.ok(result.html.includes("&lt;script&gt;"));
    assert.ok(!result.html.includes("Towbar"));
    assert.ok(!result.text.includes("Towbar"));
    assert.match(result.html, /background-color:#2c5f40/);
    assert.doesNotMatch(result.html, /#514127/);
  }
  await assert.rejects(() =>
    renderEmail(
      "account-verification",
      { actionUrl: "https://attacker.invalid/secret" },
      "https://rootset.dev",
    ),
  );
  await renderEmail(
    "account-verification",
    {
      actionUrl:
        "https://rootset-api.avgeek.ltd/v1/auth/verify-email?token=fixture",
    },
    "https://rootset.avgeek.ltd",
    ["https://rootset-api.avgeek.ltd"],
  );
  await assert.rejects(() =>
    renderEmail(
      "account-verification",
      { actionUrl: "https://attacker.invalid/secret" },
      "https://rootset.avgeek.ltd",
      ["https://rootset-api.avgeek.ltd"],
    ),
  );
});
