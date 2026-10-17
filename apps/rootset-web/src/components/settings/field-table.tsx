"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Table } from "@avgeek-oss/design-system/data-display/table";
import {
  ResourceTable,
  type ResourceTableColumn,
} from "@avgeek-oss/design-system/patterns/resource-table";
import { DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDragAndDrop } from "react-aria-components";
import { useRef, type ReactNode } from "react";
import type { TableField } from "./types";
import "./field-table.css";

export function FieldTable({
  items,
  columns,
  disabled,
  onReorder,
  emptyAction,
  ariaLabel = "Fields",
  tableClassName = "min-w-4xl",
}: {
  items: TableField[];
  columns: ResourceTableColumn<TableField>[];
  disabled: boolean;
  onReorder: (ids: string[]) => void | Promise<void>;
  ariaLabel?: string;
  tableClassName?: string;
  emptyAction: ReactNode;
}) {
  const pendingOrder = useRef<string[] | undefined>(undefined);
  const { dragAndDropHooks } = useDragAndDrop({
    isDisabled: disabled || items.length < 2,
    getItems: (keys) =>
      items
        .filter((item) => keys.has(item.id))
        .map((item) => ({ "text/plain": item.name })),
    getAllowedDropOperations: () => ["move"],
    onDragStart: () => {
      pendingOrder.current = undefined;
    },
    onDragEnd: () => {
      const ids = pendingOrder.current;
      pendingOrder.current = undefined;
      if (ids) void onReorder(ids);
    },
    onReorder: (event) => {
      const remaining = items.filter((item) => !event.keys.has(item.id));
      const index = remaining.findIndex((item) => item.id === event.target.key);
      if (index < 0) return;
      remaining.splice(
        index + (event.target.dropPosition === "after" ? 1 : 0),
        0,
        ...items.filter((item) => event.keys.has(item.id)),
      );
      if (remaining.some((item, position) => item.id !== items[position]?.id))
        // Saving disables the drag handlers, so wait for dragend to clear the drag state first.
        pendingOrder.current = remaining.map((item) => item.id);
    },
  });
  if (items.length === 0)
    return (
      <ResourceTable
        ariaLabel={ariaLabel}
        items={items}
        columns={columns}
        getRowKey={(field) => field.id}
        emptyTitle="No fields yet"
        emptyDescription="Add a field to define the columns and values this table can store."
        emptyAction={emptyAction}
      />
    );
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content
          aria-label={ariaLabel}
          className={`rootset-fields-table ${tableClassName}`}
          dragAndDropHooks={dragAndDropHooks}
          keyboardNavigationBehavior="arrow"
        >
          <Table.Header>
            {columns.map((column, index) => (
              <Table.Column
                key={column.key}
                id={column.key}
                isRowHeader={index === 0}
                className={column.headerClassName}
              >
                {column.header}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body items={items} dependencies={[columns, disabled]}>
            {(field) => (
              <Table.Row id={field.id} textValue={field.name}>
                {columns.map((column, index) => (
                  <Table.Cell
                    key={column.key}
                    className={`align-middle ${column.className ?? ""}`}
                  >
                    {index === 0 ? (
                      <div className="field-name-cell">
                        <Button
                          slot="drag"
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          style={{ pointerEvents: "auto" }}
                          className="field-drag-handle"
                          aria-label={`Reorder ${field.name}`}
                          isDisabled={disabled || items.length < 2}
                        >
                          <HugeiconsIcon
                            icon={DragDropVerticalIcon}
                            size={16}
                            aria-hidden="true"
                          />
                        </Button>
                        {column.cell(field)}
                      </div>
                    ) : (
                      column.cell(field)
                    )}
                  </Table.Cell>
                ))}
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
