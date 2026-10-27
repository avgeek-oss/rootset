// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceAccessSettings } from "./workspaces";

const fixture = vi.hoisted(() => ({
  operation: vi.fn(),
  refetch: vi.fn(),
  switchWorkspace: vi.fn(),
  member: {
    userId: "member-id",
    name: "Reference editor",
    email: "editor@example.test",
    role: "member",
  },
}));
vi.mock("./page-navigation", () => ({
  usePageQuery: () => ({
    data: { data: [fixture.member] },
    refetch: fixture.refetch,
  }),
}));
vi.mock("@rootset/web-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rootset/web-client")>()),
  client: { operation: fixture.operation },
}));
vi.mock("./workspace-navigation", () => ({
  useSwitchWorkspace: () => fixture.switchWorkspace,
}));
vi.mock("./settings/account/page-selection-title", () => ({
  PageSelectionTitle: ({ actions }: { actions: ReactNode }) => actions,
}));
vi.mock("./dialog", () => ({
  Dialog: ({ title, children }: { title: string; children: ReactNode }) => (
    <div role="dialog" aria-label={title}>
      {children}
    </div>
  ),
}));
vi.mock("@avgeek-oss/design-system/buttons/button", () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
    isPending,
    type,
  }: {
    children: ReactNode;
    onPress?: () => void;
    isDisabled?: boolean;
    isPending?: boolean;
    type?: "button" | "submit";
  }) => (
    <button
      type={type ?? "button"}
      disabled={isDisabled || isPending}
      onClick={onPress}
    >
      {children}
    </button>
  ),
}));
vi.mock("@avgeek-oss/design-system/patterns/resource-table", () => ({
  ResourceTable: ({
    items,
    columns,
  }: {
    items: unknown[];
    columns: { key: string; cell: (item: unknown) => ReactNode }[];
  }) => (
    <table>
      <tbody>
        {items.map((item, index) => (
          <tr key={index}>
            {columns.map((column) => (
              <td key={column.key}>{column.cell(item)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

let root: Root;
let container: HTMLDivElement;
const props = {
  section: "workspace-access" as const,
  orgId: "team",
  workspaceId: "operations",
  userId: "admin-id",
  onClose() {},
};
const click = async (text: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  fixture.operation.mockResolvedValue({});
  fixture.refetch.mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("requires confirmation and permits cancellation before removing a member", async () => {
  await act(async () => root.render(<WorkspaceAccessSettings {...props} />));
  await click("Remove");
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
    "Remove Reference editor from this workspace?",
  );
  expect(fixture.operation).not.toHaveBeenCalled();
  await click("Cancel");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(fixture.operation).not.toHaveBeenCalled();
  await click("Remove");
  await click("Remove member");
  expect(fixture.operation).toHaveBeenCalledExactlyOnceWith(
    "removeWorkspaceMember",
    { orgId: "team", workspaceId: "operations", userId: "member-id" },
    { idempotencyKey: expect.any(String) },
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("confirms self-removal before navigating to Default", async () => {
  await act(async () =>
    root.render(<WorkspaceAccessSettings {...props} userId="member-id" />),
  );
  await click("Remove");
  expect(container.textContent).toContain(
    "Remove yourself from this workspace?",
  );
  expect(fixture.switchWorkspace).not.toHaveBeenCalled();
  await click("Remove member");
  expect(fixture.switchWorkspace).toHaveBeenCalledExactlyOnceWith("team");
});

it("keeps Default access read-only without the removed description", async () => {
  await act(async () =>
    root.render(<WorkspaceAccessSettings {...props} workspaceIsDefault />),
  );
  expect(container.textContent).toContain("Reference editor");
  expect(container.textContent).not.toContain("Default is shared");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});
