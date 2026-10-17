"use client";

import { useId, useState } from "react";
import {
  Calendar,
  DateField,
  DatePicker,
  Description,
  Dropdown,
  Input,
  Label,
  ListBox,
  Select,
  TextArea,
  TextField,
  TimeField,
} from "@heroui/react";
import { parseDate, parseDateTime, parseTime } from "@internationalized/date";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import type { FieldDefinition } from "@rootset/contracts";
import { createRecordDraft, type RecordFieldDraft } from "../lib/record-draft";
import { allowedValueLabel } from "../lib/field-choices";
import { getLocalDateTimeCandidates } from "./cells/temporal";
import { Choice } from "./settings/ui";
import { FieldTypeIcon } from "./settings/field-type-options";
import { MoreHorizontal } from "./ui/icons";
import { JsonEditor } from "./json-editor";

export function RecordField({
  field,
  label = field.name,
  draft,
  onChange,
  creating,
  timeZone,
  hourCycle,
  invalid,
  disabled,
  readOnly,
}: {
  field: FieldDefinition;
  label?: string;
  draft: RecordFieldDraft;
  onChange: (draft: RecordFieldDraft) => void;
  creating: boolean;
  timeZone: string;
  hourCycle: 12 | 24;
  invalid: boolean;
  disabled: boolean;
  readOnly: boolean;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const [expanded, setExpanded] = useState(
    () =>
      field.type === "json" ||
      draft.text.length > 80 ||
      draft.text.includes("\n"),
  );
  const generated = creating && field.type === "integer" && field.autoIncrement;
  const usingGenerator = generated && draft.mode === "default";
  const canDefault = creating && (generated || Object.hasOwn(field, "default"));
  const canSetNull =
    !field.required && field.type !== "boolean" && !field.allowedValues;
  const hasActions =
    canSetNull ||
    canDefault ||
    generated ||
    (field.type === "text" && !field.allowedValues);
  const heading = (
    <div className="record-field-heading">
      <Label
        id={labelId}
        onClick={
          field.type === "json"
            ? () => document.getElementById(`${id}-json`)?.focus()
            : undefined
        }
      >
        <span className="record-field-label">
          <FieldTypeIcon type={field.type} size={18} />
          {label}
          {field.required && (
            <span aria-hidden="true" className="text-danger">
              *
            </span>
          )}
        </span>
      </Label>
      {!readOnly && hasActions && (
        <Dropdown>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`Options for ${field.name}`}
            isDisabled={disabled}
          >
            <MoreHorizontal size={18} />
          </Button>
          <Dropdown.Popover>
            <Dropdown.Menu
              aria-label={`Options for ${field.name}`}
              onAction={(action) => {
                if (action === "null")
                  onChange({ ...draft, mode: "null", isNull: true });
                else if (action === "default")
                  onChange(
                    createRecordDraft([field], undefined, timeZone)[field.id]!,
                  );
                else if (action === "empty" || action === "manual")
                  onChange({ text: "", mode: "value", isNull: false });
                else if (action === "expand") setExpanded(true);
              }}
            >
              {canSetNull && (
                <Dropdown.Item id="null">Set to NULL</Dropdown.Item>
              )}
              {canDefault && (
                <Dropdown.Item id="default">
                  {generated ? "Generate value" : "Use default"}
                </Dropdown.Item>
              )}
              {generated && (
                <Dropdown.Item id="manual">Set value manually</Dropdown.Item>
              )}
              {field.type === "text" && !field.allowedValues && (
                <>
                  <Dropdown.Item id="empty">Set empty text</Dropdown.Item>
                  {!expanded && (
                    <Dropdown.Item id="expand">Expand text</Dropdown.Item>
                  )}
                </>
              )}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
    </div>
  );
  const description = usingGenerator ? (
    <Description>Generated automatically</Description>
  ) : draft.mode === "default" ? (
    <Description>Default for new records</Description>
  ) : field.type === "date-time" ? (
    <Description>{timeZone}</Description>
  ) : field.type === "time" ? (
    <Description>UTC</Description>
  ) : null;
  const common = {
    className: "settings-field",
    "aria-labelledby": labelId,
    isDisabled: disabled,
    isInvalid: invalid,
    isRequired: Boolean(field.required),
    validationBehavior: "aria" as const,
  };
  function changeText(text: string) {
    onChange({
      ...draft,
      text,
      mode: "value",
      isNull: false,
      ...(field.type === "date-time" ? { selectedInstant: undefined } : {}),
    });
  }
  const isNull =
    draft.mode === "null" ||
    (draft.mode === "default" && draft.isNull && !usingGenerator);
  const nullClass = isNull ? "null-value" : undefined;
  let control;
  if (field.type === "boolean" || field.allowedValues) {
    const choices = field.allowedValues ?? ["false", "true"];
    control = (
      <Select
        {...common}
        variant="secondary"
        isDisabled={disabled || readOnly}
        placeholder="Choose a value"
        value={
          isNull
            ? field.required
              ? null
              : "null"
            : choices.includes(draft.text)
              ? `choice:${choices.indexOf(draft.text)}`
              : null
        }
        onChange={(key) => {
          const selected = String(key);
          if (selected === "null")
            onChange({ ...draft, mode: "null", isNull: true });
          else changeText(choices[Number(selected.slice(7))]!);
        }}
      >
        <Select.Trigger>
          <Select.Value className={nullClass} />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {!field.required && (
              <ListBox.Item id="null" textValue="NULL">
                <span className="null-value">NULL</span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            )}
            {choices.map((choice, index) => (
              <ListBox.Item
                id={`choice:${index}`}
                key={index}
                textValue={choice}
              >
                {allowedValueLabel(choice)}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
        {description}
      </Select>
    );
  } else if (
    field.type === "date" ||
    (field.type === "date-time" && !/^(?:0000|10000)-/.test(draft.text))
  ) {
    const value =
      draft.mode === "null" || !draft.text
        ? null
        : field.type === "date"
          ? parseDate(draft.text)
          : parseDateTime(draft.text);
    control = (
      <DatePicker
        {...common}
        isReadOnly={readOnly}
        value={value}
        onChange={(value) =>
          changeText(
            value
              ? value.toString().slice(0, field.type === "date" ? 10 : 16)
              : "",
          )
        }
        granularity={field.type === "date" ? "day" : "minute"}
        hourCycle={hourCycle}
      >
        <DateField.Group variant="secondary" className={nullClass}>
          <DateField.Input>
            {(segment) => <DateField.Segment segment={segment} />}
          </DateField.Input>
          <DatePicker.Trigger aria-label={`Choose ${field.name}`}>
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Group>
        <DatePicker.Popover>
          <Calendar aria-label={`Choose ${field.name}`}>
            <Calendar.Header>
              <Calendar.NavButton slot="previous" />
              <Calendar.Heading />
              <Calendar.NavButton slot="next" />
            </Calendar.Header>
            <Calendar.Grid>
              <Calendar.GridHeader>
                {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
              </Calendar.GridHeader>
              <Calendar.GridBody>
                {(date) => <Calendar.Cell date={date} />}
              </Calendar.GridBody>
            </Calendar.Grid>
          </Calendar>
        </DatePicker.Popover>
        {description}
      </DatePicker>
    );
  } else if (field.type === "time") {
    control = (
      <TimeField
        {...common}
        isReadOnly={readOnly}
        value={
          draft.mode === "null" || !draft.text ? null : parseTime(draft.text)
        }
        onChange={(value) =>
          changeText(value ? value.toString().slice(0, 5) : "")
        }
        granularity="minute"
        hourCycle={hourCycle}
      >
        <TimeField.Group
          id={`${id}-group`}
          variant="secondary"
          className={nullClass}
        >
          <TimeField.Input>
            {(segment) => <TimeField.Segment segment={segment} />}
          </TimeField.Input>
        </TimeField.Group>
        {description}
      </TimeField>
    );
  } else if (field.type === "json") {
    control = (
      <div className="grid min-w-0 gap-1">
        <JsonEditor
          id={`${id}-json`}
          label={label}
          labelledBy={labelId}
          describedBy={description ? `${id}-description` : undefined}
          value={isNull ? "" : draft.text}
          onChange={changeText}
          isNull={isNull}
          disabled={disabled}
          readOnly={readOnly}
          required={Boolean(field.required)}
          invalid={invalid}
        />
        {description && <div id={`${id}-description`}>{description}</div>}
      </div>
    );
  } else {
    control = (
      <TextField
        {...common}
        value={draft.mode === "null" || usingGenerator ? "" : draft.text}
        onChange={changeText}
        isReadOnly={readOnly || usingGenerator}
        onBlur={() => {
          if (field.type === "text" && draft.text.length > 80)
            setExpanded(true);
        }}
      >
        {expanded && field.type === "text" ? (
          <TextArea
            variant="secondary"
            rows={3}
            className={nullClass}
            placeholder={draft.mode === "null" ? "NULL" : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        ) : (
          <Input
            variant="secondary"
            className={nullClass}
            inputMode={
              field.type === "integer"
                ? "numeric"
                : field.type === "float"
                  ? "decimal"
                  : undefined
            }
            placeholder={
              usingGenerator
                ? "Auto-increment"
                : draft.mode === "null"
                  ? "NULL"
                  : undefined
            }
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore="true"
            data-lpignore="true"
          />
        )}
        {description}
      </TextField>
    );
  }
  let candidates: ReturnType<typeof getLocalDateTimeCandidates> = [];
  if (field.type === "date-time" && draft.mode !== "null" && draft.text) {
    try {
      candidates = getLocalDateTimeCandidates(draft.text, timeZone);
    } catch {
      // Incomplete dates remain editable and are validated on submission.
    }
  }
  return (
    <div className="record-field" data-field-id={field.id}>
      {heading}
      {control}
      {candidates.length > 1 && (
        <Choice
          label={`UTC offset for ${field.name}`}
          value={draft.selectedInstant ?? ""}
          options={candidates.map((candidate) => ({
            value: candidate.instant,
            label: candidate.label,
          }))}
          onChange={(selectedInstant) =>
            onChange({ ...draft, mode: "value", selectedInstant })
          }
          disabled={disabled || readOnly}
        />
      )}
    </div>
  );
}
