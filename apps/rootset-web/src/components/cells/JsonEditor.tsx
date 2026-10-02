"use client";

import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import styles from "./cells.module.css";

export interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  labelId: string;
  describedBy?: string;
  disabled?: boolean;
  invalid?: boolean;
}

export default function JsonEditor({
  value,
  onChange,
  labelId,
  describedBy,
  disabled = false,
  invalid = false,
}: JsonEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeHandler = useRef(onChange);
  const editable = useRef(new Compartment());
  const accessibility = useRef(new Compartment());
  const initial = useRef({ value, disabled, invalid, labelId, describedBy });
  changeHandler.current = onChange;

  useEffect(() => {
    if (!container.current) return;
    const { value, disabled, invalid, labelId, describedBy } = initial.current;
    const editor = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          json(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          editable.current.of(EditorView.editable.of(!disabled)),
          accessibility.current.of(
            EditorView.contentAttributes.of({
              role: "textbox",
              "aria-multiline": "true",
              "aria-labelledby": labelId,
              "aria-invalid": String(invalid),
              ...(describedBy ? { "aria-describedby": describedBy } : {}),
            }),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              changeHandler.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    if (window.matchMedia("(pointer: fine)").matches) editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({
      effects: [
        editable.current.reconfigure(EditorView.editable.of(!disabled)),
        accessibility.current.reconfigure(
          EditorView.contentAttributes.of({
            role: "textbox",
            "aria-multiline": "true",
            "aria-labelledby": labelId,
            "aria-invalid": String(invalid),
            ...(describedBy ? { "aria-describedby": describedBy } : {}),
          }),
        ),
      ],
    });
  }, [disabled, invalid, labelId, describedBy]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
    });
  }, [value]);

  return (
    <div
      className={styles.json}
      ref={container}
      data-testid="json-cell-editor"
    />
  );
}
