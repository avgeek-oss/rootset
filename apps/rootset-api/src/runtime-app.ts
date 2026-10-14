import release from "../../../package.json" with { type: "json" };
import {
  RootsetError,
  assertQueryLexemes,
  type QuerySpec,
} from "@rootset/contracts";
import { readSignal } from "@rootset/core";
import type { createRuntime } from "@rootset/core/runtime";
import { createApp } from "./app.js";

export function createRuntimeApp(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
) {
  return createApp({
    ...runtime,
    config: { ...runtime.config, version: release.version },
    windowQuery: async (actor, input, context) => {
      const request = input as {
        orgId: string;
        databaseId: string;
        tableId: string;
        query?: QuerySpec;
        position?: "first" | "middle" | "last" | number;
        sessionId?: string;
      };
      const authorised = await runtime.core.authorise(actor, "queryRows", {
        orgId: request.orgId,
        databaseId: request.databaseId,
        tableId: request.tableId,
        query: request.query ?? {},
      });
      const table = await runtime.storage.getTable(authorised, request.tableId);
      if (
        actor.orgId !== request.orgId ||
        table.databaseId !== request.databaseId
      )
        throw new RootsetError(
          "RESOURCE_NOT_FOUND",
          "Resource unavailable.",
          404,
        );
      assertQueryLexemes(
        table.fields,
        request.query ?? {},
        context.numericLexemes ?? [],
      );
      const window = await runtime.storage.queryWindow(
        authorised,
        request.tableId,
        request,
        { signal: readSignal(context) },
      );
      return {
        ...window.result,
        window: {
          sessionId: window.sessionId,
          start: window.position,
          total: window.totalRows,
          estimatedTotal: window.estimatedTotalRows,
          anchorsReady: window.anchorsReady,
        },
      };
    },
    downloadArtifact: (actor, id) => runtime.jobs.downloadArtifact(actor, id),
  });
}
