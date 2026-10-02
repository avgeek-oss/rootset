CREATE UNIQUE INDEX history_gaps_archive ON rootset_control.history_gaps(org_id,table_id,(manifest->>'archiveId')) WHERE manifest ? 'archiveId';
CREATE INDEX cell_changes_snapshot_private ON rootset_control.cell_changes(org_id,database_id,id);
CREATE INDEX row_events_snapshot_private ON rootset_control.row_events(org_id,database_id,id);
CREATE INDEX resource_history_snapshot_private ON rootset_control.resource_history(org_id,database_id,id);
CREATE INDEX row_events_archive_range ON rootset_control.row_events(org_id,table_id,changed_at,id);
CREATE INDEX mutations_snapshot_private ON rootset_control.mutations(org_id,table_id,id);
CREATE INDEX schema_operations_snapshot_private ON rootset_control.schema_operations(org_id,database_id,id);
