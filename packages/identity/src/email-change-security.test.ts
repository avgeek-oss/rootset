import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { newId, type Actor } from "@rootset/contracts";
import { decryptProtected, type EmailPayload } from "@rootset/email";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { createIdentityService } from "./index";

test(
  "email-change preview is read-only and confirmation atomically revokes authority with one-use proof",
  { skip: !process.env.ROOTSET_TEST_DATABASE_URL },
  async (t) => {
    const db = await isolatedDatabase();
    t.after(() => db.close());
    const origin = "http://localhost:6311";
    const config = {
      pool: db.identity,
      baseURL: origin,

      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKey: randomBytes(32).toString("base64"),
    };
    const service = createIdentityService(config);
    const password = randomBytes(32).toString("base64url");
    const email = "admin@example.test",
      nextEmail = "confirmed@example.test";
    const setup = (await service.claimSetup({
      bootstrapSecret: config.bootstrapSecret,
      name: "Admin",
      email,
      password,
      organisationName: "Confirmation",
    })) as { userId: string; orgId: string };
    await db.owner.query(
      "UPDATE rootset_control.users SET email_verified=true WHERE id=$1",
      [setup.userId],
    );
    const call = (
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) =>
      service.auth.handler(
        new Request(`${origin}/v1/auth${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const login = await call("/sign-in/email", { email, password });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const actor = (await service.resolveActor(
      new Request(`${origin}/v1/auth/get-session`, { headers: { cookie } }),
      "browser",
    )) as Actor;
    const key = (await service.execute(
      "createPersonalKey",
      actor,
      {
        name: "Confirmation fixture",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      { idempotencyKey: newId() },
    )) as { key: { id: string }; secret: string };
    await service.execute(
      "changeEmail",
      actor,
      { newEmail: nextEmail },
      { idempotencyKey: newId() },
    );
    const message = (
      await db.owner.query(
        "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE template='email-change-verification' AND to_address=$1",
        [nextEmail],
      )
    ).rows[0];
    const payload = decryptProtected<EmailPayload>(
      message.payload_encrypted,
      config,
    );
    const link = new URL(payload.actionUrl!);
    const token = link.hash.slice(1);
    assert.equal(link.pathname, "/email-change");
    assert.equal(link.search, "");
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const inspect = await call("/email-change/inspect", { token });
    assert.equal(inspect.status, 200);
    assert.deepEqual(await inspect.json(), { status: "ready" });
    assert.equal(inspect.headers.get("cache-control"), "no-store");
    assert.equal(
      (
        await db.owner.query(
          "SELECT email FROM rootset_control.users WHERE id=$1",
          [setup.userId],
        )
      ).rows[0].email,
      email,
    );
    assert.equal(
      (await call(`/email-change/confirm?token=${token}`)).status,
      404,
    );
    assert.equal(
      (
        await call("/email-change/inspect", {
          token,
          callbackURL: "https://other.example/",
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await call(
          "/email-change/inspect",
          { token },
          { authorization: `Bearer ${key.secret}` },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/email-change/confirm",
          { token },
          { origin: "https://other.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/email-change/inspect", {
          token: randomBytes(32).toString("base64url"),
        })
      ).status,
      410,
    );

    await db.owner.query(
      `CREATE FUNCTION rootset_control.reject_confirmation_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.template='email-changed' THEN RAISE EXCEPTION 'fixture delivery persistence failure'; END IF; RETURN NEW; END $$`,
    );
    await db.owner.query(
      "CREATE TRIGGER confirmation_notice_failure BEFORE INSERT ON rootset_control.email_outbox FOR EACH ROW EXECUTE FUNCTION rootset_control.reject_confirmation_notice()",
    );
    const failed = await call("/email-change/confirm", { token });
    assert.equal(failed.status, 500);
    assert.equal(
      (
        await db.owner.query(
          "SELECT email FROM rootset_control.users WHERE id=$1",
          [setup.userId],
        )
      ).rows[0].email,
      email,
    );
    assert.ok(
      await service.resolveActor(
        new Request(`${origin}/v1/auth/get-session`, { headers: { cookie } }),
        "browser",
      ),
    );
    assert.equal(
      (
        await db.owner.query(
          "SELECT revoked_at FROM rootset_control.api_keys WHERE id=$1",
          [key.key.id],
        )
      ).rows[0].revoked_at,
      null,
    );
    assert.equal((await call("/email-change/inspect", { token })).status, 200);
    await db.owner.query(
      "DROP TRIGGER confirmation_notice_failure ON rootset_control.email_outbox",
    );
    const confirmations = await Promise.all([
      call("/email-change/confirm", { token }),
      call("/email-change/confirm", { token }),
    ]);
    assert.deepEqual(
      confirmations.map((response) => response.status).sort(),
      [200, 410],
    );
    assert.equal((await call("/email-change/inspect", { token })).status, 410);
    assert.equal(
      (
        await db.owner.query(
          "SELECT email FROM rootset_control.users WHERE id=$1",
          [setup.userId],
        )
      ).rows[0].email,
      nextEmail,
    );
    assert.equal(
      await service.resolveActor(
        new Request(`${origin}/v1/auth/get-session`, { headers: { cookie } }),
        "browser",
      ),
      null,
    );
    assert.notEqual(
      (
        await db.owner.query(
          "SELECT revoked_at FROM rootset_control.api_keys WHERE id=$1",
          [key.key.id],
        )
      ).rows[0].revoked_at,
      null,
    );
    assert.equal(
      (
        await db.owner.query(
          "SELECT count(*)::int count FROM rootset_control.email_outbox WHERE template='email-changed'",
        )
      ).rows[0].count,
      2,
    );
  },
);
