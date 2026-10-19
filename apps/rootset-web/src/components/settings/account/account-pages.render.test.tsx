import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ProfileSettings,
  EmailPasswordSettings,
  SessionSettings,
} from "./settings-pages";
import { PasskeySettings } from "./passkey-settings";
import { ApiMcpSettings } from "./api-mcp-settings";

const fixture = vi.hoisted(() => ({ enabled: false, pending: false }));
vi.mock("./adapter", () => ({
  useAccess: () => ({
    user: {
      email: "person@example.test",
      emailVerified: true,
      name: "Example Person",
      twoFactorEnabled: fixture.enabled,
      workspaceRole: "admin",
    },
  }),
  useApiQuery: (path: string) => ({
    data:
      path === "/v1/core/profile"
        ? { user: { email: "person@example.test", name: "Example Person" } }
        : path === "/v1/core/profile/passkeys"
          ? { passkeys: [] }
          : path === "/v1/core/sessions"
            ? {
                currentSessionId: "current-session",
                sessions: [
                  {
                    id: "current-session",
                    lastSeenAt: "2026-10-05T10:00:00.000Z",
                    expiresAt: "2026-10-06T10:00:00.000Z",
                  },
                ],
              }
            : path === "/v1/core/profile/email-change"
              ? {
                  pending: fixture.pending
                    ? {
                        email: "new@example.test",
                        expiresAt: "2026-10-05T11:00:00.000Z",
                      }
                    : null,
                }
              : { keys: [], mcpUrl: "https://rootset.example/mcp" },
    refresh() {},
  }),
  api: { post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
  refreshApiQueries() {},
  useDateDisplay: () => () => "2026-10-05",
  registerPasskey: vi.fn(),
  passkeyError: () => "Failed",
}));
vi.mock("./last-synced-time", () => ({
  RelativeTime: ({ value }: { value: string }) =>
    createElement("time", {}, value),
}));
const render = (component: () => React.ReactNode) =>
  renderToStaticMarkup(createElement(component));
beforeEach(() => {
  fixture.enabled = false;
  fixture.pending = false;
});

describe("Towbar account component parity", () => {
  it("uses the current shared name-only profile and keeps email/password separate", () => {
    const profile = render(ProfileSettings);
    expect(profile).not.toContain("Appearance");
    expect(profile).not.toContain("Gravatar Image");
    expect(profile).not.toContain("Click the image to update it on Gravatar.");
    expect(profile).toContain("Profile details");
    expect(profile).toContain("Your Name");
    expect(profile).not.toContain("Current email");
    expect(profile).not.toContain("Change password");
    const security = render(EmailPasswordSettings);
    expect(security).toContain("Email address");
    expect(security).toContain("Verified");
    expect(security).toContain("New email address");
    expect(security).toContain("Confirm new password");
    expect([...security.matchAll(/autoComplete="new-password"/g)]).toHaveLength(
      2,
    );
  });
  it("shows a pending email change with cancellation and unchanged sign-in copy", () => {
    fixture.pending = true;
    const html = render(EmailPasswordSettings);
    expect(html).toContain("new@example.test");
    expect(html).toContain("Cancel email change");
    expect(html).not.toContain("email changes only after you confirm it.");
  });
  it("uses the shared passkey page without authenticator enrollment", () => {
    const html = render(PasskeySettings);
    expect(html).toContain("Add passkey");
    expect(html).toContain("No passkeys added");
    expect(html).not.toContain("Authenticator app");
    expect(html).not.toContain("Set up authenticator");
    expect(html).not.toContain("Delete account");
  });
  it("prevents revoking the current browser session", () => {
    const html = render(SessionSettings);
    expect(html).toContain("This browser");
    expect(html).toContain("current-session");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*?Revoke/s);
  });
  it("separates API keys and MCP connections without team keys", () => {
    const html = render(() =>
      createElement(ApiMcpSettings, { section: "personal-keys" }),
    );
    expect(html).toContain("No API keys yet");
    expect(html).not.toContain("MCP Connections");
    const connections = render(() =>
      createElement(ApiMcpSettings, { section: "mcp-connections" }),
    );
    expect(connections).toContain("No MCP connections yet");
    expect(connections).not.toContain("Create API key");
    expect(html).not.toContain("Team keys");
  });
  it("uses the configured Rootset MCP endpoint without manual credentials", () => {
    const html = render(() =>
      createElement(ApiMcpSettings, { section: "mcp" }),
    );
    expect(html).toContain("Connect your MCP client");
    expect(html).toContain("~/.codex/config.toml");
    expect(html).toContain("https://rootset.example/mcp");
    expect(html).not.toContain("ROOTSET_API_KEY");
    expect(html).not.toContain("bearer_token_env_var");
    expect(html).toContain("https://www.rootset.app/mcp-connections");
    expect(html).not.toContain("TOWBAR_API_KEY");
  });
});
