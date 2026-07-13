-- Toggle for whether the mock WorkOS endpoint emits DSync events to the native
-- listener. On (default) closes the cutover loop self-contained; turn off when
-- driving the listener from a real WorkOS webhook instead (so events aren't
-- delivered twice).
INSERT OR IGNORE INTO poc_config (key, value) VALUES ('mock_workos.emit_dsync', 'true');
