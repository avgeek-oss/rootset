import { BackupDestinationSchema, IdSchema } from "@rootset/contracts";
export function ownedBackupObject(source: {
  id: string;
  database_id: string;
  prefix: string;
  object_key: string;
}): boolean {
  const path = BackupDestinationSchema.shape.prefix.safeParse(source.prefix);
  if (
    !path.success ||
    path.data !== source.prefix ||
    !IdSchema.safeParse(source.id).success ||
    !IdSchema.safeParse(source.database_id).success
  )
    return false;
  const prefix =
    [source.prefix, source.database_id].filter(Boolean).join("/") + "/";
  const suffix = source.object_key.slice(prefix.length);
  return (
    source.object_key.startsWith(prefix) &&
    /^\d{4}\/\d{2}\/\d{2}\/[0-9A-HJKMNP-TV-Z]{26}-[0-9A-HJKMNP-TV-Z]{26}\.rootset-backup$/.test(
      suffix,
    ) &&
    suffix.includes(`/${source.id}-`)
  );
}
