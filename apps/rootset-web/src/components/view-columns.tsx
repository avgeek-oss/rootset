"use client";

import { useRef, useState } from "react";
import { Checkbox } from "@avgeek-oss/design-system/forms/checkbox";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import type { FieldDefinition } from "@rootset/contracts";
import { orderedViewFields, type ViewLayout } from "../lib/saved-view-state";
import { FieldTable } from "./settings/field-table";
import { FieldTypeIcon } from "./settings/field-type-options";
import { useConfirmation } from "./settings/ui";
import "./record-editor.css";
import { Check } from "./ui/icons";

export function ViewColumns({
  fields,
  value,
  tableName,
  onApply,
  onClose,
}: {
  fields: FieldDefinition[];
  value: ViewLayout;
  tableName: string;
  onApply(value: ViewLayout): void;
  onClose(): void;
}) {
  const [initial] = useState<ViewLayout>(() => ({
    ...value,
    columnOrder: orderedViewFields(fields, value).map((field) => field.id),
  }));
  const [draft, setDraft] = useState(initial);
  const confirmation = useConfirmation();
  const closing = useRef(false);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  async function close() {
    if (closing.current) return;
    closing.current = true;
    try {
      if (
        !dirty ||
        (await confirmation.confirm(
          "Discard column changes?",
          "Changes to the visible columns and their order will be discarded.",
          "Discard changes",
        ))
      )
        onClose();
    } finally {
      closing.current = false;
    }
  }
  function apply() {
    if (dirty) onApply(draft);
    onClose();
  }
  return (
    <>
      <Drawer
        isOpen
        onOpenChange={(open) => {
          if (!open) void close();
        }}
      >
        <Drawer.Backdrop isDismissable={false}>
          <Drawer.Content placement="right">
            <Drawer.Dialog className="record-editor-drawer">
              <Drawer.Header className="record-editor-header">
                <div>
                  <Drawer.Heading>Columns</Drawer.Heading>
                  <p className="text-sm text-muted">{tableName}</p>
                </div>
                <Drawer.CloseTrigger aria-label="Close columns" />
              </Drawer.Header>
              <form
                className="record-editor-form"
                aria-label="View columns"
                onSubmit={(event) => {
                  event.preventDefault();
                  apply();
                }}
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    apply();
                  }
                }}
              >
                <Drawer.Body className="record-editor-body">
                  <FieldTable
                    ariaLabel="View columns"
                    tableClassName="min-w-sm"
                    items={orderedViewFields(fields, draft)}
                    disabled={false}
                    emptyAction={null}
                    onReorder={(columnOrder) =>
                      setDraft((current) => ({ ...current, columnOrder }))
                    }
                    columns={[
                      {
                        key: "field",
                        header: "Column",
                        cell: (field) => (
                          <span className="inline-flex items-center gap-2">
                            <FieldTypeIcon type={field.type} />
                            {field.name}
                          </span>
                        ),
                      },
                      {
                        key: "visible",
                        header: "Visible",
                        cell: (field) => (
                          <Checkbox
                            aria-label={`Show ${field.name}`}
                            isSelected={!draft.hiddenColumns.includes(field.id)}
                            onChange={(shown) =>
                              setDraft((current) => {
                                const hiddenColumns = shown
                                  ? current.hiddenColumns.filter(
                                      (id) => id !== field.id,
                                    )
                                  : [...current.hiddenColumns, field.id];
                                return {
                                  ...current,
                                  hiddenColumns,
                                  frozenColumns: Math.min(
                                    current.frozenColumns,
                                    fields.length - hiddenColumns.length,
                                  ),
                                };
                              })
                            }
                          >
                            <Checkbox.Content
                              className="field-visibility-checkbox min-w-11 justify-center"
                              aria-label={`Show ${field.name}`}
                            >
                              <Checkbox.Control>
                                <Checkbox.Indicator />
                              </Checkbox.Control>
                            </Checkbox.Content>
                          </Checkbox>
                        ),
                      },
                    ]}
                  />
                </Drawer.Body>
                <Drawer.Footer className="record-editor-footer">
                  <Button variant="secondary" onPress={() => void close()}>
                    Cancel
                  </Button>
                  <Button type="submit" isDisabled={!dirty}>
                    <Check />
                    Save changes
                  </Button>
                </Drawer.Footer>
              </form>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
      {confirmation.dialog}
    </>
  );
}
