-- Approved policies and durable job admission share the identity transaction
-- with the consumed approval and replay receipt. Runtime identity retains the
-- same forced organisation policies and cannot delete control records.
GRANT SELECT,INSERT,UPDATE ON
 rootset_control.backup_policies,
 rootset_control.history_retention_policies,
 rootset_control.jobs,
 rootset_control.backups
TO rootset_identity;
