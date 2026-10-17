import { z } from "zod";
import type { ActivityCategory, ActivityEvent } from "./activity";

export interface ActivityAction {
  operation: string;
  category: ActivityCategory;
  label: string;
  destination: ActivityEvent["destination"];
}
export const schemaActions: ActivityAction[] = [
  ["database.create", "Database created", "database"],
  ["database.update", "Database updated", "database"],
  ["database.delete", "Database deleted", null],
  ["table.create", "Table created", "table"],
  ["table.update", "Table updated", "table"],
  ["table.delete", "Table deleted", null],
  ["field.create", "Field added", "table"],
  ["field.update", "Field updated", "table"],
  ["field.convert", "Field converted", "table"],
  ["field.delete", "Field deleted", "table"],
  ["fields.reorder", "Fields reordered", "table"],
  ["rule.create", "Unique rule created", "table"],
  ["rule.delete", "Unique rule deleted", "table"],
  ["foreign-key.create", "Foreign key created", "table"],
  ["foreign-key.delete", "Foreign key deleted", "table"],
].map(([operation, label, destination]) => ({
  operation: operation!,
  label: label!,
  category: "schema",
  destination: destination as ActivityEvent["destination"],
}));
export const backupActions: ActivityAction[] = [
  {
    operation: "database.backup_schedule.update",
    category: "backups",
    label: "Backup schedule saved",
    destination: "backup-schedule",
  },
  {
    operation: "database.backup_schedule.delete",
    category: "backups",
    label: "Backup schedule stopped",
    destination: "backup-schedule",
  },
  {
    operation: "database.backup_policy.update",
    category: "backups",
    label: "Backup protection updated",
    destination: "backup-schedule",
  },
  {
    operation: "database.backup.prune",
    category: "backups",
    label: "Backup package pruned",
    destination: "backup-history",
  },
  {
    operation: "database.restore",
    category: "restores",
    label: "Database restored",
    destination: "database",
  },
];
export const jobActions: ActivityAction[] = [
  {
    operation: "previewImportRows",
    category: "imports",
    label: "Import validation",
    destination: "imports",
  },
  {
    operation: "importRows",
    category: "imports",
    label: "Record import",
    destination: "imports",
  },
  {
    operation: "exportRows",
    category: "exports",
    label: "Table export",
    destination: "exports",
  },
  {
    operation: "exportView",
    category: "exports",
    label: "View export",
    destination: "exports",
  },
  {
    operation: "exportDatabase",
    category: "exports",
    label: "Database export",
    destination: "database-exports",
  },
  {
    operation: "saveBackupSchedule",
    category: "backups",
    label: "Backup destination verification",
    destination: "backup-schedule",
  },
  {
    operation: "testBackupDestination",
    category: "backups",
    label: "Backup destination test",
    destination: "backup-history",
  },
  {
    operation: "runDatabaseBackup",
    category: "backups",
    label: "Database backup",
    destination: "backup-history",
  },
  {
    operation: "previewDatabaseRestore",
    category: "restores",
    label: "Backup verification",
    destination: "backup-history",
  },
  {
    operation: "restoreDatabaseBackup",
    category: "restores",
    label: "Database restore",
    destination: "backup-history",
  },
  ...[
    ["createTable", "Table creation"],
    ["updateTable", "Table update"],
    ["deleteTable", "Table deletion"],
    ["createField", "Field creation"],
    ["updateField", "Field update"],
    ["deleteField", "Field deletion"],
    ["applySchemaChange", "Schema change"],
    ["reorderFields", "Field reordering"],
    ["createUniqueRule", "Unique rule creation"],
    ["deleteUniqueRule", "Unique rule deletion"],
    ["createForeignKey", "Foreign key creation"],
    ["deleteForeignKey", "Foreign key deletion"],
    ["deleteDatabase", "Database deletion"],
  ].map(([operation, label]): ActivityAction => ({
    operation: operation!,
    label: label!,
    category: "schema",
    destination: null,
  })),
];

export type ActivityIcon =
  | "records"
  | "database"
  | "table"
  | "field"
  | "unique-rule"
  | "foreign-key"
  | "import"
  | "export"
  | "backup"
  | "schedule"
  | "alert"
  | "restore"
  | "cleanup";
export interface ActivityEventDefinition {
  name: string;
  label: string;
  category: ActivityCategory;
  icon: ActivityIcon;
}
function actionIcon(action: ActivityAction): ActivityIcon {
  if (action.operation === "database.backup.prune") return "cleanup";
  if (action.category === "imports") return "import";
  if (action.category === "exports") return "export";
  if (action.category === "restores") return "restore";
  if (action.category === "backups")
    return action.destination === "backup-schedule" ? "schedule" : "backup";
  if (/foreign-key|ForeignKey/.test(action.operation)) return "foreign-key";
  if (/^rule\.|UniqueRule/.test(action.operation)) return "unique-rule";
  if (/^field|Field|Schema/.test(action.operation)) return "field";
  if (/database|Database/.test(action.operation)) return "database";
  return "table";
}
export const activityJobOutcomes = {
  queued: "requested",
  succeeded: "completed",
  failed: "failed",
  cancelled: "cancelled",
  partially_completed: "partially completed",
} as const;
export const activityEventDefinitions: ActivityEventDefinition[] = [
  {
    name: "records.changed",
    label: "Records changed",
    category: "records" as const,
    icon: "records" as const,
  },
  ...[...schemaActions, ...backupActions].map((action) => ({
    name: action.operation,
    label: action.label,
    category: action.category,
    icon: actionIcon(action),
  })),
  ...jobActions.flatMap((action) =>
    Object.entries(activityJobOutcomes)
      .filter(
        ([state]) =>
          !(
            state === "succeeded" &&
            (action.category === "schema" ||
              ["restoreDatabaseBackup", "saveBackupSchedule"].includes(
                action.operation,
              ))
          ),
      )
      .map(([state, outcome]) => ({
        name: `job.${action.operation}.${state}`,
        label: `${action.label} ${outcome}`,
        category: action.category,
        icon: actionIcon(action),
      })),
  ),
  ...["failed", "overdue"].flatMap((kind) =>
    ["detected", "resolved"].map((phase) => ({
      name: `backup.${kind}.${phase}`,
      label: `Backup ${kind === "failed" ? "failure" : "overdue"} ${phase}`,
      category: "backups" as const,
      icon: "alert" as const,
    })),
  ),
].sort((a, b) => a.label.localeCompare(b.label));
export const activityEventCatalog = Object.fromEntries(
  activityEventDefinitions.map((event) => [event.name, event]),
);
export const ActivityEventNameSchema = z.enum(
  activityEventDefinitions.map((event) => event.name) as [string, ...string[]],
);
