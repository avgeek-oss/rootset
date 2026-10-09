"use client";

import { useId, useRef, useState, type FormEvent } from "react";
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
  onCommit: (value: JsonValue) => void | Promise<void>;
  onCancel: () => void;
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
  const submitted = useRef(false);
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

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (
      busy ||
      commitDisabled ||
      submitted.current ||
      hasConflict ||
      validate()
    )
      return;
    submitted.current = true;
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await onCommit(parseCellDraft(field, draft, timeZone));
    } catch (cause) {
      setSubmissionError(
        cause instanceof Error
          ? cause.message
          : "The value could not be saved. Your draft is kept here.",
      );
    } finally {
      submitted.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form
      className="inline-cell-form"
      aria-label={`Edit ${field.name}`}
      lang={locale}
      noValidate
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          if (!busy) onCancel();
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void submit();
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
      <div className="inline-cell-controls">
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
        <button
          type="button"
          aria-label="Cancel"
          disabled={busy}
          onClick={onCancel}
        >
          ×
        </button>
        <button
          type="submit"
          aria-label={
            busy
              ? "Saving…"
              : error || submissionError
                ? "Retry save"
                : "Save value"
          }
          disabled={busy || hasConflict || commitDisabled}
        >
          {busy ? "…" : "✓"}
        </button>
      </div>
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
          : "Enter saves; Shift+Enter adds a line; Escape cancels."}
      </span>
    </form>
  );
}
