"use client";
import { Modal } from "@heroui/react";
import type { ReactNode } from "react";

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  closeDisabled = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open && !closeDisabled) onClose();
      }}
    >
      <Modal.Backdrop
        isDismissable={false}
        isKeyboardDismissDisabled={closeDisabled}
      >
        <Modal.Container>
          <Modal.Dialog className={`rootset-dialog ${wide ? "wide" : ""}`}>
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
              <Modal.CloseTrigger
                aria-label="Close dialog"
                isDisabled={closeDisabled}
              />
            </Modal.Header>
            <Modal.Body>{children}</Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
