import { useState, useCallback } from "react";
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

export default function Converter() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [placeholders, setPlaceholders] = useState([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState([]);

  const convert = useCallback((src) => {
    const source = src ?? input;
    setError("");
    setPlaceholders([]);
    try {
      const sql = parse(source);
      setOutput(sql);
      const ph = listPlaceholders(sql);
      setPlaceholders(ph);
      setHistory((prev) => {
        const entry = { input: source, output: sql, ts: new Date().toLocaleTimeString() };
        return [entry, ...prev.filter((h) => h.input !== source)].slice(0, 20);
      });
    } catch (e) {
      setError(e.message);
      setOutput("");
    }
  }, [input]);

  const loadExample = () => {
    setInput(EXAMPLE);
    convert(EXAMPLE);
  };

  const copyOutput = async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const clearAll = () => {
    setInput("");
    setOutput("");
    setError("");
    setPlaceholders([]);
  };

  const clearOutput = () => {
    setOutput("");
    setError("");
    setPlaceholders([]);
  };

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
              onClick={() => { setInput(h.input); setOutput(h.output); setPlaceholders(listPlaceholders(h.output)); setError(""); }}
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
        </div>

        {/* Editor panels */}
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", overflow: "hidden" }}>

          {/* Input panel */}
          <div style={{ display: "flex", flexDirection: "column", borderRight: "1px solid #1a1a1a" }}>
            <div style={{ padding: "12px 16px", background: "#0d0d0d", borderBottom: "1px solid #1a1a1a", display: "flex", gap: "8px", alignItems: "center" }}>
              <span style={{ fontSize: "12px", color: "#888", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", flex: 1 }}>
                📝 输入
              </span>
              <LargeBtn onClick={loadExample}>📋 示例</LargeBtn>
              <LargeBtn onClick={clearAll} variant="danger">🗑️ 清空</LargeBtn>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") convert(); }}
              placeholder={"粘贴 MyBatis Java SQL Builder 代码...\n\n支持：\n• SELECT / FROM / WHERE\n• LEFT_OUTER_JOIN / INNER_JOIN\n• ORDER_BY / GROUP_BY / HAVING\n• LIMIT / OFFSET\n• 常量自动转占位符\n• #{param} 保留原样\n\n不支持：\n• XML 文件\n• Java 的 if/else 逻辑\n\n⌘ + Enter 快捷转换"}
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
                ✨ 输出
              </span>
              <LargeBtn onClick={copyOutput} disabled={!output} variant="success">
                {copied ? "✓ 已复制" : "📋 复制"}
              </LargeBtn>
              <LargeBtn onClick={clearOutput} disabled={!output && !error} variant="danger">
                🗑️ 清空
              </LargeBtn>
            </div>
            <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
              {error ? (
                <div style={{ padding: "16px", color: "#ff6b6b", fontFamily: "monospace", fontSize: "12px", lineHeight: "1.7" }}>
                  ❌ {error}
                </div>
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

            {/* Placeholder legend */}
            {placeholders.length > 0 && (
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
            onClick={() => convert()}
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
            🚀 转换
          </button>
          <span style={{ fontSize: "12px", color: "#666" }}>⌘ + Enter</span>
          <div style={{ flex: 1 }} />
          {output && !error && (
            <span style={{ fontSize: "12px", color: "#888" }}>
              {output.split("\n").length} 行 · {output.length} 字符
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function LargeBtn({ onClick, children, disabled, variant = "default" }) {
  const baseStyle = {
    WebkitAppRegion: "no-drag",
    borderRadius: "6px", color: "#fff",
    fontSize: "12px", fontWeight: 600, padding: "8px 14px", cursor: disabled ? "default" : "pointer",
    border: "none",
    transition: "all 0.15s",
  };

  const variants = {
    default: {
      background: "#333",
      hoverBg: "#444",
      color: "#fff",
    },
    success: {
      background: "#1e7e34",
      hoverBg: "#238636",
      color: "#fff",
    },
    danger: {
      background: "#6e3b3b",
      hoverBg: "#7d4444",
      color: "#fff",
    },
  };

  const v = variants[variant] || variants.default;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...baseStyle,
        background: disabled ? "#1a1a1a" : v.background,
        color: disabled ? "#666" : v.color,
        opacity: disabled ? 0.6 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.background = v.hoverBg;
          e.currentTarget.style.transform = "translateY(-1px)";
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = disabled ? "#1a1a1a" : v.background;
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      {children}
    </button>
  );
}
