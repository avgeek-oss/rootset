import { UserAvatar } from "@avgeek-oss/design-system/patterns/user-avatar";
import { AuditEventIcon } from "./audit-event-icon";

export function isAutomationActor(kind?: string | null) {
  return kind === "operator" || kind === "system" || kind === "automation";
}

export function AuditActorIcon({
  kind,
  name,
  avatarUrl,
}: {
  kind?: string | null;
  name: string;
  avatarUrl?: string | null;
}) {
  return isAutomationActor(kind) ? (
    <AuditEventIcon icon="automation" />
  ) : (
    <UserAvatar
      email=""
      name={name}
      src={avatarUrl ?? undefined}
      size="sm"
      className="shrink-0"
      aria-hidden="true"
    />
  );
}
