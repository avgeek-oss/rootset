import { operations } from "@rootset/contracts";

export function resolveSettingsOperation(
  path: string,
  method: string,
  body?: unknown,
): { operationId: string; input: Record<string, unknown> } | undefined {
  if (path.includes("?")) return undefined;
  for (const operation of operations) {
    if (operation.httpMethod !== method) continue;
    const names: string[] = [];
    const expression = operation.path
      .replace(/^\/v1/, "")
      .split("/")
      .map((segment) => {
        const parameter = /^\{([^}]+)\}$/.exec(segment);
        if (parameter) {
          names.push(parameter[1]!);
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    const match = new RegExp(`^${expression}$`).exec(path);
    if (!match) continue;
    const input: Record<string, unknown> =
      typeof body === "object" && body !== null
        ? { ...(body as Record<string, unknown>) }
        : {};
    names.forEach((name, index) => {
      input[name] = decodeURIComponent(match[index + 1]!);
    });
    return {
      operationId: operation.id,
      input: operation.inputSchema.parse(input) as Record<string, unknown>,
    };
  }
  return undefined;
}
