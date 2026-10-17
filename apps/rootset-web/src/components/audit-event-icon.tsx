import {
  Alert02Icon,
  Calendar03Icon,
  DatabaseIcon,
  DatabaseRestoreIcon,
  Delete02Icon,
  Download01Icon,
  Link01Icon,
  ListViewIcon,
  Shield01Icon,
  TableIcon,
  TablePropertiesIcon,
  TransactionHistoryIcon,
  Upload01Icon,
  UserAccountIcon,
  WorkflowIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ActivityIcon } from "@rootset/contracts";

const icons = {
  records: ListViewIcon,
  database: DatabaseIcon,
  table: TableIcon,
  field: TablePropertiesIcon,
  "unique-rule": Shield01Icon,
  "foreign-key": Link01Icon,
  import: Upload01Icon,
  export: Download01Icon,
  backup: DatabaseIcon,
  schedule: Calendar03Icon,
  alert: Alert02Icon,
  restore: DatabaseRestoreIcon,
  cleanup: Delete02Icon,
  actor: UserAccountIcon,
  resource: DatabaseIcon,
  event: TransactionHistoryIcon,
  automation: WorkflowIcon,
} satisfies Record<
  ActivityIcon | "actor" | "resource" | "event" | "automation",
  typeof TableIcon
>;

export function AuditEventIcon({ icon }: { icon: keyof typeof icons }) {
  return (
    <HugeiconsIcon
      icon={icons[icon]}
      size={16}
      className="shrink-0 text-muted"
      aria-hidden
    />
  );
}
