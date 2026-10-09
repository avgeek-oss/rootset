"use client";

import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import type { FieldDefinition, JsonValue } from "@rootset/contracts";
import {
  createCellDraft,
  formatJsonDraft,
  parseCellDraft,
  validateCellDraft,
  type CellDraft,
} from "./drafts";
import { CellInput } from "./CellInput";

export interface CellEditorProps {
  field: FieldDefinition;
  value: JsonValue;
  onCommit: (value: JsonValue, move?: -1 | 1) => boolean | Promise<boolean>;
  onCancel: () => void;
  submitRef?: Ref<() => Promise<boolean>>;
  timeZone?: string;
  locale?: string;
  pending?: boolean;
  initialInput?: string;
}

export function CellEditor({
  field,
  value,
  onCommit,
  onCancel,
  submitRef,
  timeZone = "UTC",
  locale = "en-GB",
  pending = false,
  initialInput,
}: CellEditorProps) {
  const [draft, setDraft] = useState<CellDraft>(() => {
    const initial = createCellDraft(field, value, timeZone);
    return initialInput === undefined || field.type === "boolean"
      ? initial
      : { text: initialInput, isNull: false };
  });
  const [submitting, setSubmitting] = useState(false);
  const submitted = useRef<Promise<boolean> | null>(null);
  const cancelled = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [expandUp, setExpandUp] = useState(false);
  useLayoutEffect(() => {
    if (field.type !== "json") return;
    const cell = formRef.current?.closest('[role="gridcell"]');
    const grid = cell?.closest('[role="grid"]');
    if (!cell || !grid) return;
    const cellBounds = cell.getBoundingClientRect();
    const gridBounds = grid.getBoundingClientRect();
    setExpandUp(
      gridBounds.bottom - cellBounds.top < 240 &&
        cellBounds.top - gridBounds.top > 240,
    );
  }, [field.type]);
  const busy = pending || submitting;
  const extendedCalendar =
    field.type === "date-time" && /^(?:0000|10000)-/.test(draft.text);
  const canFocus =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: fine)").matches;

  function change(next: CellDraft) {
    setDraft(next);
  }

  function reject(message: string) {
    cancelled.current = true;
    toast.danger(message);
    onCancel();
    return false;
  }

  function submit(move?: -1 | 1): Promise<boolean> {
    if (submitted.current) return submitted.current;
    if (cancelled.current || busy) return Promise.resolve(false);
    const invalid = validateCellDraft(field, draft, timeZone);
    if (invalid) return Promise.resolve(reject(invalid));
    setSubmitting(true);
    submitted.current = (async () => {
      try {
        const saved = await onCommit(
          parseCellDraft(field, draft, timeZone),
          move,
        );
        if (!saved) {
          cancelled.current = true;
          onCancel();
        }
        return saved;
      } catch (cause) {
        return reject(
          cause instanceof Error
            ? cause.message
            : "The value could not be saved.",
        );
      } finally {
        submitted.current = null;
        setSubmitting(false);
      }
    })();
    return submitted.current;
  }

  useImperativeHandle(submitRef, () => () => submit());

  return (
    <form
      ref={formRef}
      className={`inline-cell-form${field.type === "json" ? " inline-cell-form--json" : ""}${expandUp ? " inline-cell-form--expand-up" : ""}`}
      aria-label={`Edit ${field.name}`}
      lang={locale}
      noValidate
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (
          next instanceof Element &&
          next.closest(
            '.inline-cell-editor, [role="grid"], [aria-label="Table actions"]',
          )
        )
          return;
        void submit();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          if (!busy) {
            cancelled.current = true;
            onCancel();
          }
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void submit();
        }
        if (event.key === "Tab" && field.type !== "json") {
          const inputs = event.currentTarget.querySelectorAll(
            "input, textarea, select",
          );
          const boundary = event.shiftKey
            ? inputs[0]
            : inputs[inputs.length - 1];
          if (event.target === boundary) {
            event.preventDefault();
            void submit(event.shiftKey ? -1 : 1);
          }
        }
        if (
          !event.nativeEvent.isComposing &&
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !(event.target instanceof HTMLButtonElement) &&
          !(
            field.type === "json" && event.target instanceof HTMLTextAreaElement
          )
        ) {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <CellInput
        field={field}
        draft={draft}
        onChange={change}
        timeZone={timeZone}
        disabled={busy}
        autoFocus={canFocus}
        inline
      />
      {field.type === "json" && (
        <div className="inline-json-actions">
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busy || draft.isNull}
            onPress={() => {
              try {
                change({ ...draft, text: formatJsonDraft(draft.text) });
              } catch (cause) {
                reject(
                  cause instanceof Error ? cause.message : "Enter valid JSON.",
                );
              }
            }}
          >
            Format
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busy}
            onPress={() => {
              cancelled.current = true;
              onCancel();
            }}
          >
            Cancel
          </Button>
          <Button size="sm" type="submit" isDisabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
      {extendedCalendar && (
        <p className="inline-cell-feedback">
          This boundary date uses a text input; local year 0000 represents 0001
          BCE.
        </p>
      )}
      <span className="sr-only" role="status">
        {busy
          ? "Saving this value…"
          : field.type === "json"
            ? "Enter adds a line; Cmd or Ctrl+Enter saves; leaving the cell saves; Escape cancels."
            : "Enter saves; Tab saves and moves; leaving the cell saves; Shift+Enter adds a line; Escape cancels."}
      </span>
    </form>
  );
}
