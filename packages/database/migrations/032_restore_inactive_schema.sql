ALTER TABLE rootset_control.unique_rules
 ADD COLUMN restore_original_state text,
 ADD COLUMN restore_original_error jsonb;
ALTER TABLE rootset_control.indexes
 ADD COLUMN restore_original_state text,
 ADD COLUMN restore_original_error jsonb;

COMMENT ON COLUMN rootset_control.unique_rules.restore_original_state IS
 'Source backup attribution for inactive definitions. Incomplete source work restores as failed and is never resumed automatically.';
COMMENT ON COLUMN rootset_control.indexes.restore_original_state IS
 'Source backup attribution for inactive definitions. Native indexes are rebuilt only for committed active definitions.';
