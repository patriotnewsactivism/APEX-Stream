-- APEX Stream — correct the evidence-deletion trigger's error hint, which
-- still named S3 Object Lock after evidence storage moved to GCS. The
-- function is CREATE OR REPLACE, so redefining it here does not touch
-- 001_initial_schema.sql (already applied; see migrate.ts's checksum guard)
-- and requires no schema change of its own.

CREATE OR REPLACE FUNCTION refuse_evidence_deletion() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evidence rows are immutable until their retention date (id=%)', OLD.id
    USING HINT = 'the underlying object is under a storage-level retention lock (GCS Object Retention Lock) in compliance mode';
END;
$$ LANGUAGE plpgsql;
