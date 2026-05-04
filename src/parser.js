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
  const tokens = splitByDelimiter(expr.trim(), "+").map((t) => t.trim());
  const resultParts = [];
  let placeholderGroup = [];

  const flushGroup = () => {
    if (placeholderGroup.length === 0) return;
    const placeholder = toPlaceholder(placeholderGroup.join("_"));
    const lastPart = resultParts.length > 0 ? resultParts[resultParts.length - 1] : null;

    // Check if the previous part was a string literal ending in a quote
    if (lastPart && typeof lastPart === 'string' && (lastPart.endsWith("'") || lastPart.endsWith('"'))) {
      // Strip the quote from the previous part
      resultParts[resultParts.length - 1] = lastPart.slice(0, -1);
      resultParts.push(placeholder);
    } else {
      resultParts.push(placeholder);
    }
    placeholderGroup = [];
  };

  for (const tok of tokens) {
    if (/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(tok)) {
      placeholderGroup.push(tok);
    } else if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))) {
      flushGroup();
      let literal = tok.slice(1, -1);
      // If the last part was a placeholder, check if this literal starts with a quote
      const lastPart = resultParts[resultParts.length - 1];
      if (lastPart && lastPart.startsWith(':') && (literal.startsWith("'") || literal.startsWith('"'))) {
        literal = literal.slice(1);
      }
      resultParts.push(literal);
    } else {
      flushGroup();
      resultParts.push(tok); // For bare numbers or other expressions
    }
  }
  flushGroup();
  return resultParts.join("");
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
  // Regex to find the start of a method call. We don't use the global flag here,
  // as we will control the search index manually.
  const methodPattern = /(?:^|;|\n|\.)\s*(SELECT|FROM|LEFT_OUTER_JOIN|LEFT_JOIN|INNER_JOIN|JOIN|RIGHT_OUTER_JOIN|RIGHT_JOIN|WHERE|AND|OR|ORDER_BY|GROUP_BY|HAVING|LIMIT|OFFSET|SET|INTO|VALUES|UPDATE|DELETE_FROM)\s*\(/im;

  let searchIndex = 0;
  while (searchIndex < source.length) {
    const searchSlice = source.substring(searchIndex);
    const match = searchSlice.match(methodPattern);

    if (!match) break; // No more methods found

    const method = match[1].toUpperCase();
    // Adjust index to be relative to the full source string
    const openParenIndex = searchIndex + match.index + match[0].length - 1;

    let depth = 1;
    let inDoubleQuote = false;
    let inSingleQuote = false;

    let i = openParenIndex + 1;
    for (; i < source.length; i++) {
      const char = source[i];
      const prevChar = source[i - 1];

      if (char === '"' && !inSingleQuote && prevChar !== '\\') inDoubleQuote = !inDoubleQuote;
      else if (char === "'" && !inDoubleQuote && prevChar !== '\\') inSingleQuote = !inSingleQuote;
      else if (!inSingleQuote && !inDoubleQuote && char === '(') depth++;
      else if (!inSingleQuote && !inDoubleQuote && char === ')') depth--;

      if (depth === 0) break;
    }

    const content = source.substring(openParenIndex + 1, i).trim();
    calls.push({ method, content });
    searchIndex = i + 1; // Start next search after the current call
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
  let useOr = false; // State to track if the next condition should be OR

  const relevantCalls = calls.filter(({ method }) => ["WHERE", "AND", "OR"].includes(method));

  for (const { method, content } of relevantCalls) {
    if (method === "OR") {
      // If OR() is called, set the flag for the next condition.
      // Only set if there are already conditions to join with.
      if (conditions.length > 0) {
        useOr = true;
      }
      continue;
    }

    const val = evalJavaStringExpr(content).trim();
    if (!val) continue; // Ignore empty WHERE("") or AND("")

    const cleaned = val.replace(/\s+/g, " ").trim();
    const joiner = conditions.length === 0 ? "" : useOr ? "OR " : "AND ";
    conditions.push(joiner + formatCondition(cleaned));
    useOr = false; // Reset the flag after using it
  }

  if (conditions.length === 0) return "";
  const indent = "    ";
  return "WHERE\n" + indent + conditions.join("\n" + indent);
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
  return splitByDelimiter(str, /^\s+OR\s+/i);
}

function splitByDelimiter(str, delim) {
  const parts = [];
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  let cur = "";
  const isRegex = delim instanceof RegExp;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = str[i - 1];

    if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    else if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (!inDouble && !inSingle) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;

      if (depth === 0) {
        if (isRegex) {
          const match = str.slice(i).match(delim);
          if (match && match.index === 0) {
            parts.push(cur);
            cur = "";
            i += match[0].length - 1;
            continue;
          }
        } else if (str.slice(i, i + delim.length) === delim) {
          parts.push(cur);
          cur = "";
          i += delim.length - 1;
          continue;
        }
      }
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.length > 0 ? parts : [str];
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
