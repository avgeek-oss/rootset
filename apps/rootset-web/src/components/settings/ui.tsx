"use client";

import {
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Switch,
  TextArea,
  TextField,
} from "@heroui/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { showSettingsError, type SettingsError } from "./api";
import { toast } from "@avgeek-oss/design-system/overlays/toast";

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section widget">
      <header className="widget__header">
        <h2 className="widget__title">{title}</h2>
      </header>
      <div className="widget__content">
        {description && (
          <p className="settings-section-description">{description}</p>
        )}
        {children}
      </div>
    </section>
  );
}

export function Field({
  label,
  value,
  onChange,
  onBlur,
  type = "text",
  description,
  required,
  min,
  max,
  step,
  pattern,
  minLength,
  maxLength,
  error,
  autoComplete,
  readOnly,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  type?: string;
  description?: string;
  required?: boolean;
  min?: number | string;
  max?: number | string;
  step?: string | number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  error?: string;
  autoComplete?: string;
  readOnly?: boolean;
  multiline?: boolean;
}) {
  return (
    <TextField
      className="settings-field"
      type={type}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      isRequired={required}
      isInvalid={Boolean(error)}
      isReadOnly={readOnly}
    >
      <Label>{label}</Label>
      {multiline ? (
        <TextArea
          variant="secondary"
          rows={3}
          autoComplete={autoComplete ?? "off"}
        />
      ) : (
        <Input
          variant="secondary"
          min={min}
          max={max}
          step={step}
          pattern={pattern}
          minLength={minLength}
          maxLength={maxLength}
          autoComplete={autoComplete ?? "off"}
          spellCheck={false}
        />
      )}
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        description && <Description>{description}</Description>
      )}
    </TextField>
  );
}

export function Choice({
  label,
  value,
  onChange,
  options,
  description,
  required,
  error,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (
    string | { value: string; label: string; icon?: ReactNode }
  )[];
  description?: string;
  required?: boolean;
  error?: string;
  disabled?: boolean;
}) {
  const items: { value: string; label: string; icon?: ReactNode }[] =
    options.map((option) =>
      typeof option === "string" ? { value: option, label: option } : option,
    );
  const selected = items.find((item) => item.value === value);
  return (
    <Select
      variant="secondary"
      className="settings-field"
      value={value || null}
      onChange={(key) => onChange(String(key ?? ""))}
      isRequired={required}
      isInvalid={Boolean(error)}
      isDisabled={disabled}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        {selected?.icon ? (
          <Select.Value>
            <span className="flex items-center gap-2">
              {selected.icon}
              {selected.label}
            </span>
          </Select.Value>
        ) : (
          <Select.Value />
        )}
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => {
            return (
              <ListBox.Item
                key={item.value}
                id={item.value}
                textValue={item.label}
              >
                {item.icon ? (
                  <span className="flex items-center gap-2">
                    {item.icon}
                    {item.label}
                  </span>
                ) : (
                  item.label
                )}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            );
          })}
        </ListBox>
      </Select.Popover>
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        description && <Description>{description}</Description>
      )}
    </Select>
  );
}

export function Toggle({
  label,
  selected,
  onChange,
  description,
}: {
  label: string;
  selected: boolean;
  onChange: (value: boolean) => void;
  description?: string;
}) {
  return (
    <Switch
      className="settings-toggle"
      isSelected={selected}
      onChange={onChange}
    >
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        {label}
      </Switch.Content>
      {description && <Description>{description}</Description>}
    </Switch>
  );
}

export function Form({
  children,
  busy,
  onSubmit,
  submit = "Save changes",
  onCancel,
  noValidate = false,
}: {
  children: ReactNode;
  busy: boolean;
  onSubmit: () => void | Promise<void>;
  submit?: string;
  onCancel?: () => void;
  noValidate?: boolean;
}) {
  function submitForm(event: FormEvent) {
    event.preventDefault();
    if (!busy) void onSubmit();
  }
  return (
    <form
      className="settings-form"
      onSubmit={submitForm}
      aria-busy={busy}
      noValidate={noValidate}
    >
      <fieldset disabled={busy}>{children}</fieldset>
      <div className="settings-actions">
        {onCancel && (
          <Button variant="secondary" isDisabled={busy} onPress={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" isPending={busy} isDisabled={busy}>
          {busy ? "Working…" : submit}
        </Button>
      </div>
    </form>
  );
}

export function Loading({
  error,
  retry,
}: {
  loading: boolean;
  error?: SettingsError;
  retry: () => void;
}) {
  useEffect(() => {
    if (!error) return;
    const id = showSettingsError(error, retry);
    if (!id) return;
    return () => toast.close(id);
  }, [error, retry]);
  return null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="settings-empty">{children}</p>;
}

export function useConfirmation() {
  const [pending, setPending] = useState<{
    title: string;
    message: string;
    label: string;
    resolve: (approved: boolean) => void;
  }>();
  const current = useRef(pending);
  current.current = pending;
  useEffect(() => () => current.current?.resolve(false), []);
  function decide(approved: boolean) {
    pending?.resolve(approved);
    setPending(undefined);
  }
  return {
    confirm: (title: string, message: string, label = "Confirm") =>
      new Promise<boolean>((resolve) =>
        setPending({ title, message, label, resolve }),
      ),
    dialog: (
      <Modal
        isOpen={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open) decide(false);
        }}
      >
        <Modal.Backdrop>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>{pending?.title}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p>{pending?.message}</p>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={() => decide(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onPress={() => decide(true)}>
                  {pending?.label}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    ),
  };
}

export function DateLabel({ value }: { value?: string | null }) {
  return <span>{value ? new Date(value).toLocaleString() : "—"}</span>;
}
export function RecordList({ children }: { children: ReactNode }) {
  return <ul className="settings-records">{children}</ul>;
}
export function Record({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="settings-record">
      <div className="settings-record-content">
        <strong>{title}</strong>
        {description && <div className="settings-muted">{description}</div>}
      </div>
      <div className="settings-record-actions">{children}</div>
    </li>
  );
}
