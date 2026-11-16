-- Which directory a native row belongs to, for the reference listener.
--
-- One native-app stand-in can serve several directories, and its tables are a
-- single namespace. Without an owner, the listener's attribute fallback
-- (externalId, userName, displayName) could bind an authentic event from one
-- directory to another directory's row and rewrite it or its memberships.
-- The listener stamps the directory it resolved for an event on every row it
-- creates or matches, and only falls back onto rows owned by that directory.
-- NULL means "not yet claimed" (rows written over SCIM, or before this column).
ALTER TABLE native_users ADD COLUMN directory_id TEXT;
ALTER TABLE native_groups ADD COLUMN directory_id TEXT;
