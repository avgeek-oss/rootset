"use client";
import { useRef } from "react";
import type { Row } from "@rootset/contracts";
import { Checkbox } from "@avgeek-oss/design-system/forms/checkbox";
import { useRowSelection, type RenderCheckboxProps } from "react-data-grid";
export function GridCheckbox({
  checked,
  indeterminate,
  disabled,
  tabIndex,
  onChange,
  ...label
}: RenderCheckboxProps) {
  const shift = useRef(false);
  return (
    <span
      className="grid-selection-checkbox-hit"
      onPointerDownCapture={(event) => {
        shift.current = event.shiftKey;
      }}
      onKeyDownCapture={(event) => {
        shift.current = event.shiftKey;
      }}
    >
      <Checkbox
        className="grid-selection-checkbox"
        excludeFromTabOrder={tabIndex === -1}
        isSelected={checked}
        isIndeterminate={indeterminate}
        isDisabled={disabled}
        onChange={(checked) => onChange(checked, shift.current)}
        {...label}
      >
        <Checkbox.Content
          className="grid-selection-checkbox-control"
          {...label}
        >
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
        </Checkbox.Content>
      </Checkbox>
    </span>
  );
}

export function RecordSelectionCell({
  row,
  rowNumber,
  tabIndex,
}: {
  row: Row;
  rowNumber: number;
  tabIndex: number;
}) {
  const { isRowSelected, isRowSelectionDisabled, onRowSelectionChange } =
    useRowSelection();
  return (
    <GridCheckbox
      aria-label={`Select record ${rowNumber}`}
      checked={isRowSelected}
      disabled={isRowSelectionDisabled}
      tabIndex={tabIndex}
      onChange={(checked, isShiftClick) =>
        onRowSelectionChange({ row, checked, isShiftClick })
      }
    />
  );
}
