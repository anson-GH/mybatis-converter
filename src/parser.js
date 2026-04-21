/**
 * MyBatis SQL Builder → MySQL Parser
 * Pure local rule-based engine, no AI/network needed.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Evaluate a Java-style string concatenation expression into a plain string.
 * Handles:
 *   "literal"
 *   "literal" + Const.VALUE
 *   "literal" + Const.VALUE + " more"
 *   + someInt (bare number)
 */
function evalJavaStringExpr(expr) {
  // Tokenise by + that is not inside quotes
  const tokens = splitByPlus(expr.trim());
  return tokens
    .map((tok) => tok.trim())
    .map((tok) => {
      // Quoted string literal
      if ((tok.startsWith('"') && tok.endsWith('"')) ||
          (tok.startsWith("'") && tok.endsWith("'"))) {
        return tok.slice(1, -1);
      }
      // Bare integer / float literal
      if (/^-?\d+(\.\d+)?$/.test(tok)) return tok;
      // Java constant reference → placeholder
      if (/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(tok)) {
        return toPlaceholder(tok);
      }
      // Fallback: return as-is (already trimmed inner content)
      return tok;
    })
    .join("");
}

/**
 * Split a string by top-level '+' (not inside quotes or parens).
 */
function splitByPlus(str) {
  const parts = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let cur = "";

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = str[i - 1];

    if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    else if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (!inDouble && !inSingle) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "+" && depth === 0) {
        parts.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * Convert a Java constant reference to a SQL placeholder.
 * e.g. DBConst.RECORD_STATUS_ACTIVE_STR → :record_status_active_str
 *      PostingConst.MAX_RETRY            → :max_retry
 */
function toPlaceholder(ref) {
  // Take the last segment after the final dot
  const parts = ref.split(".");
  const name = parts[parts.length - 1];
  // Strip common suffixes that add no meaning
  const cleaned = name
    .replace(/_STR$/i, "")
    .replace(/_VAL$/i, "")
    .replace(/_VALUE$/i, "");
  return ":" + cleaned.toLowerCase();
}

// ─── Clause extractor ───────────────────────────────────────────────────────

/**
 * Extract all top-level method calls from source code.
 * Returns array of { method, content, start, end } where content is the raw argument string.
 *
 * Handles multi-line calls and nested parens inside the argument.
 * Only matches method names that appear at statement boundaries (after newline, semicolon, or start).
 */
function extractCalls(source) {
  const calls = [];
  // Only match method calls that start at a statement boundary
  // (beginning of line, after semicolon, or start of file)
  const methodPattern = /(?:^|;|\n)\s*(SELECT|FROM|LEFT_OUTER_JOIN|LEFT_JOIN|INNER_JOIN|JOIN|RIGHT_OUTER_JOIN|RIGHT_JOIN|WHERE|AND|OR|ORDER_BY|GROUP_BY|HAVING|LIMIT|OFFSET|SET|INTO|VALUES|UPDATE|DELETE_FROM)\s*\(/gim;

  let match;
  while ((match = methodPattern.exec(source)) !== null) {
    const method = match[1].toUpperCase();
    // Find the opening paren position
    const openParen = match.index + match[0].lastIndexOf("(");
    // Walk forward to find matching close paren
    let depth = 1;
    let i = openParen + 1;
    let inDouble = false;
    let inSingle = false;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      const prev = source[i - 1];
      if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
      else if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
      else if (!inDouble && !inSingle) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      i++;
    }
    const content = source.slice(openParen + 1, i - 1).trim();
    calls.push({ method, content, start: match.index, end: i });
  }
  return calls;
}

// ─── Clause builders ────────────────────────────────────────────────────────

function buildSelect(calls) {
  const cols = [];
  for (const { method, content } of calls) {
    if (method !== "SELECT") continue;
    const val = evalJavaStringExpr(content);
    // Split by comma, but only top-level commas
    splitTopLevelCommas(val).forEach((c) => {
      const col = c.trim();
      if (col) cols.push(col);
    });
  }
  if (cols.length === 0) return "SELECT *";
  const indent = "    ";
  return "SELECT\n" + cols.map((c) => indent + c).join(",\n");
}

function buildFrom(calls) {
  for (const { method, content } of calls) {
    if (method === "FROM") {
      return "FROM\n    " + evalJavaStringExpr(content).trim();
    }
  }
  return "";
}

function buildJoins(calls) {
  const lines = [];
  const joinMethods = ["LEFT_OUTER_JOIN", "LEFT_JOIN", "INNER_JOIN", "JOIN", "RIGHT_OUTER_JOIN", "RIGHT_JOIN"];
  for (const { method, content } of calls) {
    if (!joinMethods.includes(method)) continue;
    const keyword = method
      .replace("_OUTER_", " OUTER ")
      .replace("_", " ");
    const val = evalJavaStringExpr(content).trim();
    lines.push(keyword + " " + val);
  }
  return lines.join("\n");
}

function buildWhere(calls) {
  const conditions = [];
  for (const { method, content } of calls) {
    if (!["WHERE", "AND", "OR"].includes(method)) continue;
    const val = evalJavaStringExpr(content).trim();
    // Clean up extra whitespace within the condition
    const cleaned = val.replace(/\s+/g, " ").trim();
    conditions.push(cleaned);
  }
  if (conditions.length === 0) return "";
  if (conditions.length === 1) return "WHERE " + formatCondition(conditions[0]);
  const indent = "    ";
  return (
    "WHERE\n" +
    indent +
    conditions
      .map((c, i) => (i === 0 ? formatCondition(c) : "AND " + formatCondition(c)))
      .join("\n" + indent)
  );
}

function buildOrderBy(calls) {
  const parts = [];
  for (const { method, content } of calls) {
    if (method !== "ORDER_BY") continue;
    parts.push(evalJavaStringExpr(content).trim());
  }
  if (parts.length === 0) return "";
  return "ORDER BY " + parts.join(", ");
}

function buildGroupBy(calls) {
  const parts = [];
  for (const { method, content } of calls) {
    if (method !== "GROUP_BY") continue;
    parts.push(evalJavaStringExpr(content).trim());
  }
  if (parts.length === 0) return "";
  return "GROUP BY " + parts.join(", ");
}

function buildHaving(calls) {
  for (const { method, content } of calls) {
    if (method === "HAVING") {
      return "HAVING " + evalJavaStringExpr(content).trim();
    }
  }
  return "";
}

function buildLimit(calls) {
  for (const { method, content } of calls) {
    if (method === "LIMIT") {
      return "LIMIT " + evalJavaStringExpr(content).trim();
    }
  }
  return "";
}

function buildOffset(calls) {
  for (const { method, content } of calls) {
    if (method === "OFFSET") {
      return "OFFSET " + evalJavaStringExpr(content).trim();
    }
  }
  return "";
}

// ─── Condition formatter ─────────────────────────────────────────────────────

/**
 * Format a WHERE condition:
 * - Indent OR branches inside outer parens
 * - Normalise spacing around operators
 */
function formatCondition(cond) {
  // If condition is wrapped in outer parens, format the inside
  const inner = stripOuterParens(cond);
  if (inner !== cond) {
    // Has outer parens — format OR-split conditions inside
    const branches = splitTopLevelOr(inner);
    if (branches.length > 1) {
      const indent = "        ";
      return (
        "(\n" +
        indent +
        branches
          .map((b) => b.trim())
          .map((b, i) => (i === 0 ? formatLeafCondition(b) : "OR " + formatLeafCondition(b)))
          .join("\n" + indent) +
        "\n    )"
      );
    }
    return "(" + formatLeafCondition(inner.trim()) + ")";
  }
  return formatLeafCondition(cond);
}

function formatLeafCondition(cond) {
  // Normalise spacing around comparison operators
  return cond
    .replace(/\s*(=|!=|<>|<=|>=|<|>)\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── String utilities ────────────────────────────────────────────────────────

/** Split by top-level commas (not inside parens or quotes) */
function splitTopLevelCommas(str) {
  return splitByDelimiter(str, ",");
}

/** Split by top-level OR keyword (not inside parens or quotes) */
function splitTopLevelOr(str) {
  // Tokenise by whitespace-bounded OR
  const parts = [];
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  let cur = "";
  const tokens = str.split(/\b(OR)\b/i);
  // Reconstruct splitting only on top-level OR
  let buf = "";
  for (let i = 0; i < str.length; ) {
    const ch = str[i];
    const prev = str[i - 1];
    if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    else if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (!inDouble && !inSingle) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      // Check for " OR " at depth 0
      if (depth === 0 && str.slice(i).match(/^\s+OR\s+/i)) {
        const orMatch = str.slice(i).match(/^(\s+OR\s+)/i);
        parts.push(buf);
        buf = "";
        i += orMatch[1].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) parts.push(buf);
  return parts.length > 0 ? parts : [str];
}

function splitByDelimiter(str, delim) {
  const parts = [];
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  let cur = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = str[i - 1];
    if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    else if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (!inDouble && !inSingle) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === delim && depth === 0) {
        parts.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Remove a single layer of wrapping parens if present */
function stripOuterParens(str) {
  const s = str.trim();
  if (!s.startsWith("(") || !s.endsWith(")")) return str;
  // Verify the opening paren matches the closing paren
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    if (depth === 0 && i < s.length - 1) return str; // closes before end
  }
  return s.slice(1, -1);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Parse MyBatis SQL Builder source and return formatted MySQL SQL string.
 */
export function parse(source) {
  if (!source || !source.trim()) throw new Error("输入为空");

  const calls = extractCalls(source);
  if (calls.length === 0) throw new Error("未找到 SQL Builder 方法调用（SELECT / FROM / WHERE 等）");

  const parts = [
    buildSelect(calls),
    buildFrom(calls),
    buildJoins(calls),
    buildWhere(calls),
    buildGroupBy(calls),
    buildHaving(calls),
    buildOrderBy(calls),
    buildLimit(calls),
    buildOffset(calls),
  ].filter(Boolean);

  return parts.join("\n") + ";";
}

/**
 * Return a list of detected placeholders for display.
 */
export function listPlaceholders(sql) {
  const found = new Set();
  const re = /:[a-z_]+/g;
  let m;
  while ((m = re.exec(sql)) !== null) found.add(m[0]);
  return [...found].sort();
}
