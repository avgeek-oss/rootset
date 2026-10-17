"use client";

import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import "./json-editor.css";

const controlledChange = Annotation.define<boolean>();
const highlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--accent)" },
    { tag: tags.string, color: "var(--success-soft-foreground)" },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--warning)" },
  ]),
);

export function JsonEditor({
  id,
  label,
  labelledBy,
  describedBy,
  value,
  onChange,
  isNull = false,
  disabled = false,
  readOnly = false,
  required = false,
  invalid = false,
  autoFocus = false,
  inline = false,
}: {
  id?: string;
  label: string;
  labelledBy?: string;
  describedBy?: string;
  value: string;
  onChange(value: string): void;
  isNull?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  inline?: boolean;
}) {
  const generatedId = useId();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const configuration = useRef(new Compartment());
  const initial = useRef({ value, autoFocus });
  const change = useRef(onChange);
  change.current = onChange;

  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          json(),
          highlighting,
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          indentOnInput(),
          indentUnit.of("  "),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          configuration.current.of([]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.every((transaction) =>
                transaction.annotation(controlledChange),
              )
            )
              change.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    const attributes: Record<string, string> = {
      id: id ?? generatedId,
      role: "textbox",
      "aria-multiline": "true",
      "aria-readonly": String(readOnly),
      "aria-disabled": String(disabled),
      "aria-required": String(required),
      "aria-invalid": String(invalid),
      ...(labelledBy
        ? { "aria-labelledby": labelledBy }
        : { "aria-label": label }),
      ...(describedBy ? { "aria-describedby": describedBy } : {}),
      tabindex: disabled ? "-1" : "0",
      autocapitalize: "off",
      spellcheck: "false",
      "data-1p-ignore": "true",
      "data-lpignore": "true",
    };
    view.dispatch({
      effects: configuration.current.reconfigure([
        EditorState.readOnly.of(disabled || readOnly),
        EditorView.editable.of(!disabled && !readOnly),
        EditorView.contentAttributes.of(attributes),
        ...(isNull ? [placeholder("NULL")] : []),
      ]),
    });
  }, [
    id,
    generatedId,
    label,
    labelledBy,
    describedBy,
    disabled,
    readOnly,
    required,
    invalid,
    isNull,
  ]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (view && value !== view.state.doc.toString())
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: [
          controlledChange.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
  }, [value]);

  useEffect(() => {
    if (initial.current.autoFocus) editor.current?.focus();
  }, []);

  return (
    <div
      ref={host}
      className={`json-code-editor${inline ? " json-code-editor--inline" : ""}`}
      data-code-editor="json"
      data-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
    />
  );
}
