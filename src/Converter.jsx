import { useState, useCallback } from "react";
import React from "react";
import { parse, listPlaceholders } from "./parser";

const EXAMPLE = `SELECT("p.posting_status, p.grp_req_reference_no, p.grp_res_batch_number");
SELECT("p.timeout_inquiry_count");
FROM("app_account_journal_entry j");
LEFT_OUTER_JOIN(" app_account_journal_posting p ON p.account_journal_entry_id = j.account_journal_entry_id ");
WHERE(" j.record_status = " + DBConst.RECORD_STATUS_ACTIVE_STR);
WHERE(" j.done_process = 1");
WHERE(" j.migration_flag = 0");
WHERE("( p.account_journal_entry_id IS NULL " +
        " OR p.posting_status = " + DBConst.JOURNAL_POSTING_STATUS_PENDING +
        " OR (p.posting_status = " + DBConst.JOURNAL_POSTING_STATUS_FAILED
        + " AND p.retry_count < " + PostingConst.MAX_RETRY + ")" +
        " OR (p.posting_status = " + DBConst.JOURNAL_POSTING_STATUS_PROCESSING
        + " AND p.updated_date < NOW() - INTERVAL " + PostingConst.LEASE_MINUTES + " MINUTE)" +
        " OR p.posting_status = " + DBConst.JOURNAL_POSTING_STATUS_TIMEOUT
        + ")");
WHERE(" j.transaction_date >= #{startDate} AND j.transaction_date < #{endDate} + INTERVAL 3 DAY");
LIMIT(" 1000");`;

// ─── SQL Beautifier helpers ─────────────────────────────────────────────────

/**
 * Format raw SQL (MySQL-style) into a nicely indented string.
 * Works on already-parsed SQL output that may contain #{params} or :placeholders.
 */
function formatSql(sql) {
  const protectedTokens = [];
  let s = protectStrings(sql, protectedTokens);
  s = normalizeWhitespace(s);
  s = normalizeClauses(s);
  s = formatCommas(s);
  s = formatConditions(s);
  s = formatCase(s);
  s = formatParentheses(s);
  s = restoreTokens(s, protectedTokens);
  s = cleanup(s);
  return s;
}

function protectStrings(sql, tokens) {
  return sql.replace(
    /'(?:''|[^'])*'|"(?:[^"]|"")*"/g,
    (match) => {
      const token = `__SQL_STRING_${tokens.length}__`;
      tokens.push(match);
      return token;
    }
  );
}

function restoreTokens(sql, tokens) {
  tokens.forEach((value, index) => {
    sql = sql.replace(`__SQL_STRING_${index}__`, value);
  });
  return sql;
}

function normalizeWhitespace(sql) {
  return sql
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

function normalizeClauses(sql) {
  sql = sql.replace(/\s+UNION\s+ALL\s+/gi, "\n\nUNION ALL\n\n");
  sql = sql.replace(/\s+UNION\s+/gi, "\n\nUNION\n\n");
  ["INNER JOIN","LEFT JOIN","RIGHT JOIN","FULL JOIN","CROSS JOIN"].forEach((kw) => {
    const re = new RegExp("\\s+(" + kw.replace(/ /g, "\\s+") + ")\\s+", "gi");
    sql = sql.replace(re, "\n$1 ");
  });
  sql = sql.replace(/\s+(JOIN)\s+/gi, "\n$1 ");
  ["SELECT","FROM","WHERE","GROUP BY","ORDER BY","HAVING","LIMIT"].forEach((kw) => {
    const re = new RegExp("\\s+(" + kw.replace(/ /g, "\\s+") + ")\\s+", "gi");
    sql = sql.replace(re, "\n$1 ");
  });
  sql = sql.replace(/\s+(ON)\s+/gi, "\n$1 ");
  return sql;
}

function formatCommas(sql) {
  let result = "";
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { result += ",\n"; continue; }
    result += ch;
  }
  return result;
}

function formatConditions(sql) {
  sql = sql.replace(/\s+(AND)\s+/gi, "\n$1 ");
  sql = sql.replace(/\s+(OR)\s+/gi, "\n$1 ");
  return sql;
}

function formatCase(sql) {
  sql = sql.replace(/\s+(CASE)\s+/gi, "\n$1\n");
  sql = sql.replace(/\s+(WHEN)\s+/gi, "\n$1 ");
  sql = sql.replace(/\s+(THEN)\s+/gi, "\n$1 ");
  sql = sql.replace(/\s+(ELSE)\s+/gi, "\n$1 ");
  sql = sql.replace(/\s+(END)\b/gi, "\n$1");
  return sql;
}

