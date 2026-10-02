CREATE INDEX cell_changes_snapshot ON rootset_control.cell_changes(org_id,database_id,coalesce(restore_sequence,id));
CREATE INDEX row_events_snapshot ON rootset_control.row_events(org_id,database_id,coalesce(restore_sequence,id));
CREATE INDEX resource_history_snapshot ON rootset_control.resource_history(org_id,database_id,coalesce(restore_sequence,id));
CREATE INDEX mutations_snapshot ON rootset_control.mutations(org_id,coalesce(restore_original_id,id));
CREATE INDEX schema_operations_snapshot ON rootset_control.schema_operations(org_id,database_id,coalesce(restore_original_id,id));
CREATE INDEX history_gaps_snapshot ON rootset_control.history_gaps(org_id,table_id,coalesce(restore_original_id,id));
