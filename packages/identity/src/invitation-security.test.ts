import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { newId, type Actor } from "@rootset/contracts";
import { decryptProtected, type EmailPayload } from "@rootset/email";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { createIdentityService } from "./index";

const origin = "http://localhost:6310";
test(
  "invitations require recipient email proof before account creation and bind bounded one-use password setup",
  { skip: !process.env.ROOTSET_TEST_IDENTITY_DATABASE_URL },
  async (t) => {
    const db = await isolatedDatabase();
    t.after(() => db.close());
    const config = {
      pool: db.identity,
      baseURL: origin,
      passwordPolicy: { breachCheck: false },
      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKeys: { test: randomBytes(32).toString("base64") },
      activeEncryptionKeyId: "test",
    };
    const service = createIdentityService(config);
    const password = randomBytes(32).toString("base64url");
    const setup = (await service.claimSetup({
      bootstrapSecret: config.bootstrapSecret,
      name: "Admin",
      email: "admin@example.test",
      password,
      organisationName: "Invitations",
    })) as { userId: string; orgId: string };
    await db.owner.query(
      "UPDATE rootset_control.users SET email_verified=true WHERE id=$1",
      [setup.userId],
    );
    const call = (path: string, body?: unknown, cookie = "") =>
      service.auth.handler(
        new Request(`${origin}/v1/auth${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin,
            ...(cookie ? { cookie } : {}),
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const login = await call("/sign-in/email", {
      email: "admin@example.test",
      password,
    });
    assert.ok(login.ok);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const actor = (await service.resolveActor(
      new Request(`${origin}/v1/auth/get-session`, { headers: { cookie } }),
      "browser",
    )) as Actor;
    const invite = async () => {
      const email = `invite-${newId().toLowerCase()}@example.test`;
      const input = { orgId: setup.orgId, email, role: "viewer" };
      const context = { idempotencyKey: newId() };
      const invitation = (await service.execute(
        "inviteMember",
        actor,
        input,
        context,
      )) as { id: string; inviteUrl: string };
      const retry = await service.execute(
        "inviteMember",
        actor,
        input,
        context,
      );
      assert.deepEqual(
        retry,
        invitation,
        "The invitation URL is replayable metadata containing only the opaque invitation ID",
      );
      assert.equal(
        new URL(invitation.inviteUrl).pathname,
        `/invite/${invitation.id}`,
      );
      return { ...invitation, email };
    };
    const begin = async (invitation: { id: string; email: string }) => {
      const response = await call(`/invitations/${invitation.id}/verify`, {});
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { existingAccount: false });
      const row = (
        await db.owner.query(
          "SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='invitation-verification' ORDER BY created_at DESC LIMIT 1",
          [invitation.email],
        )
      ).rows[0];
      const payload = decryptProtected<EmailPayload>(
        row.payload_encrypted,
        config,
      );
      return payload.details!.match(/\d{6}/)![0];
    };
    const prove = async (id: string, code: string) => {
      const response = await call(`/invitations/${id}/code`, {
        name: "Invited person",
        code,
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.getSetCookie().length, 0);
      return (await response.json()).setupToken as string;
    };
    await t.test(
      "a shareable invitation link gives no account, password or membership authority before email proof",
      async () => {
        const invitation = await invite();
        assert.equal((await call(`/invitations/${invitation.id}`)).status, 200);
        assert.equal(
          (
            await call("/invitations/accept", {
              token: invitation.id,
              name: "Attacker",
              password,
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await call(`/invitations/${invitation.id}/signup`, {
              setupToken: randomBytes(32).toString("base64url"),
              password,
            })
          ).status,
          400,
        );
        const code = await begin(invitation);
        const token = await prove(invitation.id, code);
        assert.equal(
          (
            await db.owner.query(
              "SELECT id FROM rootset_control.users WHERE email=$1",
              [invitation.email],
            )
          ).rowCount,
          0,
        );
        const receipt = (
          await db.owner.query(
            "SELECT identifier,value FROM rootset_control.auth_verifications WHERE identifier LIKE 'rootset-invitation-password:%'",
          )
        ).rows;
        assert.ok(
          receipt.every((row) => !JSON.stringify(row).includes(token)),
          "Setup tokens are stored only as keyed hashes",
        );
        const signup = await call(`/invitations/${invitation.id}/signup`, {
          setupToken: token,
          password,
        });
        assert.equal(signup.status, 200, await signup.clone().text());
        const memberCookie = signup.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        const member = await service.resolveActor(
          new Request(`${origin}/v1/auth/get-session`, {
            headers: { cookie: memberCookie },
          }),
          "browser",
        );
        assert.equal(member?.role, "viewer");
        assert.equal(
          (
            await call(`/invitations/${invitation.id}/signup`, {
              setupToken: token,
              password,
            })
          ).ok,
          false,
        );
        assert.equal(
          (
            await db.owner.query(
              "SELECT count(*)::int count FROM rootset_control.memberships WHERE org_id=$1 AND user_id=$2",
              [setup.orgId, member?.userId],
            )
          ).rows[0].count,
          1,
        );
      },
    );
    await t.test(
      "email codes stop after five wrong attempts and expire without issuing password authority",
      async () => {
        const invitation = await invite();
        const code = await begin(invitation);
        const wrong = code === "000000" ? "000001" : "000000";
        for (let count = 0; count < 5; count++)
          assert.equal(
            (
              await call(`/invitations/${invitation.id}/code`, {
                name: "Person",
                code: wrong,
              })
            ).status,
            400,
          );
        assert.equal(
          (
            await call(`/invitations/${invitation.id}/code`, {
              name: "Person",
              code,
            })
          ).status,
          400,
        );
        const next = await invite();
        const nextCode = await begin(next);
        await db.owner.query(
          "UPDATE rootset_control.auth_verifications SET expires_at=now()-interval '1 second' WHERE identifier=$1",
          [`rootset-invitation-code:${next.id}`],
        );
        assert.equal(
          (
            await call(`/invitations/${next.id}/code`, {
              name: "Person",
              code: nextCode,
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "codes and password receipts are bound to the exact invitation and survive a refused foreign target",
      async () => {
        const first = await invite(),
          second = await invite();
        const code = await begin(first);
        assert.equal(
          (
            await call(`/invitations/${second.id}/code`, {
              name: "Person",
              code,
            })
          ).status,
          400,
        );
        const token = await prove(first.id, code);
        assert.equal(
          (
            await call(`/invitations/${second.id}/signup`, {
              setupToken: token,
              password,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await call(`/invitations/${first.id}/signup`, {
              setupToken: token,
              password,
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      "concurrent code consumption and signup grant exactly one recipient account",
      async () => {
        const invitation = await invite();
        const code = await begin(invitation);
        const responses = await Promise.all([
          call(`/invitations/${invitation.id}/code`, { name: "One", code }),
          call(`/invitations/${invitation.id}/code`, { name: "Two", code }),
        ]);
        assert.deepEqual(
          responses.map((response) => response.status).sort(),
          [200, 400],
        );
        const setupToken = (
          await responses.find((response) => response.ok)!.json()
        ).setupToken;
        const signup = await Promise.all([
          call(`/invitations/${invitation.id}/signup`, {
            setupToken,
            password,
          }),
          call(`/invitations/${invitation.id}/signup`, {
            setupToken,
            password,
          }),
        ]);
        assert.equal(signup.filter((response) => response.ok).length, 1);
        assert.equal(
          (
            await db.owner.query(
              "SELECT count(*)::int count FROM rootset_control.users WHERE email=$1",
              [invitation.email],
            )
          ).rows[0].count,
          1,
        );
      },
    );
    await t.test(
      "existing recipients must sign in with the exact verified email and cannot replace their password through an invitation",
      async () => {
        const created = await invite();
        const setupToken = await prove(created.id, await begin(created));
        const signup = await call(`/invitations/${created.id}/signup`, {
          setupToken,
          password,
        });
        assert.equal(signup.status, 200);
        const recipientCookie = signup.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        const member = await service.resolveActor(
          new Request(`${origin}/v1/auth/get-session`, {
            headers: { cookie: recipientCookie },
          }),
          "browser",
        );
        const membership = (
          await db.owner.query(
            "SELECT id,version FROM rootset_control.memberships WHERE user_id=$1",
            [member!.userId],
          )
        ).rows[0];
        await service.execute(
          "removeMember",
          actor,
          {
            orgId: setup.orgId,
            id: membership.id,
            expectedVersion: String(membership.version),
          },
          { idempotencyKey: newId() },
        );
        const invitation = (await service.execute(
          "inviteMember",
          actor,
          { orgId: setup.orgId, email: created.email, role: "member" },
          { idempotencyKey: newId() },
        )) as { id: string };
        const response = await call(`/invitations/${invitation.id}/verify`, {});
        assert.deepEqual(await response.json(), { existingAccount: true });
        assert.equal(
          (
            await call(`/invitations/${invitation.id}/code`, {
              name: "Replacement",
              code: "000000",
            })
          ).status,
          400,
        );
        assert.equal(
          (await call(`/invitations/${invitation.id}/accept`, {}, cookie))
            .status,
          403,
        );
        const login = await call("/sign-in/email", {
          email: created.email,
          password,
        });
        assert.equal(login.status, 200);
        const matchingCookie = login.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        assert.equal(
          (
            await call(
              `/invitations/${invitation.id}/accept`,
              {},
              matchingCookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              `/invitations/${invitation.id}/accept`,
              {},
              matchingCookie,
            )
          ).status,
          200,
        );
        const accepted = await service.resolveActor(
          new Request(`${origin}/v1/auth/get-session`, {
            headers: { cookie: matchingCookie },
          }),
          "browser",
        );
        assert.equal(accepted?.role, "member");
        assert.equal(
          (
            await call(`/invitations/${invitation.id}/verify`, {
              email: "other@example.test",
            })
          ).status,
          422,
        );
        assert.equal(
          (await call(`/invitations/${invitation.id}/unexpected`)).status,
          404,
        );
      },
    );
    await t.test(
      "revocation, receipt expiry and inviter demotion prevent account creation after email proof",
      async () => {
        for (const change of ["revoked", "expired", "demoted"]) {
          const invitation = await invite();
          const token = await prove(invitation.id, await begin(invitation));
          if (change === "revoked")
            await service.execute(
              "cancelInvitation",
              actor,
              { orgId: setup.orgId, id: invitation.id },
              { idempotencyKey: newId() },
            );
          if (change === "expired")
            await db.owner.query(
              "UPDATE rootset_control.auth_verifications SET expires_at=now()-interval '1 second' WHERE value::jsonb->>'invitationId'=$1",
              [invitation.id],
            );
          if (change === "demoted")
            await db.owner.query(
              "UPDATE rootset_control.memberships SET role='viewer' WHERE user_id=$1",
              [setup.userId],
            );
          assert.equal(
            (
              await call(`/invitations/${invitation.id}/signup`, {
                setupToken: token,
                password,
              })
            ).ok,
            false,
          );
          assert.equal(
            (
              await db.owner.query(
                "SELECT id FROM rootset_control.users WHERE email=$1",
                [invitation.email],
              )
            ).rowCount,
            0,
          );
        }
      },
    );
  },
);
