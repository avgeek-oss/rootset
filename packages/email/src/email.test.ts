import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  decryptProtected,
  encryptProtected,
  emailTemplates,
  renderEmail,
} from "./index";
const encryption = {
  encryptionKeys: { v1: randomBytes(32).toString("base64") },
  activeEncryptionKeyId: "v1",
};
test("KEY-09 protected payloads retain old-key decryption and reject modification", () => {
  const input = {
    actionUrl: "https://rootset.fyi/verify?token=protected",
    name: "Test",
  };
  const encrypted = encryptProtected(input, encryption);
  assert.equal(encrypted.includes("protected"), false);
  const rotated = {
    encryptionKeys: {
      ...encryption.encryptionKeys,
      v2: randomBytes(32).toString("base64"),
    },
    activeEncryptionKeyId: "v2",
  };
  assert.deepEqual(decryptProtected(encrypted, rotated), input);
  assert.throws(() => decryptProtected(`${encrypted}x`, rotated));
  assert.throws(() =>
    decryptProtected(encrypted, {
      encryptionKeys: { v2: rotated.encryptionKeys.v2 },
      activeEncryptionKeyId: "v2",
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
        actionUrl: "https://rootset.fyi/action",
        expiresAt: "2026-10-02T13:45:00.000Z",
      },
      "https://rootset.fyi",
    );
    assert.ok(result.subject.includes("Rootset"));
    assert.ok(result.html.includes("Rootset"));
    assert.ok(result.text.includes("Rootset"));
    assert.ok(!result.html.includes("<script>"));
    assert.ok(result.html.includes("&lt;script&gt;"));
    assert.ok(!result.html.includes("Towbar"));
    assert.ok(!result.text.includes("Towbar"));
  }
  await assert.rejects(() =>
    renderEmail(
      "account-verification",
      { actionUrl: "https://attacker.invalid/secret" },
      "https://rootset.fyi",
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
