"use client";

import { useId } from "react";
import type { FieldDefinition } from "@rootset/contracts";
import type { CellDraft } from "./drafts";
import { ChevronDown } from "../ui/icons";
import { getLocalDateTimeCandidates } from "./temporal";

export function CellInput({
  field,
  draft,
  onChange,
  timeZone,
  disabled = false,
  invalid = false,
  autoFocus = false,
  describedBy,
  inline = false,
}: {
  field: FieldDefinition;
  draft: CellDraft;
  onChange: (draft: CellDraft) => void;
  timeZone: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  describedBy?: string;
  inline?: boolean;
}) {
  const id = useId();
  let candidates: ReturnType<typeof getLocalDateTimeCandidates> = [];
  if (field.type === "date-time" && draft.text && !draft.isNull) {
    try {
      candidates = getLocalDateTimeCandidates(draft.text, timeZone);
    } catch {
      /* Submission reports invalid local times without discarding the input. */
    }
  }
  function changeText(text: string) {
    onChange({
      ...draft,
      text,
      isNull: false,
      ...(field.type === "date-time" ? { selectedInstant: undefined } : {}),
    });
  }
  const common = {
    id,
    "aria-label": field.name,
    "aria-describedby": describedBy,
    "aria-invalid": invalid || undefined,
    disabled,
    autoFocus,
    autoComplete: "off",
    spellCheck: false,
    "data-1p-ignore": true,
    "data-lpignore": "true",
    className:
      field.type === "boolean" && !draft.isNull
        ? `cell-input cell-boolean-${draft.text}`
        : "cell-input",
  };
  return (
    <>
      {!inline && (
        <label htmlFor={id}>
          {field.name}
          {field.required ? " *" : ""}
        </label>
      )}
      {field.type === "boolean" ? (
        <div className="cell-select">
          <select
            {...common}
            value={draft.isNull ? "null" : draft.text}
            onChange={(event) =>
              onChange({
                text:
                  event.target.value === "null" ? "false" : event.target.value,
                isNull: event.target.value === "null",
              })
            }
          >
            {!field.required && <option value="null">NULL</option>}
            <option value="false">false</option>
            <option value="true">true</option>
          </select>
          <ChevronDown size={14} />
        </div>
      ) : ["text", "uri", "url", "image", "json"].includes(field.type) ? (
        <textarea
          {...common}
          rows={field.type === "json" ? 8 : inline ? 1 : 2}
          value={draft.isNull ? "" : draft.text}
          placeholder={draft.isNull ? "NULL" : undefined}
          onChange={(event) => changeText(event.target.value)}
        />
      ) : (
        <input
          {...common}
          type={
            field.type === "date"
              ? "date"
              : field.type === "time"
                ? "time"
                : field.type === "date-time" &&
                    !/^(?:0000|10000)-/.test(draft.text)
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
              ? "60"
              : undefined
          }
          value={draft.isNull ? "" : draft.text}
          placeholder={draft.isNull ? "NULL" : undefined}
          onChange={(event) => changeText(event.target.value)}
        />
      )}
      {candidates.length > 1 && !draft.isNull && (
        <select
          className="cell-input"
          aria-label="This local time occurs twice"
          value={draft.selectedInstant ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...draft,
              selectedInstant: event.target.value || undefined,
            })
          }
        >
          <option value="">Choose a UTC offset</option>
          {candidates.map((candidate) => (
            <option key={candidate.instant} value={candidate.instant}>
              {candidate.label}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
