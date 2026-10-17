CREATE UNIQUE INDEX jobs_one_import_per_preview ON rootset_control.jobs
  (org_id,target_id,(input->>'previewId')) WHERE kind='import';
