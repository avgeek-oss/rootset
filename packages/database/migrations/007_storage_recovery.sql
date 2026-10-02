ALTER TABLE rootset_control.schema_operations ADD COLUMN restore_original_id varchar(26),ADD COLUMN restore_original_state text,ADD COLUMN restore_original_key text;
ALTER TABLE rootset_control.mutations ADD COLUMN restore_original_id varchar(26);
ALTER TABLE rootset_control.row_events ADD COLUMN restore_sequence bigint;
ALTER TABLE rootset_control.resource_history ADD COLUMN restore_sequence bigint;
ALTER TABLE rootset_control.cell_changes ADD COLUMN restore_sequence bigint;
ALTER TABLE rootset_control.history_gaps ADD COLUMN restore_original_id varchar(26);
CREATE INDEX mutations_restore_order ON rootset_control.mutations(org_id,table_id,restore_original_id);
