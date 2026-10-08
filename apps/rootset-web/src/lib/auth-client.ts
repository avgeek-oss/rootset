"use client";
import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import { browserApiOrigin } from "@rootset/web-client";

export const authClient = createAuthClient({
  baseURL: browserApiOrigin() || undefined,
  basePath: "/v1/auth",
  fetchOptions: { credentials: "include" },
  plugins: [passkeyClient()],
});
