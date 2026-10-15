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
import type { ReactNode } from "react";
import type { TableField } from "./types";

export function FieldTable({
  items,
  columns,
  disabled,
  onReorder,
  emptyAction,
}: {
  items: TableField[];
  columns: ResourceTableColumn<TableField>[];
  disabled: boolean;
  onReorder: (ids: string[]) => Promise<void>;
  emptyAction: ReactNode;
}) {
  const { dragAndDropHooks } = useDragAndDrop({
    isDisabled: disabled || items.length < 2,
    getItems: (keys) =>
      items
        .filter((item) => keys.has(item.id))
        .map((item) => ({ "text/plain": item.name })),
    getAllowedDropOperations: () => ["move"],
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
        void onReorder(remaining.map((item) => item.id));
    },
  });
  if (items.length === 0)
    return (
      <ResourceTable
        ariaLabel="Fields"
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
          aria-label="Fields"
          className="rootset-fields-table min-w-4xl"
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
                          isIconOnly
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
