// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ActivityDetails } from "@rootset/contracts";
import { client } from "@rootset/web-client";
import { AuditEventDetails } from "./audit-event-details";

vi.mock("@rootset/web-client", () => ({ client: { operation: vi.fn() } }));
vi.mock("./dialog", () => ({
  Dialog: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", { role: "dialog", "aria-label": title }, children),
}));
vi.mock("./audit-log-error", () => ({
  AuditLogError: ({ message }: { message: string }) =>
    createElement("p", { role: "alert" }, message),
}));
const eventId = "r:12";
const details: ActivityDetails = {
  event: "fields.reorder",
  occurredAt: "2026-10-18T00:00:00.000Z",
  actor: "User",
  resource: null,
  context: {
    fieldOrder: { before: ["FIRST", "SECOND"], after: ["SECOND", "FIRST"] },
  },
};
let host: HTMLDivElement, root: Root, queryClient: QueryClient;
// The editor is a lazily imported module. Load it once up front so each test
// waits on component state rather than on module loading, and no test relies
// on an earlier one having resolved the lazy import.
beforeAll(async () => {
  await import("./json-editor");
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});
async function render(value = eventId) {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AuditEventDetails, {
          orgId: "org",
          eventId: value,
          onClose: vi.fn(),
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
it("loads only the chosen event and displays selectable, read-only JSON", async () => {
  vi.mocked(client.operation).mockResolvedValue(details);
  await render();
  await vi.waitFor(async () => {
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(host.querySelector(".cm-editor")).not.toBeNull();
  });
  expect(client.operation).toHaveBeenCalledWith(
    "getActivityDetails",
    { orgId: "org", eventId: "r:12" },
    { signal: expect.any(AbortSignal) },
  );
  const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
  expect(JSON.parse(editor.state.doc.toString())).toEqual(details.context);
  expect(editor.contentDOM.getAttribute("aria-readonly")).toBe("true");
  expect(editor.state.facet(EditorState.readOnly)).toBe(true);
  expect(editor.state.facet(EditorView.editable)).toBe(false);
  expect(editor.contentDOM.tabIndex).toBe(0);
});
it("clears the previous event JSON while loading another event and aborts when closed", async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(client.operation)
    .mockResolvedValueOnce(details)
    .mockImplementationOnce((_id, _input, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    });
  await render();
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.querySelector(".cm-editor")).not.toBeNull();
  });
  await render("r:13");
  expect(host.querySelector(".cm-editor")).toBeNull();
  await vi.waitFor(() => expect(signal).toBeDefined());
  expect(signal?.aborted).toBe(false);
  act(() => root.render(null));
  expect(signal?.aborted).toBe(true);
});
it("shows a compact error instead of putting raw response errors in the dialog", async () => {
  vi.mocked(client.operation).mockRejectedValue(
    new Error("private-provider-message".repeat(1000)),
  );
  await render();
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(host.textContent).toContain("Event details could not be loaded.");
  });
  expect(host.textContent).not.toContain("private-provider-message");
  expect(host.querySelector(".cm-editor")).toBeNull();
});
