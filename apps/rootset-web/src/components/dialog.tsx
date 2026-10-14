"use client";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import type { ReactNode } from "react";

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  closeDisabled = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  closeDisabled?: boolean;
  className?: string;
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
          <Modal.Dialog
            className={`rootset-dialog ${wide ? "wide" : ""} ${className}`}
          >
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
