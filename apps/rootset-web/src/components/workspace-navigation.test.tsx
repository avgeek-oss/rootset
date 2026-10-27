// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentWorkspaceId, selectWorkspace } from "@rootset/web-client";
import { PageNavigation, usePageQuery } from "./page-navigation";
import {
  useCommittedWorkspace,
  useSwitchWorkspace,
} from "./workspace-navigation";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const defaultId = "01M5AYQWAH3WSJR00JVB2ABMXF";
const operationsId = "01M5AYSRK82ZHX9G8K6ASV5QXG";

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
let switchWorkspace: (id: string) => void;
let pending: ReturnType<typeof deferred>;

function WorkspacePage({ location }: { location: string }) {
  const id = new URL(location, "http://rootset.test").searchParams.get(
    "workspaceId",
  )!;
  const data = usePageQuery({
    queryKey: ["databases", id],
    queryFn: () => pending.promise,
  });
  useCommittedWorkspace(id);
  return (
    <main>
      <h1>{id}</h1>
      <p>{data.data}</p>
      <input defaultValue="Existing draft" />
    </main>
  );
}

function Application() {
  const [location, setLocation] = useState(
    `/databases?workspaceId=${defaultId}`,
  );
  router.push.mockImplementation(setLocation);
  switchWorkspace = useSwitchWorkspace();
  return (
    <PageNavigation location={location}>
      {(displayed) => <WorkspacePage location={displayed} />}
    </PageNavigation>
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.sessionStorage.clear();
  selectWorkspace(defaultId);
  pending = deferred();
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  cache.setQueryData(["databases", defaultId], "Default databases");
  cache.setQueryData(["workspaces", "team"], [defaultId, operationsId]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <Application />
      </QueryClientProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  container.remove();
  window.sessionStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the current screen and request scope until the selected workspace is ready", async () => {
  const input = container.querySelector("input")!;
  input.value = "Unsaved draft";
  await act(async () => switchWorkspace(operationsId));
  expect(router.push).toHaveBeenCalledWith(
    `/databases?workspaceId=${operationsId}`,
  );
  expect(currentWorkspaceId()).toBe(defaultId);
  expect(container.textContent).toContain("Default databases");
  expect(container.textContent).not.toContain("Loading Rootset");
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("Unsaved draft");
  expect(cache.getQueryState(["workspaces", "team"])?.isInvalidated).toBe(true);

  await act(async () => pending.resolve("Operations databases"));
  expect(currentWorkspaceId()).toBe(operationsId);
  expect(container.textContent).toContain("Operations databases");
  expect(container.textContent).not.toContain("Default databases");
  expect(cache.getQueryData(["databases", defaultId])).toBe(
    "Default databases",
  );
});

it("does not commit an abandoned workspace switch", async () => {
  await act(async () => switchWorkspace(operationsId));
  await act(async () => switchWorkspace(defaultId));
  await act(async () => pending.resolve("Operations databases"));
  expect(currentWorkspaceId()).toBe(defaultId);
  expect(container.textContent).toContain("Default databases");
  expect(container.textContent).not.toContain("Operations databases");
});
