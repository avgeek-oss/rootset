ALTER TABLE rootset_control.backup_policies
  ADD COLUMN suspension_code text,
  ADD COLUMN suspended_at timestamptz;

ALTER TABLE rootset_control.backup_policies
  ADD CONSTRAINT backup_policy_suspension_pair
  CHECK ((suspension_code IS NULL) = (suspended_at IS NULL));
