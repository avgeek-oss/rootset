DROP TRIGGER jobs_activity ON rootset_control.jobs;
DROP FUNCTION rootset_control.record_job_activity();
DROP TABLE rootset_control.activity_job_events;
DROP INDEX rootset_control.activity_mutations_time;
DROP INDEX rootset_control.activity_cells_mutation;
DROP INDEX rootset_control.activity_resources_time;
