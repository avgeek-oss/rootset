// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonEditor } from "./json-editor";
import { CellEditor } from "./cells/CellEditor";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function render(props: ComponentProps<typeof JsonEditor>) {
  act(() => root.render(createElement(JsonEditor, props)));
  const element = container.querySelector<HTMLElement>(".cm-editor")!;
  return EditorView.findFromDOM(element)!;
}

describe("JSON editor", () => {
  it("updates controlled values and NULL without echoing changes or recreating the editor", () => {
    const onChange = vi.fn();
    const view = render({ label: "Payload", value: '{"count":0}', onChange });
    const updated = render({
      label: "Payload",
      value: '{"count":1}',
      onChange,
    });
    expect(updated).toBe(view);
    expect(view.state.doc.toString()).toBe('{"count":1}');
    render({ label: "Payload", value: "", isNull: true, onChange });
    expect(view.state.doc.toString()).toBe("");
    expect(view.dom.querySelector(".cm-placeholder")?.textContent).toBe("NULL");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports edits to the current callback and retains undo history across renders", async () => {
    const first = vi.fn();
    const view = render({ label: "Payload", value: "{}", onChange: first });
    act(() => view.dispatch({ changes: { from: 1, insert: '"count":0' } }));
    expect(first).toHaveBeenCalledWith('{"count":0}');
    const latest = vi.fn();
    render({ label: "Payload", value: '{"count":0}', onChange: latest });
    await act(() => undo(view));
    expect(view.state.doc.toString()).toBe("{}");
    expect(latest).toHaveBeenCalledWith("{}");
    expect(first).toHaveBeenCalledOnce();
  });

  it("keeps labels, validation and editability in sync with field state", () => {
    const props = { label: "Payload", value: "{}", onChange: vi.fn() };
    const view = render({
      ...props,
      labelledBy: "payload-label",
      describedBy: "payload-help",
      required: true,
      invalid: true,
      readOnly: true,
    });
    expect(view.contentDOM.getAttribute("aria-labelledby")).toBe(
      "payload-label",
    );
    expect(view.contentDOM.getAttribute("aria-describedby")).toBe(
      "payload-help",
    );
    expect(view.contentDOM.getAttribute("aria-invalid")).toBe("true");
    expect(view.contentDOM.getAttribute("aria-required")).toBe("true");
    expect(view.contentDOM.getAttribute("aria-readonly")).toBe("true");
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    render({ ...props, disabled: true });
    expect(view.contentDOM.getAttribute("aria-disabled")).toBe("true");
    expect(view.contentDOM.tabIndex).toBe(-1);
    render(props);
    expect(view.state.facet(EditorState.readOnly)).toBe(false);
    expect(view.state.facet(EditorView.editable)).toBe(true);
    expect(view.contentDOM.getAttribute("aria-invalid")).toBe("false");
  });
});

describe("inline JSON keyboard and focus boundaries", () => {
  function renderCell() {
    const onCommit = vi.fn(() => true);
    const onCancel = vi.fn();
    act(() =>
      root.render(
        createElement(CellEditor, {
          field: {
            id: "01J00000000000000000000000",
            name: "Payload",
            type: "json",
          },
          value: { count: 0 },
          onCommit,
          onCancel,
        }),
      ),
    );
    const input = container.querySelector<HTMLElement>('[role="textbox"]')!;
    return { input, onCommit, onCancel };
  }
  it("adds lines with Enter and saves with Ctrl+Enter", async () => {
    const { input, onCommit } = renderCell();
    await act(async () => {
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({ count: 0 }, undefined);
  });
  it("keeps editing during an internal focus refresh and cancels with Escape", async () => {
    const { input, onCommit, onCancel } = renderCell();
    await act(async () => {
      input.focus();
      input.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });
    expect(onCommit).not.toHaveBeenCalled();
    await act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
