import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { OAuthService } from "../../oauth/src/index";
import { MetadataPaging } from "../../core/src/paging";
import { newId, type Actor } from "@rootset/contracts";
import { decryptProtected, type EmailPayload } from "@rootset/email";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";
import { createIdentityService } from "./index";
import { testAuthenticator } from "./webauthn-test-authenticator";

const origin = "http://localhost:6310";
const responseCookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
test(
  "V1-06 AUTH-03 AUTH-04 passkey crypto, password gates, bound fresh proof and one-use recovery",
  { skip: !process.env.ROOTSET_TEST_IDENTITY_DATABASE_URL },
  async (t) => {
    const fixture = await isolatedDatabase();
    const config = {
      pool: fixture.identity,
      baseURL: origin,
      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKeys: { test: randomBytes(32).toString("base64") },
      activeEncryptionKeyId: "test",
    };
    const service = createIdentityService(config);
    service.setPaging(new MetadataPaging(randomBytes(32).toString("hex")));
    const email = `passkeys-${newId().toLowerCase()}@example.test`;
    const password = randomBytes(32).toString("base64url");
    const request = (path: string, body?: unknown, cookie = "") =>
      new Request(`${origin}/v1/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin,
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const call = (path: string, body?: unknown, cookie = "") =>
      service.auth.handler(request(path, body, cookie));
    const ok = async (response: Response) => {
      assert.ok(response.ok, await response.clone().text());
      return response;
    };
    const signIn = () => call("/sign-in/email", { email, password });
    const options = async (path: string, cookie = "") => {
      const response = await ok(
        await call(`/passkey${path}`, undefined, cookie),
      );
      return {
        data: (await response.json()) as {
          challenge: string;
          allowCredentials?: Array<{ id: string }>;
          userVerification: string;
        },
        cookie: [cookie, responseCookies(response)].filter(Boolean).join("; "),
      };
    };
    let sessionCookie = "";
    let recoverySessionCookie = "";
    let actor: Actor;
    const authenticator = testAuthenticator();
    let firstCodes: string[] = [];
    let keyId = "";
    let counter = 0;
    const assertion = async (cookie: string, verified = true, url = origin) => {
      const challenge = await options("/generate-authenticate-options", cookie);
      return call(
        "/passkey/verify-authentication",
        {
          response: authenticator.authentication(
            challenge.data.challenge,
            url,
            ++counter,
            verified,
          ),
        },
        challenge.cookie,
      );
    };
    try {
      await service.claimSetup({
        bootstrapSecret: config.bootstrapSecret,
        name: "Passkey verification",
        email,
        password,
        organisationName: "Disposable passkeys",
      });
      const verify = (
        await fixture.owner.query(
          `SELECT payload_encrypted FROM rootset_control.email_outbox WHERE to_address=$1 AND template='account-verification' ORDER BY created_at DESC LIMIT 1`,
          [email],
        )
      ).rows[0];
      const payload = decryptProtected<EmailPayload>(
        verify.payload_encrypted,
        config,
      );
      const verified = await service.auth.handler(
        new Request(payload.actionUrl!),
      );
      assert.ok(verified.ok || verified.status === 302);
      const signed = await ok(await signIn());
      sessionCookie = responseCookies(signed);
      actor = (await service.resolveActor(
        request("/get-session", undefined, sessionCookie),
        "browser",
      ))!;
      const passkeyStatus = async () => {
        const members = (await service.execute("listMembers", actor, {
          orgId: actor.orgId,
          limit: 25,
        })) as { data: Array<{ userId: string; twoFactorEnabled: boolean }> };
        return members.data.find((member) => member.userId === actor.userId)!
          .twoFactorEnabled;
      };
      assert.equal(await passkeyStatus(), false);
      await t.test(
        "removed authenticator endpoints and action types cannot enroll or verify codes",
        async () => {
          for (const path of [
            "enable",
            "disable",
            "verify-totp",
            "verify-backup-code",
            "generate-backup-codes",
          ])
            assert.equal(
              (
                await call(
                  `/two-factor/${path}`,
                  { password, code: "123456" },
                  sessionCookie,
                )
              ).status,
              404,
            );
          await assert.rejects(() =>
            service.execute(
              "beginAccountAction",
              actor,
              {
                type: "enable_totp",
                operationId: "enableTwoFactor",
                input: {},
              },
              { idempotencyKey: newId() },
            ),
          );
        },
      );
      await t.test(
        "registration rejects stale sessions, missing UV, wrong origin and session creation bypass",
        async () => {
          await fixture.owner.query(
            `UPDATE rootset_control.sessions SET authenticated_at=to_timestamp(0) WHERE id=$1`,
            [actor.id],
          );
          assert.equal(
            (
              await call(
                "/passkey/generate-register-options",
                undefined,
                sessionCookie,
              )
            ).status,
            403,
          );
          await ok(await call("/reauthenticate", { password }, sessionCookie));
          for (const [verified, url] of [
            [false, origin],
            [true, "http://other.localhost:6310"],
          ] as const) {
            const challenge = await options(
              "/generate-register-options",
              sessionCookie,
            );
            assert.equal(
              (
                await call(
                  "/passkey/verify-registration",
                  {
                    name: "Rejected key",
                    response: authenticator.registration(
                      challenge.data.challenge,
                      url,
                      verified,
                    ),
                  },
                  challenge.cookie,
                )
              ).ok,
              false,
            );
          }
          const challenge = await options(
            "/generate-register-options",
            sessionCookie,
          );
          assert.equal(
            (
              await call(
                "/passkey/verify-registration",
                {
                  createSession: true,
                  name: "Rejected key",
                  response: authenticator.registration(
                    challenge.data.challenge,
                    origin,
                  ),
                },
                challenge.cookie,
              )
            ).status,
            422,
          );
          const response = await ok(
            await call(
              "/passkey/verify-registration",
              {
                name: "Primary key",
                response: authenticator.registration(
                  challenge.data.challenge,
                  origin,
                ),
              },
              challenge.cookie,
            ),
          );
          const data = (await response.json()) as {
            id: string;
            recoveryCodes: string[];
          };
          keyId = data.id;
          firstCodes = data.recoveryCodes;
          assert.equal(firstCodes.length, 10);
          assert.equal(await passkeyStatus(), true);
          assert.equal(
            (
              await call(
                "/passkey/verify-registration",
                {
                  name: "Replay",
                  response: authenticator.registration(
                    challenge.data.challenge,
                    origin,
                  ),
                },
                challenge.cookie,
              )
            ).ok,
            false,
          );
          assert.equal(
            (
              await fixture.owner.query(
                `SELECT count(*) FROM rootset_control.auth_passkeys WHERE user_id=$1`,
                [actor.userId],
              )
            ).rows[0].count,
            "1",
          );
        },
      );
      await t.test(
        "password sign-in has no usable session until the bound passkey verifies",
        async () => {
          const pending = await ok(await signIn());
          assert.deepEqual(await pending.clone().json(), {
            twoFactorRedirect: true,
            twoFactorMethods: ["passkey"],
          });
          const pendingCookie = responseCookies(pending);
          assert.equal(
            await service.resolveActor(
              request("/get-session", undefined, pendingCookie),
              "browser",
            ),
            null,
          );
          const challenge = await options(
            "/generate-authenticate-options",
            pendingCookie,
          );
          assert.equal(challenge.data.userVerification, "required");
          assert.equal(challenge.data.allowCredentials?.length, 1);
          const response = await ok(
            await call(
              "/passkey/verify-authentication",
              {
                response: authenticator.authentication(
                  challenge.data.challenge,
                  origin,
                  ++counter,
                ),
              },
              challenge.cookie,
            ),
          );
          assert.equal(
            (
              await service.resolveActor(
                request("/get-session", undefined, responseCookies(response)),
                "browser",
              )
            )?.userId,
            actor.userId,
          );
        },
      );
      await t.test(
        "assertion UV, origin, pending-sign-in binding and concurrent replay fail closed",
        async () => {
          assert.equal((await assertion("", false)).ok, false);
          assert.equal(
            (await assertion("", true, "http://other.localhost:6310")).ok,
            false,
          );
          const a = responseCookies(await ok(await signIn()));
          const challenge = await options("/generate-authenticate-options", a);
          const b = responseCookies(await ok(await signIn()));
          const swapped = challenge.cookie.replace(
            /rootset\.passkey_factor=[^;]+/,
            b.match(/rootset\.passkey_factor=[^;]+/)![0],
          );
          assert.equal(
            (
              await call(
                "/passkey/verify-authentication",
                {
                  response: authenticator.authentication(
                    challenge.data.challenge,
                    origin,
                    ++counter,
                  ),
                },
                swapped,
              )
            ).ok,
            false,
          );
          const fresh = await options("/generate-authenticate-options", b);
          const body = {
            response: authenticator.authentication(
              fresh.data.challenge,
              origin,
              ++counter,
            ),
          };
          const results = await Promise.all([
            call("/passkey/verify-authentication", body, fresh.cookie),
            call("/passkey/verify-authentication", body, fresh.cookie),
          ]);
          assert.equal(results.filter((r) => r.ok).length, 1);
        },
      );
      await t.test(
        "fresh verification is bound to the original session and retains its ID",
        async () => {
          const foreign = responseCookies(await ok(await assertion("")));
          const challenge = await options(
            "/generate-authenticate-options",
            sessionCookie,
          );
          const swapped = challenge.cookie.replace(
            /rootset\.session_token=[^;]+/,
            foreign.match(/rootset\.session_token=[^;]+/)![0],
          );
          assert.equal(
            (
              await call(
                "/passkey/verify-authentication",
                {
                  response: authenticator.authentication(
                    challenge.data.challenge,
                    origin,
                    ++counter,
                  ),
                },
                swapped,
              )
            ).ok,
            false,
          );
          await fixture.owner.query(
            `UPDATE rootset_control.sessions SET authenticated_at=to_timestamp(0) WHERE id=$1`,
            [actor.id],
          );
          assert.equal(
            (await call("/reauthenticate", { password }, sessionCookie)).status,
            403,
          );
          assert.equal(
            (
              await call(
                "/reauthenticate",
                { password, code: "123456" },
                sessionCookie,
              )
            ).status,
            422,
          );
          assert.equal(
            (await call("/passkey/replace-recovery-codes", {}, sessionCookie))
              .status,
            403,
          );
          const response = await ok(await assertion(sessionCookie));
          const data = (await response.json()) as {
            session: { id: string };
            reauthenticated: boolean;
          };
          assert.equal(data.session.id, actor.id);
          assert.equal(data.reauthenticated, true);
          assert.equal(
            response.headers
              .getSetCookie()
              .some((c) => /rootset\.session_token=/.test(c)),
            false,
          );
          actor = await service.refreshActor(actor);
          assert.ok(actor.authenticatedAt! > Date.now() - 10_000);
        },
      );
      await t.test(
        "replacing codes invalidates old codes and never stores plaintext",
        async () => {
          const response = await ok(
            await call("/passkey/replace-recovery-codes", {}, sessionCookie),
          );
          const codes = ((await response.json()) as { recoveryCodes: string[] })
            .recoveryCodes;
          const hashes = (
            await fixture.owner.query(
              `SELECT code_hashes FROM rootset_control.auth_recovery_codes WHERE user_id=$1`,
              [actor.userId],
            )
          ).rows[0].code_hashes as string[];
          assert.equal(hashes.length, 10);
          assert.ok(
            hashes.every(
              (hash) => /^[a-f0-9]{64}$/.test(hash) && !codes.includes(hash),
            ),
          );
          assert.equal(
            (
              await call(
                "/passkey/verify-recovery-code",
                { code: firstCodes[0] },
                responseCookies(await ok(await signIn())),
              )
            ).status,
            401,
          );
          assert.equal(
            (await call("/passkey/verify-recovery-code", { code: codes[0] }))
              .status,
            401,
          );
          const a = responseCookies(await ok(await signIn()));
          const b = responseCookies(await ok(await signIn()));
          const results = await Promise.all([
            call("/passkey/verify-recovery-code", { code: codes[0] }, a),
            call("/passkey/verify-recovery-code", { code: codes[0] }, b),
          ]);
          assert.equal(results.filter((r) => r.ok).length, 1);
          recoverySessionCookie = responseCookies(results.find((r) => r.ok)!);
          assert.equal(
            (
              await fixture.owner.query(
                `SELECT cardinality(code_hashes) remaining FROM rootset_control.auth_recovery_codes WHERE user_id=$1`,
                [actor.userId],
              )
            ).rows[0].remaining,
            9,
          );
          const expired = responseCookies(await ok(await signIn()));
          await fixture.owner.query(
            `UPDATE rootset_control.auth_verifications SET expires_at=to_timestamp(0) WHERE value=$1`,
            [actor.userId],
          );
          assert.equal(
            (
              await call(
                "/passkey/verify-recovery-code",
                { code: codes[1] },
                expired,
              )
            ).status,
            401,
          );
        },
      );
      await t.test(
        "recovery restores read access but cannot grant credentials or consent before bound passkey proof",
        async () => {
          const recovered = (await service.resolveActor(
            request("/get-session", undefined, recoverySessionCookie),
            "browser",
          ))!;
          assert.equal(recovered.authenticatedAt, 0);
          const stored = (
            await fixture.owner.query(
              "SELECT created_at,authenticated_at FROM rootset_control.sessions WHERE id=$1",
              [recovered.id],
            )
          ).rows[0];
          assert.ok(stored.created_at.getTime() > Date.now() - 10000);
          assert.equal(stored.authenticated_at.getTime(), 0);
          await service.execute("getProfile", recovered, {});
          const stepUp = (error: unknown) =>
            (error as { code?: string }).code === "STEP_UP_REQUIRED";
          const keyInput = {
            orgId: recovered.orgId,
            name: "Recovery integration",
          };
          const keyContext = { idempotencyKey: newId() };
          await assert.rejects(
            () =>
              service.execute(
                "createPersonalKey",
                recovered,
                keyInput,
                keyContext,
              ),
            stepUp,
          );
          await assert.rejects(
            () =>
              service.execute(
                "changePassword",
                recovered,
                { newPassword: randomBytes(32).toString("base64url") },
                { idempotencyKey: newId() },
              ),
            stepUp,
          );
          await assert.rejects(
            () =>
              service.execute(
                "changeEmail",
                recovered,
                { newEmail: `changed-${newId()}@example.test` },
                { idempotencyKey: newId() },
              ),
            stepUp,
          );
          for (const [path, body] of [
            ["/passkey/generate-register-options", undefined],
            ["/passkey/delete-passkey", { id: keyId }],
            ["/passkey/replace-recovery-codes", {}],
            ["/reauthenticate", { password }],
          ] as const)
            assert.equal(
              (await call(path, body, recoverySessionCookie)).status,
              403,
            );
          const ticket = (await service.execute(
            "beginAccountAction",
            recovered,
            {
              type: "create_key",
              operationId: "createPersonalKey",
              input: keyInput,
            },
            { idempotencyKey: newId() },
          )) as { id: string };
          await assert.rejects(
            () => service.approveAction(ticket.id, recovered),
            stepUp,
          );
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT approved_at FROM rootset_control.account_actions WHERE id=$1",
                [ticket.id],
              )
            ).rows[0].approved_at,
            null,
          );
          const oauth = new OAuthService(fixture.identity, {
            baseURL: origin,
            scopes: ["rows:read"],
            clients: [
              {
                client_id: "passkey-recovery-test",
                client_name: "Recovery test",
                redirect_uris: ["https://client.example/callback"],
              },
            ],
            resolveSession: (r) => service.resolveActor(r, "browser"),
            refreshActor: (a) => service.refreshActor(a),
          });
          const verifier = randomBytes(40).toString("base64url");
          const url = new URL(`${origin}/oauth/authorize`);
          url.search = new URLSearchParams({
            client_id: "passkey-recovery-test",
            redirect_uri: "https://client.example/callback",
            response_type: "code",
            code_challenge: createHash("sha256")
              .update(verifier)
              .digest("base64url"),
            code_challenge_method: "S256",
            resource: `${origin}/mcp`,
            scope: "rows:read",
            state: "recovery-proof",
          }).toString();
          const started = (await oauth.handler(
            new Request(url, { headers: { cookie: recoverySessionCookie } }),
          ))!;
          assert.equal(started.status, 302);
          const requestId = new URL(
            started.headers.get("location")!,
          ).searchParams.get("requestId")!;
          const endpoint = `${origin}/api/internal/v1/oauth/requests/${requestId}`;
          assert.equal(
            (await oauth.handler(
              new Request(endpoint, {
                headers: { cookie: recoverySessionCookie },
              }),
            ))!.status,
            200,
          );
          const decide = () =>
            oauth.handler(
              new Request(endpoint + "/decision", {
                method: "POST",
                headers: {
                  origin,
                  cookie: recoverySessionCookie,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ approve: true }),
              }),
            );
          const refused = (await decide())!;
          assert.equal(refused.status, 403);
          assert.equal((await refused.json()).error, "interaction_required");
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT count(*) FROM rootset_control.oauth_grants WHERE user_id=$1",
                [recovered.userId],
              )
            ).rows[0].count,
            "0",
          );
          await ok(await assertion(recoverySessionCookie));
          const refreshed = await service.refreshActor(recovered);
          assert.equal(refreshed.id, recovered.id);
          assert.ok(refreshed.authenticatedAt! > Date.now() - 10000);
          await service.approveAction(ticket.id, recovered);
          const created = (await service.execute(
            "completeAccountAction",
            recovered,
            { id: ticket.id },
            { idempotencyKey: newId() },
          )) as { result: { key: { id: string }; secret: string } };
          assert.ok(created.result.secret);
          const replay = (await service.execute(
            "completeAccountAction",
            recovered,
            { id: ticket.id },
            { idempotencyKey: newId() },
          )) as { result: { key: { id: string }; secret?: string } };
          assert.equal(replay.result.key.id, created.result.key.id);
          assert.equal(replay.result.secret, undefined);
          const allowed = (await decide())!;
          assert.equal(allowed.status, 200);
          assert.equal(
            (
              await fixture.owner.query(
                "SELECT count(*) FROM rootset_control.oauth_grants WHERE user_id=$1",
                [recovered.userId],
              )
            ).rows[0].count,
            "1",
          );
        },
      );
      await t.test(
        "proofs from a revoked session or another credential owner cannot refresh authority",
        async () => {
          const otherId = newId();
          await fixture.owner.query(
            `INSERT INTO rootset_control.users(id,name,email,email_verified) VALUES($1,'Other fixture',$2,true)`,
            [otherId, `${otherId.toLowerCase()}@example.test`],
          );
          const challenge = await options(
            "/generate-authenticate-options",
            sessionCookie,
          );
          await fixture.owner.query(
            `UPDATE rootset_control.auth_passkeys SET user_id=$2 WHERE id=$1`,
            [keyId, otherId],
          );
          try {
            assert.equal(
              (
                await call(
                  "/passkey/verify-authentication",
                  {
                    response: authenticator.authentication(
                      challenge.data.challenge,
                      origin,
                      ++counter,
                    ),
                  },
                  challenge.cookie,
                )
              ).ok,
              false,
            );
            assert.equal(
              (
                await call(
                  "/passkey/delete-passkey",
                  { id: keyId },
                  sessionCookie,
                )
              ).ok,
              false,
            );
            assert.equal(
              (
                await fixture.owner.query(
                  `SELECT user_id FROM rootset_control.auth_passkeys WHERE id=$1`,
                  [keyId],
                )
              ).rows[0].user_id,
              otherId,
            );
          } finally {
            await fixture.owner.query(
              `UPDATE rootset_control.auth_passkeys SET user_id=$2 WHERE id=$1`,
              [keyId, actor.userId],
            );
          }
          const session = responseCookies(await ok(await assertion("")));
          const signedActor = (await service.resolveActor(
            request("/get-session", undefined, session),
            "browser",
          ))!;
          const revoked = await options(
            "/generate-authenticate-options",
            session,
          );
          await fixture.owner.query(
            `DELETE FROM rootset_control.sessions WHERE id=$1`,
            [signedActor.id],
          );
          assert.equal(
            (
              await call(
                "/passkey/verify-authentication",
                {
                  response: authenticator.authentication(
                    revoked.data.challenge,
                    origin,
                    ++counter,
                  ),
                },
                revoked.cookie,
              )
            ).ok,
            false,
          );
          const pending = responseCookies(await ok(await signIn()));
          const bound = await options(
            "/generate-authenticate-options",
            pending,
          );
          await service.revokeAllUserAccess(actor.userId!, actor.id);
          assert.equal(
            (
              await call(
                "/passkey/verify-authentication",
                {
                  response: authenticator.authentication(
                    bound.data.challenge,
                    origin,
                    ++counter,
                  ),
                },
                bound.cookie,
              )
            ).ok,
            false,
          );
        },
      );
      await t.test(
        "first-key recovery persists across additions and disappears with the last key",
        async () => {
          const second = testAuthenticator();
          const challenge = await options(
            "/generate-register-options",
            sessionCookie,
          );
          const added = await ok(
            await call(
              "/passkey/verify-registration",
              {
                name: "Second key",
                response: second.registration(challenge.data.challenge, origin),
              },
              challenge.cookie,
            ),
          );
          const data = (await added.json()) as {
            id: string;
            recoveryCodes?: string[];
          };
          assert.equal(data.recoveryCodes, undefined);
          await ok(
            await call(
              "/passkey/delete-passkey",
              { id: data.id },
              sessionCookie,
            ),
          );
          assert.equal(
            (
              await fixture.owner.query(
                `SELECT count(*) FROM rootset_control.auth_recovery_codes WHERE user_id=$1`,
                [actor.userId],
              )
            ).rows[0].count,
            "1",
          );
          await ok(
            await call("/passkey/delete-passkey", { id: keyId }, sessionCookie),
          );
          assert.equal(
            (
              await fixture.owner.query(
                `SELECT count(*) FROM rootset_control.auth_recovery_codes WHERE user_id=$1`,
                [actor.userId],
              )
            ).rows[0].count,
            "0",
          );
          assert.equal(await passkeyStatus(), false);
          const signed = await ok(await signIn());
          assert.ok(
            await service.resolveActor(
              request("/get-session", undefined, responseCookies(signed)),
              "browser",
            ),
          );
        },
      );
      for (const issuance of ["replacement", "registration"] as const)
        await t.test(
          `last-key removal waits for ${issuance} recovery issuance and removes the codes`,
          async () => {
            await ok(
              await call("/reauthenticate", { password }, sessionCookie),
            );
            const key = testAuthenticator();
            const challenge = await options(
              "/generate-register-options",
              sessionCookie,
            );
            const register = () =>
              call(
                "/passkey/verify-registration",
                {
                  name: "Concurrent recovery key",
                  response: key.registration(challenge.data.challenge, origin),
                },
                challenge.cookie,
              );
            if (issuance === "replacement") await ok(await register());
            const lockId = randomBytes(4).readInt32BE();
            const barrier = await fixture.owner.connect();
            let pendingIssuance: Promise<Response> | undefined;
            let removal: Promise<Response> | undefined;
            try {
              await barrier.query(
                `CREATE FUNCTION rootset_control.pause_recovery_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lockId}); RETURN NEW; END $$`,
              );
              await barrier.query(
                `CREATE TRIGGER pause_recovery_insert BEFORE INSERT ON rootset_control.auth_recovery_codes FOR EACH ROW EXECUTE FUNCTION rootset_control.pause_recovery_insert()`,
              );
              await barrier.query("SELECT pg_advisory_lock($1::bigint)", [
                lockId,
              ]);
              const waitFor = async (ready: () => Promise<boolean>) => {
                const deadline = Date.now() + 5000;
                while (!(await ready())) {
                  assert.ok(
                    Date.now() < deadline,
                    "Concurrent request did not reach its database barrier",
                  );
                  await new Promise((resolve) => setTimeout(resolve, 10));
                }
              };
              pendingIssuance =
                issuance === "registration"
                  ? register()
                  : call("/passkey/replace-recovery-codes", {}, sessionCookie);
              await waitFor(async () =>
                Boolean(
                  (
                    await fixture.owner.query(
                      `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'INSERT INTO rootset_control.auth_recovery_codes%'`,
                    )
                  ).rowCount,
                ),
              );
              const { id } = (
                await fixture.owner.query(
                  "SELECT id FROM rootset_control.auth_passkeys WHERE user_id=$1",
                  [actor.userId],
                )
              ).rows[0] as { id: string };
              let removed = false;
              removal = call(
                "/passkey/delete-passkey",
                { id },
                sessionCookie,
              ).then((response) => {
                removed = true;
                return response;
              });
              await waitFor(
                async () =>
                  removed ||
                  Boolean(
                    (
                      await fixture.owner.query(
                        `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event<>'advisory'`,
                      )
                    ).rowCount,
                  ),
              );
              assert.equal(
                (
                  await fixture.owner.query(
                    "SELECT count(*) FROM rootset_control.auth_passkeys WHERE id=$1",
                    [id],
                  )
                ).rows[0].count,
                "1",
                "The last key must remain until the replacement commits",
              );
              await barrier.query("SELECT pg_advisory_unlock($1::bigint)", [
                lockId,
              ]);
              await ok(await pendingIssuance);
              await ok(await removal);
              assert.equal(
                (
                  await fixture.owner.query(
                    "SELECT count(*) FROM rootset_control.auth_recovery_codes WHERE user_id=$1",
                    [actor.userId],
                  )
                ).rows[0].count,
                "0",
              );
            } finally {
              await barrier.query("SELECT pg_advisory_unlock($1::bigint)", [
                lockId,
              ]);
              await Promise.allSettled(
                [pendingIssuance, removal].filter(Boolean),
              );
              await barrier.query(
                "DROP TRIGGER IF EXISTS pause_recovery_insert ON rootset_control.auth_recovery_codes",
              );
              await barrier.query(
                "DROP FUNCTION IF EXISTS rootset_control.pause_recovery_insert()",
              );
              barrier.release();
            }
          },
        );
    } finally {
      await fixture.close();
    }
  },
);