function formatParentheses(sql) {
  let result = "";
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") {
      depth++;
      result += "(";
      const remaining = sql.substring(i + 1);
      if (/^\s*SELECT\b/i.test(remaining)) result += "\n";
      continue;
    }
    if (ch === ")") { depth--; result += ")"; continue; }
    result += ch;
  }
  return result;
}

function cleanup(sql) {
  let lines = sql
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const result = [];
  let depth = 0;
  for (let line of lines) {
    const upper = line.toUpperCase();
    if (line.startsWith(")")) depth = Math.max(0, depth - 1);

    const isMajor = /^(SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|INNER JOIN|LEFT JOIN|RIGHT JOIN|FULL JOIN|CROSS JOIN|JOIN|ON)\b/.test(upper);
    const isCondition = /^(AND|OR)\b/.test(upper);
    const isUnion = /^(UNION|UNION ALL)$/.test(upper);
    const isCase = /^(CASE|WHEN|THEN|ELSE|END)\b/.test(upper);

    if (isUnion || isMajor) {
      result.push(indent(depth) + line);
    } else if (isCondition || isCase) {
      result.push(indent(depth + 1) + line);
    } else {
      result.push(indent(depth + 1) + line);
    }

    const opens = (line.match(/\(/g) || []).length;
    const closes = (line.match(/\)/g) || []).length;
    depth += opens - closes;
    depth = Math.max(0, depth);
  }
  return result
    .map((l) => l.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function indent(level) {
  return "    ".repeat(Math.max(0, level));
}

// ─── Parameter handling (for #{name} placeholders in raw SQL) ────────────────

function detectParams(sql) {
  const matches = sql.match(/#\{([^}]+)\}/g) || [];
  const names = [];
  matches.forEach((match) => {
    const name = match.substring(2, match.length - 1).trim();
    const paramName = name.split(",")[0].trim();
    if (paramName && !names.includes(paramName)) names.push(paramName);
  });
  return names;
}

function guessParamType(name) {
  const lower = name.toLowerCase();
  if (lower.includes("date") || lower.includes("time")) return "date";
  if (lower.includes("amount") || lower.includes("count") || lower.includes("size") || lower.includes("offset") || lower.includes("limit") || lower.includes("id")) return "number";
  return "string";
}

function formatParamValue(value, type) {
  if (type === "raw") return value;
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : value;
  }
  return "'" + value.replace(/'/g, "''") + "'";
}

function substituteParams(sql, params) {
  return sql.replace(/#\{([^}]+)\}/g, (_, content) => {
    const name = content.split(",")[0].trim();
    const p = params[name];
    if (!p || p.value === "") return `#{${name}}`;
    return formatParamValue(p.value, p.type);
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Converter() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [rawOutput, setRawOutput] = useState("");   // beautified raw SQL
  const [placeholders, setPlaceholders] = useState([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState([]);
  const [params, setParams] = useState({});         // #{name} → { value, type }
  const [mode, setMode] = useState("convert");      // "convert" | "beautify"

  const convert = useCallback((src) => {
    const source = src ?? input;
    setError("");
    setPlaceholders([]);
    setRawOutput("");
    try {
      const sql = parse(source);
      setOutput(sql);
      const ph = listPlaceholders(sql);
      setPlaceholders(ph);
      // Also detect any #{params} that may have survived
      const detected = detectParams(sql);
      if (detected.length > 0) {
        setParams((prev) => {
          const next = { ...prev };
          detected.forEach((n) => {
            if (!(n in next)) next[n] = { value: "", type: guessParamType(n) };
          });
          return next;
        });
      }
      setHistory((prev) => {
        const entry = { input: source, output: sql, ts: new Date().toLocaleTimeString(), mode: "convert" };
        return [entry, ...prev.filter((h) => h.input !== source)].slice(0, 20);
      });
    } catch (e) {
      setError(e.message);
      setOutput("");
    }
  }, [input]);

  const beautify = useCallback(() => {
    const sql = input.trim();
    if (!sql) {
      setRawOutput("");
      setError("Nothing to format.");
      return;
    }
    setError("");
    const formatted = formatSql(sql);
    setRawOutput(formatted);
    // detect #{params} in formatted output
    const names = detectParams(formatted);
    if (names.length > 0) {
      setParams((prev) => {
        const next = { ...prev };
        names.forEach((n) => {
          if (!(n in next)) next[n] = { value: "", type: guessParamType(n) };
        });
        return next;
      });
    }
  }, [input]);

  const generatePreview = useCallback(() => {
    const sql = input.trim();
    if (!sql) { setError("Nothing to preview."); return; }
    setError("");
    let formatted = formatSql(sql);
    formatted = substituteParams(formatted, params);
    setRawOutput(formatted);
  }, [input, params]);

  const copyOutput = async () => {
    const text = mode === "beautify" ? rawOutput : output;
    if (!text) { setError("Nothing to copy."); return; }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const swapEditors = () => {
    if (mode === "beautify") {
      // swap input ↔ rawOutput
      setInput(rawOutput);
      setRawOutput("");
    }
  };

  const clearAll = () => {
    setInput("");
    setOutput("");
    setRawOutput("");
    setError("");
    setPlaceholders([]);
    setParams({});
  };

  const updateParam = (name, field, val) => {
    setParams((prev) => ({ ...prev, [name]: { ...(prev[name] || { value: "", type: "string" }), [field]: val } }));
  };

  // Auto-detect #{params} while typing in beautify mode
  const handleInput = (val) => {
    setInput(val);
    if (mode === "beautify") {
      const names = detectParams(val);
      setParams((prev) => {
        const next = { ...prev };
        names.forEach((n) => {
          if (!(n in next)) next[n] = { value: "", type: guessParamType(n) };
        });
        // prune removed params
        Object.keys(next).forEach((k) => { if (!names.includes(k)) delete next[k]; });
        return next;
      });
    }
  };

  const activeOutput = mode === "beautify" ? rawOutput : output;

  return (
    <div style={{ display: "flex", height: "100vh", background: "#141414", fontFamily: "system-ui, sans-serif", overflow: "hidden", padding: "35px 0px", MozWindowDragging: "drag" }}>

      {/* ── Sidebar ── */}
      <div style={{ width: "220px", background: "#0a0a0a", borderRight: "1px solid #252525", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "14px 14px 8px", fontSize: "11px", color: "#666", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          📜 历史记录
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {history.length === 0 && (
            <div style={{ padding: "12px 14px", fontSize: "12px", color: "#555" }}>暂无记录</div>
          )}
          {history.map((h, i) => (
            <div
              key={i}
              onClick={() => { setInput(h.input); setOutput(h.output); setPlaceholders(listPlaceholders(h.output)); setError(""); setRawOutput(""); setParams({}); }}
              style={{ padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #1a1a1a", transition: "all 0.15s" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#1a1a1a";
                e.currentTarget.style.borderLeft = "3px solid #4a9eff";
                e.currentTarget.style.paddingLeft = "11px";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.borderLeft = "3px solid transparent";
                e.currentTarget.style.paddingLeft = "14px";
              }}
            >
              <div style={{ fontSize: "10px", color: "#888", marginBottom: "3px" }}>{h.ts}</div>
              <div style={{ fontSize: "11px", color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.input.trim().slice(0, 40)}...
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Title bar */}
        <div style={{
          height: "50px", background: "#0d0d0d", borderBottom: "1px solid #252525",
          display: "flex", alignItems: "center", padding: "0 18px", gap: "12px",
          WebkitAppRegion: "drag", flexShrink: 0,
        }}>
          <div style={{ width: "52px" }} />
          <span style={{ fontSize: "14px", fontWeight: 700, color: "#fff", letterSpacing: "0.03em" }}>
            🔄 MyBatis → MySQL
          </span>
          <span style={{ fontSize: "11px", color: "#aaa", background: "#1a1a1a", padding: "4px 10px", borderRadius: "4px", border: "1px solid #333" }}>
            本地解析 · 离线可用
          </span>

          {/* Mode toggle */}
          <div style={{ marginLeft: "auto", display: "flex", gap: "4px", WebkitAppRegion: "no-drag" }}>
            <ModeBtn active={mode === "convert"} onClick={() => setMode("convert")}>🔄 Mybatis</ModeBtn>
            <ModeBtn active={mode === "beautify"} onClick={() => setMode("beautify")}>✨ SQL beautify</ModeBtn>
          </div>
        </div>

        {/* Editor panels */}
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", overflow: "hidden" }}>

          {/* Input panel */}
          <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #1a1a1a" }}>
            <div style={{ padding: "12px 16px", background: "#0d0d0d", borderBottom: "1px solid #1a1a1a", display: "flex", gap: "8px", alignItems: "center" }}>
              <span style={{ fontSize: "12px", color: "#888", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", flex: 1 }}>
                📝 输入
              </span>
              {mode === "convert" && <LargeBtn onClick={() => { setInput(EXAMPLE); convert(EXAMPLE); }}>📋 示例</LargeBtn>}
              <LargeBtn onClick={clearAll} variant="danger">🗑️ 清空</LargeBtn>
            </div>
            <textarea
              value={input}
              onChange={(e) => handleInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Tab") {
                  e.preventDefault();
                  const s = e.target.selectionStart;
                  const en = e.target.selectionEnd;
                  const v = e.target.value;
                  e.target.value = v.slice(0, s) + "    " + v.slice(en);
                  e.target.selectionStart = e.target.selectionEnd = s + 4;
                }
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  mode === "beautify" ? beautify() : convert();
                }
              }}
              placeholder={
                mode === "beautify"
                  ? "粘贴原始 SQL（支持多行）...\n\n✨ Ctrl/⌘ + Enter 美化\n⇄ Swap 互换面板\n🔧 填写参数后生成预览"
                  : "粘贴 MyBatis Java SQL Builder 代码...\n\n支持：\n• SELECT / FROM / WHERE\n• LEFT_OUTER_JOIN / INNER_JOIN\n• ORDER_BY / GROUP_BY / HAVING\n• LIMIT / OFFSET\n• 常量自动转占位符\n• #{param} 保留原样\n\n不支持：\n• XML 文件\n• Java 的 if/else 逻辑\n\n⌘ + Enter 快捷转换"
              }
              style={{
                flex: 1, resize: "none", border: "none", outline: "none",
                background: "#0a0a0a", color: "#e0e0e0",
                fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                fontSize: "12.5px", padding: "16px", lineHeight: "1.75",
                tabSize: 4,
              }}
            />
          </div>

          {/* Output panel */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 16px", background: "#0d0d0d", borderBottom: "1px solid #1a1a1a", display: "flex", gap: "8px", alignItems: "center" }}>
              <span style={{ fontSize: "12px", color: "#888", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", flex: 1 }}>
                {mode === "beautify" ? "✨ 格式化 / Preview SQL" : "✨ 输出"}
              </span>
              {mode === "beautify" && (
                <>
                  <LargeBtn onClick={beautify}>✨ 美化</LargeBtn>
                  <LargeBtn onClick={generatePreview} variant="success">▶ Preview SQL</LargeBtn>
                </>
              )}
              <LargeBtn onClick={copyOutput} disabled={!activeOutput} variant="success">
                {copied ? "✓ 已复制" : "📋 复制"}
              </LargeBtn>
              <LargeBtn onClick={swapEditors} disabled={mode !== "beautify" || !rawOutput}>
                ⇄ Swap
              </LargeBtn>
              {mode === "convert" && (
                <LargeBtn onClick={() => { setOutput(""); setError(""); setPlaceholders([]); }} disabled={!output && !error} variant="danger">
                  🗑️ 清空
                </LargeBtn>
              )}
            </div>
            <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
              {error ? (
                <div style={{ padding: "16px", color: "#ff6b6b", fontFamily: "monospace", fontSize: "12px", lineHeight: "1.7" }}>
                  ❌ {error}
                </div>
              ) : mode === "beautify" ? (
                <pre style={{
                  margin: 0, padding: "16px",
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                  fontSize: "12.5px", lineHeight: "1.75",
                  color: rawOutput ? "#90ee90" : "#555",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  background: "#111827", minHeight: "100%",
                }}>
                  {rawOutput || "-- 美化结果将在此显示"}
                </pre>
              ) : (
                <pre style={{
                  margin: 0, padding: "16px",
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                  fontSize: "12.5px", lineHeight: "1.75",
                  color: output ? "#90ee90" : "#555",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                }}>
                  {output || "-- 转换结果将在此显示"}
                </pre>
              )}
            </div>

            {/* ── Parameters panel (only in beautify mode) ── */}
            {mode === "beautify" && (
              <ParamPanel params={params} placeholders={placeholders} onParamChange={updateParam} />
            )}

            {/* Placeholder legend (convert mode) */}
            {mode === "convert" && placeholders.length > 0 && (
              <div style={{ borderTop: "1px solid #1a1a1a", padding: "12px 16px", background: "#0a0a0a" }}>
                <div style={{ fontSize: "11px", color: "#888", marginBottom: "8px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  🔑 占位符（需替换为实际值）
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {placeholders.map((p) => (
                    <span key={p} style={{
                      fontSize: "11px", fontFamily: "monospace",
                      background: "#1a2a3a", color: "#5bb3ff",
                      border: "1px solid #2a4a6a",
                      borderRadius: "4px", padding: "4px 10px",
                    }}>
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Bottom bar */}
        <div style={{
          height: "50px", background: "#0d0d0d", borderTop: "1px solid #1a1a1a",
          display: "flex", alignItems: "center", padding: "0 18px", gap: "12px", flexShrink: 0,
        }}>
          <button
            onClick={() => mode === "beautify" ? beautify() : convert()}
            style={{
              padding: "10px 28px", borderRadius: "6px", fontSize: "14px", fontWeight: 700,
              background: "#238636", color: "#fff", border: "none", cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#2ea043";
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.boxShadow = "0 4px 12px rgba(35, 134, 54, 0.4)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#238636";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            {mode === "beautify" ? "✨ 美化" : "🚀 转换"}
          </button>
          <span style={{ fontSize: "12px", color: "#666" }}>⌘ + Enter</span>
          <div style={{ flex: 1 }} />
          {activeOutput && !error && (
            <span style={{ fontSize: "12px", color: "#888" }}>
              {activeOutput.split("\n").length} 行 · {activeOutput.length} 字符
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ModeBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        WebkitAppRegion: "no-drag",
        borderRadius: "6px", fontSize: "12px", fontWeight: 600, padding: "5px 12px",
        cursor: "pointer", border: "none",
        background: active ? "#2563eb" : "#1a1a1a",
        color: active ? "#fff" : "#888",
        transition: "all 0.15s",
      }}
      onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = "#252525"; e.currentTarget.style.color = "#ccc"; } }}
      onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = "#1a1a1a"; e.currentTarget.style.color = "#888"; } }}
    >
      {children}
    </button>
  );
}

function ParamPanel({ params, placeholders, onParamChange }) {
  const names = Object.keys(params).length > 0
    ? Object.keys(params)
    : placeholders.filter((p) => p.startsWith(":")).map((p) => p.slice(1)); // convert :placeholder → param name hint

  // Also show #{name} params from detectParams
  const paramNames = Object.keys(params);
  if (paramNames.length === 0 && placeholders.length === 0) return null;

  return (
    <div style={{ borderTop: "1px solid #1a1a1a", padding: "10px 16px", background: "#0a0a0a" }}>
      <div style={{ fontSize: "11px", color: "#ebebeb", marginBottom: "8px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        🔧 MyBatis 参数
      </div>
      {paramNames.length === 0 && placeholders.length === 0 ? (
        <div style={{ fontSize: "12px", color: "#ebebeb" }}>粘贴含 #{parameterName} 的 SQL 自动生成参数输入框</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(140px,180px) 1fr 80px", gap: "6px 10px", alignItems: "center" }}>
          {paramNames.map((name) => {
            const p = params[name];
            return (
              <React.Fragment key={name}>
                <div style={{ fontFamily: "monospace", fontSize: "12px", color: "#ebebeb" }}>#{name}</div>
                <input
                  type={"text"}
                  value={p.value}
                  onChange={(e) => onParamChange(name, "value", e.target.value)}
                  placeholder={`输入 ${name}`}
                  style={{
                    padding: "6px 8px", border: "1px solid #252525", borderRadius: "5px",
                    background: "#1a1a1a", color: "#e0e0e0", fontFamily: "monospace", fontSize: "12px", outline: "none",
                  }}
                />
                <select
                  value={p.type}
                  onChange={(e) => onParamChange(name, "type", e.target.value)}
                  style={{
                    padding: "6px 4px", border: "1px solid #252525", borderRadius: "5px",
                    background: "#1a1a1a", color: "#ccc", fontSize: "11px", outline: "none", cursor: "pointer",
                  }}
                >
                  <option value="string">String</option>
                  <option value="number">Number</option>
                  {/* <option value="date">Date</option> */}
                  <option value="raw">Raw</option>
                </select>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LargeBtn({ onClick, children, disabled, variant = "default" }) {
  const baseStyle = {
    WebkitAppRegion: "no-drag",
    borderRadius: "6px", color: "#fff",
    fontSize: "12px", fontWeight: 600, padding: "8px 14px", cursor: disabled ? "default" : "pointer",
    border: "none", transition: "all 0.15s",
  };
  const variants = {
    default: { background: "#333", hoverBg: "#444" },
    success: { background: "#1e7e34", hoverBg: "#238636" },
    danger: { background: "#6e3b3b", hoverBg: "#7d4444" },
  };
  const v = variants[variant] || variants.default;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ ...baseStyle, background: disabled ? "#1a1a1a" : v.background, opacity: disabled ? 0.6 : 1 }}
      onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = v.hoverBg; e.currentTarget.style.transform = "translateY(-1px)"; } }}
      onMouseLeave={(e) => { e.currentTarget.style.background = disabled ? "#1a1a1a" : v.background; e.currentTarget.style.transform = "translateY(0)"; }}
    >
      {children}
    </button>
  );
}
