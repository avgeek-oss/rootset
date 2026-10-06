"use client";

import {
  Checkbox,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Select,
  TextArea,
  TextField,
} from "@heroui/react";
import { Button } from "../ui/button";
import {
  lazy,
  Suspense,
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type FormEvent,
} from "react";
import {
  limits,
  type FieldDefinition,
  type JsonValue,
} from "@rootset/contracts";
import {
  createCellDraft,
  parseCellDraft,
  validateCellDraft,
  type CellDraft,
} from "./drafts";
import {
  getLocalDateTimeCandidates,
  type LocalDateTimeCandidate,
} from "./temporal";
import styles from "./cells.module.css";

const JsonEditor = lazy(() => import("./JsonEditor"));

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
  const [portalContainer, setPortalContainer] = useState<Element>();
  const attachEditor = useCallback((node: HTMLFormElement | null) => {
    setPortalContainer(node?.closest("dialog") ?? undefined);
  }, []);
  const submitted = useRef(false);
  const id = useId();
  const labelId = `${id}-label`;
  const feedbackId = `${id}-feedback`;
  const busy = pending || submitting;
  const hasConflict = conflict !== undefined && conflict !== null;
  const message =
    validationError ??
    submissionError ??
    error ??
    (hasConflict ? "The row changed before this value was saved." : null);
  const hasTextField = field.type !== "boolean" && field.type !== "json";
  const extendedCalendar =
    field.type === "date-time" && /^(?:0000|10000)-/.test(draft.text);
  const canFocus =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: fine)").matches;

  let candidates: LocalDateTimeCandidate[] = [];
  if (field.type === "date-time" && !draft.isNull && draft.text) {
    try {
      candidates = getLocalDateTimeCandidates(draft.text, timeZone);
    } catch {
      /* The validation message appears on blur/save. */
    }
  }

  function change(next: CellDraft) {
    setDraft(next);
    setSubmissionError(null);
    if (validated) setValidationError(validateCellDraft(field, next, timeZone));
  }

  function changeText(text: string) {
    change({
      ...draft,
      text,
      ...(field.type === "date-time" ? { selectedInstant: undefined } : {}),
    });
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

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onCancel();
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      void submit();
    }
  }

  const instructions =
    field.type === "text"
      ? `${[...draft.text].length} / ${field.charLimit ?? limits.textCharLimit} characters. Enter adds a line; Ctrl/⌘+Enter saves.`
      : field.type === "json"
        ? "Any valid JSON value. Nested null stays JSON; top-level null clears this cell. Ctrl/⌘+Enter saves."
        : field.type === "time"
          ? "UTC time only. Your viewing timezone does not change this value."
          : field.type === "date-time"
            ? `Editing in ${timeZone}. Rootset saves the selected instant as UTC.${extendedCalendar ? " This boundary date uses a text input; local year 0000 represents 0001 BCE." : ""}`
            : field.type === "date"
              ? "Calendar date. Timezone preferences do not change dates."
              : field.type === "integer"
                ? "Whole number in the safe integer range, including any field bounds."
                : field.type === "float"
                  ? "Finite number. Decimal values use approximate binary representation."
                  : "True, false and null are distinct values.";

  const commonInput = {
    autoFocus: canFocus,
    autoComplete: "off",
    spellCheck: false,
    "data-1p-ignore": true,
    "data-lpignore": "true",
    onBlur: validate,
  };

  return (
    <form
      ref={attachEditor}
      className={styles.editor}
      onSubmit={(event) => void submit(event)}
      onKeyDown={onKeyDown}
      noValidate
      aria-label={`Edit ${field.name}`}
      lang={locale}
    >
      {field.type === "boolean" ? (
        <Checkbox
          isSelected={draft.text === "true"}
          onChange={(selected) => changeText(String(selected))}
          isDisabled={busy || draft.isNull}
        >
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            {field.name}: {draft.text === "true" ? "True" : "False"}
          </Checkbox.Content>
          <Description>{instructions}</Description>
        </Checkbox>
      ) : field.type === "json" ? (
        <div>
          <label id={labelId}>
            {field.name}
            {field.required ? " (required)" : ""}
          </label>
          <Suspense fallback={<p role="status">Loading JSON editor…</p>}>
            <JsonEditor
              value={draft.text}
              onChange={changeText}
              labelId={labelId}
              describedBy={feedbackId}
              disabled={busy || draft.isNull}
              invalid={!!message}
            />
          </Suspense>
          <p className={styles.hint}>{instructions}</p>
        </div>
      ) : (
        <TextField
          value={draft.text}
          onChange={changeText}
          isDisabled={busy || draft.isNull}
          isRequired={field.required}
          isInvalid={!!message}
          validationBehavior="aria"
          fullWidth
        >
          <Label>{field.name}</Label>
          {field.type === "text" ? (
            <TextArea {...commonInput} rows={3} />
          ) : (
            <Input
              {...commonInput}
              type={
                field.type === "date"
                  ? "date"
                  : field.type === "time"
                    ? "time"
                    : field.type === "date-time" && !extendedCalendar
                      ? "datetime-local"
                      : "text"
              }
              inputMode={
                field.type === "integer"
                  ? "numeric"
                  : field.type === "float"
                    ? "decimal"
                    : undefined
              }
              step={
                field.type === "time" || field.type === "date-time"
                  ? "0.001"
                  : undefined
              }
              min={
                field.type === "date" && typeof field.min === "string"
                  ? field.min
                  : undefined
              }
              max={
                field.type === "date" && typeof field.max === "string"
                  ? field.max
                  : undefined
              }
            />
          )}
          <Description>{instructions}</Description>
          {message ? (
            <FieldError>
              <span role="alert">{message}</span>
            </FieldError>
          ) : null}
        </TextField>
      )}

      {field.type === "date-time" && !draft.isNull && candidates.length > 1 ? (
        <Select
          value={draft.selectedInstant ?? null}
          onChange={(selection) =>
            change({
              ...draft,
              selectedInstant:
                typeof selection === "string" ? selection : undefined,
            })
          }
          isDisabled={busy}
          isRequired
          placeholder="Choose a UTC offset"
          fullWidth
        >
          <Label>This local time occurs twice</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover UNSTABLE_portalContainer={portalContainer}>
            <ListBox>
              {candidates.map((candidate) => (
                <ListBox.Item
                  id={candidate.instant}
                  key={candidate.instant}
                  textValue={candidate.label}
                >
                  {candidate.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          <Description>
            Choose the intended occurrence. Rootset will not guess an offset.
          </Description>
        </Select>
      ) : null}

      {!field.required ? (
        <Checkbox
          isSelected={draft.isNull}
          onChange={(selected) => change({ ...draft, isNull: selected })}
          isDisabled={busy}
        >
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            Clear cell (null)
          </Checkbox.Content>
        </Checkbox>
      ) : null}

      <div
        id={feedbackId}
        className={`${styles.feedback} ${message && !hasTextField ? styles.error : ""}`}
        role={message && !hasTextField ? "alert" : "status"}
        aria-live={message && !hasTextField ? "assertive" : "polite"}
      >
        {message && !hasTextField
          ? message
          : busy
            ? "Saving this value…"
            : message
              ? "Your draft is kept until this value can be saved."
              : "The value is saved only after the server accepts it."}
      </div>
      {hasConflict ? (
        <p className={styles.hint}>
          Current committed value: {conflict === "" ? "(empty text)" : conflict}
          . Your draft is kept. Review the current row before retrying this
          edit.
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          onPress={onCancel}
          isDisabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          isDisabled={busy || hasConflict || commitDisabled}
        >
          {busy
            ? "Saving…"
            : error || submissionError
              ? "Retry save"
              : "Save value"}
        </Button>
      </div>
    </form>
  );
}
