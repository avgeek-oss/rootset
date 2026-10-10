import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { request, type APIRequestContext } from "@playwright/test";
import type { BrowserDatabaseFixture } from "./browser-fixture";

const apiURL =
  process.env.ROOTSET_BROWSER_API_BASE_URL ?? "http://localhost:4310";

const root = resolve(import.meta.dirname, "../../../../..");
const baseURL = process.env.ROOTSET_BROWSER_BASE_URL ?? "http://localhost:4300";
const mailboxURL =
  process.env.ROOTSET_BROWSER_MAILBOX_URL ?? "http://localhost:59080";
const origin = new URL(baseURL).origin;
const fixtureRole = process.env.ROOTSET_BROWSER_FIXTURE_ROLE ?? "admin";
if (!["admin", "member", "viewer"].includes(fixtureRole))
  throw new Error(
    "Browser fixture invitation role must be admin, member or viewer.",
  );
const fixture = JSON.parse(
  readFileSync(
    process.env.ROOTSET_UI_FIXTURE_PATH ??
      resolve(root, "apps/rootset-web/test-results/browser/fixture.json"),
    "utf8",
  ),
) as BrowserDatabaseFixture;
const credentialsPath =
  process.env.ROOTSET_BROWSER_CREDENTIALS_PATH ??
  resolve(root, "apps/rootset-web/.env.cells-browser-test");

class ProvisionError extends Error {}

interface Credentials {
  ROOTSET_TEST_OWNER_EMAIL: string;
  ROOTSET_TEST_OWNER_PASSWORD: string;
}
interface Mailbox {
  messages: { ID: string; To: { Address: string }[] }[];
}

async function authenticate(
  context: APIRequestContext,
  credentials: Credentials,
): Promise<boolean> {
  const signedIn = await context.post(`${apiURL}/v1/auth/sign-in/email`, {
    data: {
      email: credentials.ROOTSET_TEST_OWNER_EMAIL,
      password: credentials.ROOTSET_TEST_OWNER_PASSWORD,
    },
  });
  if (!signedIn.ok()) return false;
  if ((await signedIn.json()).twoFactorRedirect)
    throw new ProvisionError(
      "The isolated browser account requires a second factor.",
    );
  return true;
}

