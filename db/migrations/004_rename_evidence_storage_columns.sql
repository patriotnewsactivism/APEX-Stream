-- APEX Stream — rename evidence storage columns from S3-specific to
-- storage-provider-neutral names, as part of removing the AWS dependency.
-- A rename, not a drop/add: no data loss, and this is a separate migration
-- rather than an edit to 001_initial_schema.sql because that file has
-- already run in any environment that has bootstrapped once (see
-- services/orchestrator/src/migrate.ts's checksum guard).

ALTER TABLE evidence RENAME COLUMN s3_bucket TO storage_bucket;
ALTER TABLE evidence RENAME COLUMN s3_key TO storage_key;
ALTER TABLE evidence RENAME COLUMN s3_version_id TO storage_generation;
