import type { McpClientConfiguration } from "@avgeek-oss/design-system";

export function mcpClientConfigurations(url: string): McpClientConfiguration[] {
  return [
    {
      id: "codex",
      label: "Codex",
      filename: "~/.codex/config.toml",
      code: `[mcp_servers.rootset]\nurl = ${JSON.stringify(url)}`,
    },
    {
      id: "cursor",
      label: "Cursor",
      filename: ".cursor/mcp.json",
      code: JSON.stringify({ mcpServers: { rootset: { url } } }, null, 2),
    },
    {
      id: "vscode",
      label: "VS Code",
      filename: ".vscode/mcp.json",
      code: JSON.stringify(
        { servers: { rootset: { type: "http", url } } },
        null,
        2,
      ),
    },
    {
      id: "claude",
      label: "Claude Code",
      filename: "Claude Code",
      code: `claude mcp add --transport http rootset '${url}'`,
    },
    {
      id: "other",
      label: "Other clients",
      filename: "Connection details",
      code: `Transport: Streamable HTTP\nURL: ${url}\nAuthentication: OAuth`,
    },
  ];
}
