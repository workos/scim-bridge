/**
 * Rewrite SQLite-style `?` placeholders to Postgres `$1…$n`.
 *
 * Not a regex: `?` is only a placeholder outside string literals, quoted
 * identifiers and comments, and a `WHERE detail = 'why?'` that got renumbered
 * would corrupt the statement in a way no error would report. So this walks the
 * statement once, tracking lexical state, and rewrites only at depth zero.
 *
 * The codebase has no literal `?` in SQL today; the risk is entirely in SQL
 * written later, which is why `rewritePlaceholders` also returns the count so the
 * driver can assert it against the parameter list on every execution.
 */

export interface RewrittenSql {
  sql: string;
  /** How many placeholders were rewritten — must equal the bound parameters. */
  count: number;
}

export function rewritePlaceholders(sql: string): RewrittenSql {
  let out = "";
  let count = 0;
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    // '…' string literal; '' inside it is an escaped quote, not the end.
    if (char === "'") {
      const end = closingQuote(sql, index, "'");
      out += sql.slice(index, end);
      index = end;
      continue;
    }

    // "…" quoted identifier; "" likewise.
    if (char === '"') {
      const end = closingQuote(sql, index, '"');
      out += sql.slice(index, end);
      index = end;
      continue;
    }

    // $tag$…$tag$ dollar-quoted string. Nothing here emits one, but the Postgres
    // baseline schema does, and a scanner that mis-reads one is worse than a
    // scanner that knows about it.
    const dollarTag = dollarQuoteTag(sql, index);
    if (dollarTag) {
      const close = sql.indexOf(dollarTag, index + dollarTag.length);
      const end = close === -1 ? sql.length : close + dollarTag.length;
      out += sql.slice(index, end);
      index = end;
      continue;
    }

    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      const end = newline === -1 ? sql.length : newline;
      out += sql.slice(index, end);
      index = end;
      continue;
    }

    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += sql.slice(index, end);
      index = end;
      continue;
    }

    if (char === "?") {
      count += 1;
      out += `$${count}`;
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return { sql: out, count };
}

/** Index just past the closing quote, treating a doubled quote as an escape. */
function closingQuote(sql: string, open: number, quote: string): number {
  let index = open + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length; // unterminated — hand it to the server to complain about
}

/** `$$` or `$tag$` at this position, or null. */
function dollarQuoteTag(sql: string, index: number): string | null {
  if (sql[index] !== "$") return null;
  const match = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(index));
  return match ? match[0] : null;
}
