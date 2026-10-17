// @vitest-environment happy-dom

import { act, lazy, startTransition, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageNavigation, usePageQuery } from "./page-navigation";
import { useResource } from "./settings/api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

describe("page navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let cache: QueryClient;
  let navigate: (location: string) => void;
  const requests = new Map<string, ReturnType<typeof deferred<string>>>();
  const commits: string[] = [];

  function Page({ location }: { location: string }) {
    const primary = usePageQuery(
      {
        queryKey: ["page", location],
        queryFn: () => requests.get(location)!.promise,
        gcTime: 0,
      },
      { fresh: location === "records" },
    );
    const secondary = useResource<string | null>(
      primary.data === "needs details" ? `/details/${location}` : undefined,
      null,
      () => requests.get(`${location}/details`)!.promise,
    );
    if (primary.error) return <p role="alert">Could not load {location}</p>;
    if (primary.isPending || secondary.loading) return <p>Empty page</p>;
    return (
      <main
        ref={(element) => {
          if (element) commits.push(location);
        }}
      >
        <h1>{location}</h1>
        <p>{secondary.data ?? primary.data}</p>
        <input aria-label="Unsaved draft" defaultValue="Keep my draft" />
      </main>
    );
  }

  function App() {
    const [location, setLocation] = useState("databases");
    navigate = setLocation;
    return (
      <QueryClientProvider client={cache}>
        <PageNavigation location={location}>
          {(displayed) => <Page key={displayed} location={displayed} />}
        </PageNavigation>
      </QueryClientProvider>
    );
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    cache = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    cache.setQueryData(["page", "databases"], "Existing database cards");
    requests.clear();
    commits.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    cache.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps the existing page and draft mounted until all destination reads finish", async () => {
    const table = deferred<string>();
    const details = deferred<string>();
    requests.set("table", table);
    requests.set("table/details", details);
    const input = container.querySelector("input")!;
    input.value = "Unsaved changes";

    await act(async () => navigate("table"));
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    expect(container.querySelector("input")).toBe(input);
    expect(container.textContent).not.toContain("Empty page");

    await act(async () => table.resolve("needs details"));
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    expect(container.querySelector("input")?.value).toBe("Unsaved changes");
    expect(commits).not.toContain("table");

    await act(async () => details.resolve("Loaded table records"));
    expect(container.querySelector("h1")?.textContent).toBe("table");
    expect(container.textContent).toContain("Loaded table records");
    expect(container.textContent).not.toContain("Empty page");
  });

  it("only commits the latest navigation when requests resolve out of order", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    requests.set("backup schedule", slow);
    requests.set("audit logs", fast);
    await act(async () => navigate("backup schedule"));
    await act(async () => navigate("audit logs"));
    await act(async () => fast.resolve("Audit events"));
    expect(container.querySelector("h1")?.textContent).toBe("audit logs");
    await act(async () => slow.resolve("Old destination"));
    expect(container.querySelector("h1")?.textContent).toBe("audit logs");
    expect(commits).not.toContain("backup schedule");
  });

  it("returns immediately to a cached page, including browser-style back navigation", async () => {
    const pending = deferred<string>();
    requests.set("fields", pending);
    await act(async () => navigate("fields"));
    await act(async () => pending.resolve("Three fields"));
    await act(async () => navigate("databases"));
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    expect(container.textContent).toContain("Existing database cards");
    await act(async () => navigate("fields"));
    expect(container.textContent).toContain("Three fields");
    expect(container.textContent).not.toContain("Empty page");
  });

  it("releases a failed navigation to the destination error UI without retry loops", async () => {
    const pending = deferred<string>();
    requests.set("exports", pending);
    await act(async () => navigate("exports"));
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    await act(async () => pending.reject(new Error("Connection lost")));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not load exports",
    );
    expect(container.textContent).not.toContain("Empty page");
    await act(async () => navigate("databases"));
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    const recovered = deferred<string>();
    requests.set("exports", recovered);
    await act(async () => navigate("exports"));
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    await act(async () => recovered.resolve("Exports available again"));
    expect(container.textContent).toContain("Exports available again");
  });

  it("waits for a fresh row read even when a previous window is cached", async () => {
    cache.setQueryData(["page", "records"], "Previous records");
    const pending = deferred<string>();
    requests.set("records", pending);
    await act(async () => startTransition(() => navigate("records")));
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    expect(container.textContent).not.toContain("Previous records");
    await act(async () => pending.resolve("Current records"));
    expect(container.querySelector("h1")?.textContent).toBe("records");
    expect(container.textContent).toContain("Current records");
  });

  it("waits for lazy destination code as well as its data", async () => {
    const bundle = deferred<{ default: typeof Page }>();
    const Destination = lazy(() => bundle.promise);
    const pending = deferred<string>();
    requests.set("members", pending);
    const render = (location: string) =>
      root.render(
        <QueryClientProvider client={cache}>
          <PageNavigation location={location}>
            {(displayed) =>
              displayed === "members" ? (
                <Destination location={displayed} />
              ) : (
                <Page location={displayed} />
              )
            }
          </PageNavigation>
        </QueryClientProvider>,
      );
    await act(async () => render("databases"));
    await act(async () => render("members"));
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    await act(async () => bundle.resolve({ default: Page }));
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    await act(async () => pending.resolve("Team members"));
    expect(container.querySelector("h1")?.textContent).toBe("members");
    expect(container.textContent).toContain("Team members");
  });

  it("refreshes expired destination data before switching pages", async () => {
    cache.setQueryDefaults(["page", "expired"], { staleTime: 0 });
    cache.setQueryData(["page", "expired"], "Old data");
    const pending = deferred<string>();
    requests.set("expired", pending);
    await act(async () => startTransition(() => navigate("expired")));
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    await act(async () => pending.resolve("Updated destination"));
    expect(container.querySelector("h1")?.textContent).toBe("expired");
    expect(container.textContent).toContain("Updated destination");
  });

  it("keeps a committed page visible during background refreshes", async () => {
    const pending = deferred<string>();
    requests.set("databases", pending);
    let refresh: Promise<void>;
    await act(async () => {
      refresh = cache.refetchQueries({ queryKey: ["page", "databases"] });
    });
    expect(container.querySelector("h1")?.textContent).toBe("databases");
    expect(container.textContent).toContain("Existing database cards");
    expect(container.textContent).not.toContain("Empty page");
    await act(async () => {
      pending.resolve("Updated database cards");
      await refresh;
      // React Query batches mounted-observer notifications in the next task.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Updated database cards");
  });
});