async function findMailLink(
  email: string,
  path: RegExp,
  wait = true,
): Promise<URL | undefined> {
  const deadline = Date.now() + (wait ? 60_000 : 1);
  do {
    const mailboxResponse = await fetch(`${mailboxURL}/api/v1/messages`);
    if (!mailboxResponse.ok)
      throw new ProvisionError(
        `The test mailbox returned ${mailboxResponse.status}.`,
      );
    const mailbox = (await mailboxResponse.json()) as Mailbox;
    for (const message of mailbox.messages.filter((message) =>
      message.To.some((recipient) => recipient.Address === email),
    )) {
      const response = await fetch(
        `${mailboxURL}/api/v1/message/${encodeURIComponent(message.ID)}`,
      );
      if (!response.ok)
        throw new ProvisionError(
          `The test message endpoint returned ${response.status}.`,
        );
      const body = (await response.json()) as { HTML?: string; Text?: string };
      const links =
        `${body.HTML ?? ""}\n${body.Text ?? ""}`.match(
          /https?:\/\/[^\s"<>]+/g,
        ) ?? [];
      for (const link of links) {
        const url = new URL(link.replaceAll("&amp;", "&"));
        if (url.origin === origin && path.test(url.pathname)) return url;
      }
    }
    if (wait) await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  if (wait)
    throw new ProvisionError(
      "The expected account email did not arrive within 60 seconds.",
    );
}

async function findVerificationCode(email: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  do {
    const response = await fetch(`${mailboxURL}/api/v1/messages`);
    if (!response.ok)
      throw new ProvisionError(`The test mailbox returned ${response.status}.`);
    const mailbox = (await response.json()) as Mailbox;
    for (const message of mailbox.messages.filter((item) =>
      item.To.some((recipient) => recipient.Address === email),
    )) {
      const response = await fetch(
        `${mailboxURL}/api/v1/message/${encodeURIComponent(message.ID)}`,
      );
      if (!response.ok)
        throw new ProvisionError(
          `The test message endpoint returned ${response.status}.`,
        );
      const body = (await response.json()) as { HTML?: string; Text?: string };
      const code = `${body.Text ?? ""}\n${body.HTML ?? ""}`.match(
        /Your verification code is (\d{6})\b/,
      )?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  throw new ProvisionError(
    "The invitation verification email did not arrive within 60 seconds.",
  );
}

async function assertInstallationContext(
  context: APIRequestContext,
): Promise<void> {
  const response = await context.get(`${apiURL}/api/internal/v1/context`);
  if (!response.ok())
    throw new ProvisionError(
      `The isolated account could not enter the fixture installation (${response.status()}).`,
    );
}

async function main() {
  const own = await request.newContext({
    extraHTTPHeaders: { Origin: origin },
  });
  const inviter = await request.newContext({
    extraHTTPHeaders: { Origin: origin },
  });
  let credentials: Credentials;
  try {
    if (existsSync(credentialsPath)) {
      const stored = parseEnv(readFileSync(credentialsPath, "utf8"));
      if (
        !stored.ROOTSET_TEST_OWNER_EMAIL ||
        !stored.ROOTSET_TEST_OWNER_PASSWORD
      )
        throw new ProvisionError(
          "The isolated account credentials file is incomplete.",
        );
      credentials = {
        ROOTSET_TEST_OWNER_EMAIL: stored.ROOTSET_TEST_OWNER_EMAIL,
        ROOTSET_TEST_OWNER_PASSWORD: stored.ROOTSET_TEST_OWNER_PASSWORD,
      };
      chmodSync(credentialsPath, 0o600);
      if (await authenticate(own, credentials)) {
        await assertInstallationContext(own);
        console.log("The separate verified browser account is ready.");
        return;
      }
    } else {
      credentials = {
        ROOTSET_TEST_OWNER_EMAIL: `rootset-cells-${randomUUID().slice(0, 8)}@example.test`,
        ROOTSET_TEST_OWNER_PASSWORD: `Rootset verification ${randomBytes(32).toString("base64url")}`,
      };
      writeFileSync(
        credentialsPath,
        Object.entries(credentials)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
        { mode: 0o600, flag: "wx" },
      );
    }
    let invitation = await findMailLink(
      credentials.ROOTSET_TEST_OWNER_EMAIL,
      /^\/invite\/[A-Za-z0-9]{26}$/,
      false,
    );
    if (!invitation) {
      const stored = parseEnv(
        readFileSync(
          process.env.ROOTSET_BROWSER_ADMIN_CREDENTIALS_PATH ??
            resolve(root, "apps/rootset-web/.env.browser-test"),
          "utf8",
        ),
      );
      if (
        !stored.ROOTSET_TEST_OWNER_EMAIL ||
        !stored.ROOTSET_TEST_OWNER_PASSWORD
      )
        throw new ProvisionError(
          "Verified fixture admin credentials are required to invite the isolated account.",
        );
      if (
        !(await authenticate(inviter, {
          ROOTSET_TEST_OWNER_EMAIL: stored.ROOTSET_TEST_OWNER_EMAIL,
          ROOTSET_TEST_OWNER_PASSWORD: stored.ROOTSET_TEST_OWNER_PASSWORD,
        }))
      )
        throw new ProvisionError(
          "The verified fixture admin could not sign in.",
        );
      await assertInstallationContext(inviter);
      const pending = await inviter.get(
        `${apiURL}/api/internal/v1/orgs/${fixture.orgId}/invitations`,
      );
      if (!pending.ok())
        throw new ProvisionError(
          `The invitation listing endpoint returned ${pending.status()}.`,
        );
      const listing = (await pending.json()) as {
        data: { email: string; state: string }[];
      };
      if (
        !listing.data.some(
          (item) =>
            item.email === credentials.ROOTSET_TEST_OWNER_EMAIL &&
            item.state === "pending",
        )
      ) {
        const response = await inviter.post(
          `${apiURL}/api/internal/v1/orgs/${fixture.orgId}/invitations`,
          {
            headers: { "Idempotency-Key": randomUUID() },
            data: {
              email: credentials.ROOTSET_TEST_OWNER_EMAIL,
              role: fixtureRole,
            },
          },
        );
        if (!response.ok())
          throw new ProvisionError(
            `The real invitation endpoint returned ${response.status()}.`,
          );
      }
      invitation = await findMailLink(
        credentials.ROOTSET_TEST_OWNER_EMAIL,
        /^\/invite\/[A-Za-z0-9]{26}$/,
      );
    }
    if (!invitation)
      throw new ProvisionError("The invitation link is missing.");
    const id = invitation.pathname.split("/").at(-1);
    const begun = await own.post(`${apiURL}/v1/auth/invitations/${id}/verify`, {
      data: {},
    });
    if (!begun.ok())
      throw new ProvisionError(
        `The invitation verification endpoint returned ${begun.status()}.`,
      );
    if ((await begun.json()).existingAccount)
      throw new ProvisionError(
        "The isolated account exists but could not sign in with its retained fixture credentials.",
      );
    const code = await findVerificationCode(
      credentials.ROOTSET_TEST_OWNER_EMAIL,
    );
    const proof = await own.post(`${apiURL}/v1/auth/invitations/${id}/code`, {
      data: { name: "Cell editor verification", code },
    });
    if (!proof.ok())
      throw new ProvisionError(
        `The invitation email proof endpoint returned ${proof.status()}.`,
      );
    const { setupToken } = (await proof.json()) as { setupToken: string };
    const accepted = await own.post(
      `${apiURL}/v1/auth/invitations/${id}/signup`,
      {
        data: { setupToken, password: credentials.ROOTSET_TEST_OWNER_PASSWORD },
      },
    );
    if (!accepted.ok())
      throw new ProvisionError(
        `The invitation password setup endpoint returned ${accepted.status()}.`,
      );
    await assertInstallationContext(own);
    console.log(
      "The separate browser account was invited, email verified, and accepted through the real application endpoints.",
    );
  } finally {
    await own.dispose();
    await inviter.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof ProvisionError
      ? error.message
      : error instanceof Error
        ? error.name +
          ": " +
          (error.message.split("\n")[0] ?? error.name)
            .replace(/https?:\/\/\S+/g, "[redacted URL]")
            .replace(/[A-Za-z0-9_-]{43,}/g, "[redacted token]")
        : "Account provisioning failed",
  );
  process.exitCode = 1;
});
