import { describe, expect, it } from "vitest";
import { mcpClientConfigurations } from "./mcp-client-configurations";

const url = "https://rootset-api.example.test/mcp";
const configurations = mcpClientConfigurations(url);

describe("MCP client OAuth configuration", () => {
  it.each(configurations)(
    "connects $label without manual credentials",
    (config) => {
      expect(config.code).toContain(url);
      expect(config.code).not.toMatch(
        /bearer|token|api.?key|header|promptString/i,
      );
    },
  );

  it("uses native remote-server configuration for each supported client", () => {
    const code = (id: string) =>
      configurations.find((config) => config.id === id)!.code;
    expect(code("codex")).toBe(`[mcp_servers.rootset]\nurl = "${url}"`);
    expect(JSON.parse(code("cursor"))).toEqual({
      mcpServers: { rootset: { url } },
    });
    expect(JSON.parse(code("vscode"))).toEqual({
      servers: { rootset: { type: "http", url } },
    });
    expect(code("claude")).toBe(
      `claude mcp add --transport http rootset '${url}'`,
    );
    expect(code("other")).toContain("Authentication: OAuth");
  });
});
