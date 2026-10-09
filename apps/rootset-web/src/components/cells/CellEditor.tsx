"use client";

import { useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { FieldDefinition, JsonValue } from "@rootset/contracts";
import {
  createCellDraft,
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
  commitDisabled?: boolean;
  error?: string | null;
  conflict?: string | null;
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
  commitDisabled = false,
  error,
  conflict,
  initialInput,
}: CellEditorProps) {
  const [draft, setDraft] = useState<CellDraft>(() => {
    const initial = createCellDraft(field, value, timeZone);
    return initialInput === undefined || field.type === "boolean"
      ? initial
      : { text: initialInput, isNull: false };
  });
  const [validated, setValidated] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitted = useRef<Promise<boolean> | null>(null);
  const cancelled = useRef(false);
  const id = useId();
  const feedbackId = `${id}-feedback`;
  const busy = pending || submitting;
  const hasConflict = conflict !== undefined && conflict !== null;
  const message =
    validationError ??
    submissionError ??
    error ??
    (hasConflict ? "The row changed before this value was saved." : null);
  const extendedCalendar =
    field.type === "date-time" && /^(?:0000|10000)-/.test(draft.text);
  const canFocus =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: fine)").matches;

  function change(next: CellDraft) {
    setDraft(next);
    setSubmissionError(null);
    if (validated) setValidationError(validateCellDraft(field, next, timeZone));
  }

  function validate() {
    setValidated(true);
    const result = validateCellDraft(field, draft, timeZone);
    setValidationError(result);
    return result;
  }

  function submit(move?: -1 | 1): Promise<boolean> {
    if (submitted.current) return submitted.current;
    if (
      cancelled.current ||
      busy ||
      commitDisabled ||
      hasConflict ||
      validate()
    )
      return Promise.resolve(false);
    setSubmitting(true);
    setSubmissionError(null);
    submitted.current = (async () => {
      try {
        return await onCommit(parseCellDraft(field, draft, timeZone), move);
      } catch (cause) {
        setSubmissionError(
          cause instanceof Error
            ? cause.message
            : "The value could not be saved. Your draft is kept here.",
        );
        return false;
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
      className="inline-cell-form"
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
        if (event.key === "Tab") {
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
          !event.metaKey
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
        invalid={!!message}
        autoFocus={canFocus}
        describedBy={message ? feedbackId : undefined}
        inline
      />
      {message && (
        <p id={feedbackId} className="inline-cell-error" role="alert">
          {message}
        </p>
      )}
      {hasConflict && (
        <p className="inline-cell-feedback">
          Current committed value: {conflict === "" ? "(empty text)" : conflict}
          . Your draft is kept.
        </p>
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
          : "Enter saves; Tab saves and moves; leaving the cell saves; Shift+Enter adds a line; Escape cancels."}
      </span>
    </form>
  );
}
