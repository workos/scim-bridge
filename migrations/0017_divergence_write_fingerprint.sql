-- A live write may retire a `native_write_failures` row only when it proves the
-- recorded divergence was repaired. A later write to the same resource is not
-- that proof: a display-name PATCH does not apply an earlier failed membership
-- removal, and a create native rejected applies nothing at all.
--
-- `write_fingerprint` names the exact failed write (method, resource, body), so
-- the IdP's retry of that write can retire it. A row that has absorbed failures
-- of different writes keeps a NULL fingerprint and waits for a reconcile or a
-- converged delete, the same as rows recorded before this column existed.
ALTER TABLE native_write_failures ADD COLUMN write_fingerprint TEXT;
