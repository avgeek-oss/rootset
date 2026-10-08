import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { newId } from "@rootset/contracts";
import { decryptProtected, type EmailPayload } from "@rootset/email";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { createIdentityService } from "./index";

const origin = "http://localhost:6310";
test(
  "public verification has uniform acknowledgements, private budgets and session-bound personal resends",
  { skip: !process.env.ROOTSET_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await isolatedDatabase();
    t.after(() => fixture.close());
    const config = {
      pool: fixture.identity,
      baseURL: origin,

      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKey: randomBytes(32).toString("base64"),
    };
    const service = createIdentityService(config);
    const ownerEmail = "admin@example.test";
    const password = randomBytes(32).toString("base64url");
    const setup = (await service.claimSetup({
      bootstrapSecret: config.bootstrapSecret,
      name: "Admin",
      email: ownerEmail,
      password,
      organisationName: "Verification",
    })) as { userId: string };
    await fixture.owner.query(
      "UPDATE rootset_control.users SET email_verified=true WHERE id=$1",
      [setup.userId],
    );
    const pendingEmail = "pending@example.test";
    await fixture.owner.query(
      "INSERT INTO rootset_control.users(id,name,email) VALUES($1,'Pending',$2)",
      [newId(), pendingEmail],
    );
    const request = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      service.auth.handler(
        new Request(`${origin}/v1/auth${path}`, {
          method: "POST",
          headers: { origin, "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      );
    const login = await request("/sign-in/email", {
      email: ownerEmail,
      password,
    });
    assert.ok(login.ok, await login.clone().text());
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const publicRequest = (
      email: string,
      headers: Record<string, string> = {},
    ) => request("/request-verification-email", { email }, headers);
    const clearPublicBuckets = () =>
      fixture.owner.query("DELETE FROM rootset_control.identity_rate_limits");
    const emails = async () =>
      (
        await fixture.owner.query(
          "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='account-verification'",
          [pendingEmail],
        )
      ).rows;

    await t.test(
      "unknown, verified and unverified addresses acknowledge alike, ignore the browser account and use a fixed callback",
      async () => {
        for (const email of [
          "unknown@example.test",
          ownerEmail,
          " PENDING@EXAMPLE.TEST ",
        ]) {
          const started = performance.now();
          const response = await publicRequest(email, { cookie });
          assert.equal(response.status, 200, await response.clone().text());
          assert.deepEqual(await response.json(), { status: true });
          assert.equal(response.headers.getSetCookie().length, 0);
          assert.ok(
            performance.now() - started >= 480,
            "The common timing floor applies to every account state",
          );
        }
        const queued = await emails();
        assert.equal(queued.length, 1);
        const payload = decryptProtected<EmailPayload>(
          queued[0]!.payload_encrypted,
          config,
        );
        const url = new URL(payload.actionUrl!);
        assert.equal(url.searchParams.get("callbackURL"), `${origin}/login`);
        assert.equal(
          (
            await request("/request-verification-email", {
              email: pendingEmail,
              callbackURL: "https://example.invalid",
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await publicRequest("extra@example.test", {
              authorization: "Bearer invalid",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await publicRequest("extra@example.test", {
              "x-api-key": "invalid",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await publicRequest("extra@example.test", {
              origin: "https://example.invalid",
            })
          ).status,
          403,
        );
        assert.equal(
          (await request("/send-verification-email", { email: pendingEmail }))
            .status,
          401,
        );
        assert.equal(
          (
            await request(
              "/send-verification-email",
              { email: pendingEmail },
              { cookie },
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      "per-address limits apply equally to all account states and to concurrent requests",
      async () => {
        await clearPublicBuckets();
        for (const email of [
          "unknown@example.test",
          ownerEmail,
          pendingEmail,
        ]) {
          assert.equal((await publicRequest(email)).status, 200);
          const response = await publicRequest(email.toUpperCase());
          assert.equal(response.status, 429);
          assert.equal(
            (await response.json()).error.code,
            "EMAIL_VERIFICATION_RATE_LIMITED",
          );
          assert.ok(Number(response.headers.get("Retry-After")) > 0);
        }
        await clearPublicBuckets();
        const concurrent = await Promise.all([
          publicRequest("concurrent@example.test"),
          publicRequest("CONCURRENT@example.test"),
        ]);
        assert.deepEqual(
          concurrent.map((response) => response.status).sort(),
          [200, 429],
        );
      },
    );
    await t.test(
      "five daily requests are counted independently of account eligibility",
      async () => {
        await clearPublicBuckets();
        for (let count = 0; count < 5; count++) {
          await fixture.owner.query(
            "UPDATE rootset_control.identity_rate_limits SET expires_at=now()-interval '1 second' WHERE expires_at < now()+interval '2 minutes'",
          );
          assert.equal((await publicRequest("daily@example.test")).status, 200);
        }
        await fixture.owner.query(
          "UPDATE rootset_control.identity_rate_limits SET expires_at=now()-interval '1 second' WHERE expires_at < now()+interval '2 minutes'",
        );
        const response = await publicRequest("daily@example.test");
        assert.equal(response.status, 429);
        assert.ok(Number(response.headers.get("Retry-After")) > 60);
      },
    );
    await t.test(
      "the private outbox cooldown and five-email budget remain hidden from public callers",
      async () => {
        await clearPublicBuckets();
        assert.equal((await publicRequest(pendingEmail)).status, 200);
        assert.equal(
          (await emails()).length,
          1,
          "The authenticated outbox cooldown cannot be bypassed by clearing public buckets",
        );
        for (let count = 1; count < 5; count++) {
          await delay(1_000);
          await clearPublicBuckets();
          await fixture.owner.query(
            "UPDATE rootset_control.email_outbox SET created_at=now()-interval '2 minutes' WHERE to_address=$1",
            [pendingEmail],
          );
          assert.equal((await publicRequest(pendingEmail)).status, 200);
          assert.equal((await emails()).length, count + 1);
        }
        await clearPublicBuckets();
        await fixture.owner.query(
          "UPDATE rootset_control.email_outbox SET created_at=now()-interval '2 minutes' WHERE to_address=$1",
          [pendingEmail],
        );
        assert.equal((await publicRequest(pendingEmail)).status, 200);
        assert.equal((await emails()).length, 5);
        const buckets = (
          await fixture.owner.query(
            "SELECT bucket_hash FROM rootset_control.identity_rate_limits",
          )
        ).rows;
        assert.ok(
          buckets.every((row) => /^[a-f0-9]{64}$/.test(row.bucket_hash)),
          "Email and client addresses are hashed in limiter storage",
        );
      },
    );
  },
);
