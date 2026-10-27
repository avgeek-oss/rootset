import { toolMap } from "@rootset/contracts";

/** Legacy transport fixtures operate on Default. Production transports never infer this ID. */
export const defaultWorkspaceFetch: typeof fetch = (input, init) => {
  if (typeof input !== "string" && !(input instanceof URL))
    return fetch(input, init);
  const url = new URL(input);
  const organisation = url.pathname.match(
    /\/orgs\/([^/]+)\/(?:databases|jobs|artifacts|activity|backups|workspace-keys|mutations)(?:\/|$)/,
  )?.[1];
  const options = { ...init };
  const method = options.method ?? "GET";
  if (organisation && method === "GET" && !url.searchParams.has("workspaceId"))
    url.searchParams.set("workspaceId", organisation);
  if (typeof options.body === "string") {
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(options.body) as Record<string, unknown>;
    } catch {
      /* Malformed-input fixtures must reach the decoder unchanged. */
    }
    if (body && typeof body === "object" && !Array.isArray(body)) {
      if (organisation && body.workspaceId === undefined)
        options.body = Object.keys(body).length
          ? options.body.replace(
              /^(\s*)\{/,
              `$1{"workspaceId":${JSON.stringify(organisation)},`,
            )
          : JSON.stringify({ workspaceId: organisation });
      if (url.pathname === "/mcp" && body.method === "tools/call") {
        const params = body.params as
          { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (
          params?.name &&
          toolMap[params.name]?.workspaceScoped &&
          params.arguments?.workspaceId === undefined &&
          typeof params.arguments?.orgId === "string"
        )
          options.body = options.body.replace(
            /("arguments"\s*:\s*\{)/,
            `$1"workspaceId":${JSON.stringify(params.arguments.orgId)},`,
          );
      }
    }
  }
  return fetch(url, options);
};

export function defaultWorkspaceToolCall<
  T extends { name: string; arguments?: Record<string, unknown> },
>(parameters: T, workspaceId: string): T {
  return toolMap[parameters.name]?.workspaceScoped
    ? { ...parameters, arguments: { workspaceId, ...parameters.arguments } }
    : parameters;
}
