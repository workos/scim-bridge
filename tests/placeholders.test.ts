import { describe, expect, it } from "vitest";
import { rewritePlaceholders } from "../server/db/placeholders";

/**
 * `?` → `$n` for the Postgres driver. The cases that matter are the ones where a
 * `?` is *not* a placeholder: renumbering one inside a string literal would
 * corrupt the statement silently, which is why the driver also asserts the count
 * against the bound parameters on every execution.
 */
describe("rewritePlaceholders", () => {
  it("numbers placeholders in order", () => {
    expect(rewritePlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toEqual({
      sql: "SELECT * FROM t WHERE a = $1 AND b = $2",
      count: 2,
    });
  });

  it("numbers a dynamic IN list", () => {
    // setDirectoriesLogPersistence and reconcileDirectories build these.
    expect(rewritePlaceholders("DELETE FROM t WHERE id NOT IN (?, ?, ?)").sql).toBe(
      "DELETE FROM t WHERE id NOT IN ($1, $2, $3)",
    );
  });

  it("leaves a question mark inside a string literal alone", () => {
    expect(rewritePlaceholders("SELECT * FROM t WHERE detail = 'why?' AND id = ?")).toEqual({
      sql: "SELECT * FROM t WHERE detail = 'why?' AND id = $1",
      count: 1,
    });
  });

  it("handles a doubled quote inside a literal, then keeps counting", () => {
    expect(
      rewritePlaceholders("SELECT * FROM t WHERE a = 'it''s a ?' AND b = ? AND c = ?"),
    ).toEqual({
      sql: "SELECT * FROM t WHERE a = 'it''s a ?' AND b = $1 AND c = $2",
      count: 2,
    });
  });

  it("leaves a question mark inside a quoted identifier alone", () => {
    expect(rewritePlaceholders('SELECT "odd?column" FROM t WHERE a = ?')).toEqual({
      sql: 'SELECT "odd?column" FROM t WHERE a = $1',
      count: 1,
    });
  });

  it("leaves question marks inside comments alone", () => {
    expect(rewritePlaceholders("SELECT 1 -- really? yes\nWHERE a = ?")).toEqual({
      sql: "SELECT 1 -- really? yes\nWHERE a = $1",
      count: 1,
    });
    expect(rewritePlaceholders("SELECT 1 /* what? */ WHERE a = ?")).toEqual({
      sql: "SELECT 1 /* what? */ WHERE a = $1",
      count: 1,
    });
  });

  it("leaves a dollar-quoted body alone", () => {
    // The Postgres baseline defines its datetime() shim with one of these.
    const sql = "CREATE FUNCTION f() RETURNS text AS $fn$ SELECT 'a? b' $fn$ LANGUAGE sql";
    expect(rewritePlaceholders(sql)).toEqual({ sql, count: 0 });
  });

  it("counts nothing in a statement without placeholders", () => {
    expect(rewritePlaceholders("SELECT 1")).toEqual({ sql: "SELECT 1", count: 0 });
  });

  it("does not run off the end of an unterminated literal", () => {
    // Malformed SQL is the server's to reject, not this scanner's to crash on.
    expect(rewritePlaceholders("SELECT * FROM t WHERE a = 'oops ?")).toEqual({
      sql: "SELECT * FROM t WHERE a = 'oops ?",
      count: 0,
    });
  });

  it("rewrites every real statement in the codebase to a stable count", () => {
    // A regression net for the scanner itself: these are the shapes the app
    // actually issues, including the string-concatenated ones.
    const cases: [string, number][] = [
      ["SELECT value FROM poc_config WHERE key = ?", 1],
      [
        "INSERT INTO poc_config (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        2,
      ],
      [
        "INSERT INTO scim_directories " +
          "(id, name, native_url, native_token, workos_url, workos_token, workos_directory_id, proxy_token) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        8,
      ],
      ["SELECT * FROM scim_directories ORDER BY created_at, name, id", 0],
      [
        "SELECT 1 AS one FROM listener_events " +
          "WHERE event_id IS NOT NULL AND event_id = ? AND action <> 'ignored' LIMIT 1",
        1,
      ],
      ["SELECT * FROM native_users WHERE lower(user_name) = lower(?)", 1],
    ];

    for (const [sql, count] of cases) {
      const rewritten = rewritePlaceholders(sql);
      expect(rewritten.count, sql).toBe(count);
      expect(rewritten.sql.includes("?"), sql).toBe(false);
    }
  });
});
