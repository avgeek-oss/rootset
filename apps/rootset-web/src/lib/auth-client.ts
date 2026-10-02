"use client";
import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  basePath: "/v1/auth",
  plugins: [twoFactorClient(), passkeyClient()],
});
