// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RootsetErrorBoundary } from "./rootset-error-state";

it("shows a recoverable error state without exposing render errors and retries the page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let fail = true;
  function Page() {
    if (fail) throw new Error("Private diagnostic details");
    return <p>Page recovered</p>;
  }
  try {
    await act(async () =>
      root.render(
        <RootsetErrorBoundary>
          <Page />
        </RootsetErrorBoundary>,
      ),
    );
    expect(container.textContent).toContain("This page could not be loaded");
    expect(container.textContent).not.toContain("Private diagnostic details");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/mascot/elephant-sad.webp",
    );
    fail = false;
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Try again"),
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(container.textContent).toBe("Page recovered");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    log.mockRestore();
    vi.unstubAllGlobals();
  }
});
