ALTER TABLE rootset_control.installation_settings ADD COLUMN runtime_revision bigint NOT NULL DEFAULT 0;
UPDATE rootset_control.installation_settings SET runtime_revision=revision;
