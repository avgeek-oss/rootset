import type { ServerOptions } from "node:http";

export const httpServerOptions = {
  maxHeaderSize: 192 * 1024,
  headersTimeout: 15_000,
  requestTimeout: 660_000,
} satisfies ServerOptions;
