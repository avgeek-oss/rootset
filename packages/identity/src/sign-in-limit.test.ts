import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { newId } from "@rootset/contracts";
import { createIdentityService, type IdentityService } from "./index";
import { isolatedDatabase } from "../../../tools/verification/isolated-database";

const ownerURL = process.env.ROOTSET_TEST_DATABASE_URL;
const identityURL =
  process.env.ROOTSET_TEST_DATABASE_URL ?? process.env.ROOTSET_DATABASE_URL;
const baseURL = "http://localhost:6300";

function signIn(
  service: IdentityService,
  email: string,
  password: string,
  address: string,
): Promise<Response> {
  return service.auth.handler(
    new Request(`${baseURL}/v1/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: baseURL,
        "content-type": "application/json",
        "x-rootset-client-address": address,
      },
      body: JSON.stringify({ email, password }),
    }),
  );
}
// Each attempt comes from a new address, so only the account limit applies.
let addressCounter = 0;
const nextAddress = () => `198.51.100.${++addressCounter}`;

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error;
}

test(
  "password sign-in is limited per account across addresses and a success clears the count",
  { skip: !ownerURL || !identityURL },
  async () => {
    const fixture = await isolatedDatabase();
    const config = {
      pool: fixture.identity,
      baseURL,
      secret: randomBytes(32).toString("hex"),
      bootstrapSecret: randomBytes(32).toString("hex"),
      keyHashSecret: randomBytes(32).toString("hex"),
      encryptionKey: randomBytes(32).toString("base64"),
    };
    const service = createIdentityService(config);
    const email = `limit-${newId().toLowerCase()}@example.test`;
    const password = randomBytes(32).toString("base64url");
    const wrong = `${password}-wrong`;
    try {
      await service.claimSetup({
        bootstrapSecret: config.bootstrapSecret,
        name: "Sign-in limit fixture",
        email,
        password,
        organisationName: "Disposable sign-in limit fixture",
      });

      // Nine failures, then a success, clear the count.
      for (let attempt = 0; attempt < 9; attempt++)
        assert.equal(
          (await signIn(service, email, wrong, nextAddress())).status,
          401,
        );
      assert.equal(
        (await signIn(service, email, password, nextAddress())).status,
        200,
      );

      // Ten failures from ten addresses are refused normally; the eleventh
      // attempt is limited, even with the right password, and the email is
      // matched after trimming and lower-casing.
      for (let attempt = 0; attempt < 10; attempt++)
        assert.equal(
          (await signIn(service, email, wrong, nextAddress())).status,
          401,
        );
      const limited = await signIn(
        service,
        ` ${email.toUpperCase()} `,
        password,
        nextAddress(),
      );
      assert.equal(limited.status, 429);
      assert.equal((await errorOf(limited)).code, "RATE_LIMITED");

      // An unknown account gets the same refusal after the same number of
      // attempts, so the limit does not reveal whether an account exists.
      const unknown = `missing-${newId().toLowerCase()}@example.test`;
      for (let attempt = 0; attempt < 10; attempt++)
        assert.equal(
          (await signIn(service, unknown, wrong, nextAddress())).status,
          401,
        );
      const unknownLimited = await signIn(
        service,
        unknown,
        wrong,
        nextAddress(),
      );
      assert.equal(unknownLimited.status, 429);
      assert.deepEqual(
        await errorOf(unknownLimited),
        await errorOf(await signIn(service, email, wrong, nextAddress())),
      );

      // Once the window has passed, the account can sign in again.
      await fixture.owner.query(
        `UPDATE rootset_control.identity_rate_limits SET expires_at=now()-interval '1 second'`,
      );
      assert.equal(
        (await signIn(service, email, password, nextAddress())).status,
        200,
      );
    } finally {
      await fixture.close();
    }
  },
);
