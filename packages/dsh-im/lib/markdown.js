/**
 * Minimal GitHub-flavored Markdown → Telegram HTML renderer.
 *
 * Telegram `parse_mode: "HTML"` supports <b>, <i>, <s>, <u>, <code>, <pre>,
 * <a href>, <tg-spoiler>, and <blockquote> (in recent clients). It does NOT
 * support headings or tables, so we map headings to bold and render GFM tables
 * as aligned monospace <pre> blocks.
 */

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a URL for use inside an href attribute. */
function escapeUrl(url) {
  return url.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
}

/**
 * Convert one line's inline markdown (code, links, bold, italic, strikethrough)
 * to Telegram HTML. Runs before HTML escaping for the outer text.
 */
function inlineMarkdown(text) {
  const codeSpans = [];
  const links = [];

  // Inline code first (so backticks inside code are not re-parsed).
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000C${codeSpans.length - 1}\u0000`;
  });

  // Links [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    links.push(`<a href="${escapeUrl(url)}">${escapeHtml(label)}</a>`);
    return `\u0000L${links.length - 1}\u0000`;
  });

  // Escape the remaining text (placeholders contain only \u0000 + digits, unaffected).
  text = escapeHtml(text);

  // Bold **x**
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  // Strikethrough ~~x~~
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  // Italic *x* (single asterisks, not adjacent to another asterisk)
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  // Italic _x_
  text = text.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>");

  // Restore code and links.
  text = text.replace(/\u0000C(\d+)\u0000/g, (_, i) => codeSpans[Number(i)]);
  text = text.replace(/\u0000L(\d+)\u0000/g, (_, i) => links[Number(i)]);

  return text;
}

/** Split a table row into trimmed cells. */
function parseTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

/** Whether a line is a GFM table separator (e.g. `|---|---|`). */
function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?[\s:|-]*$/.test(line) && line.includes("-");
}

/** Render collected GFM table lines as aligned plain-text rows. */
function tableToText(lines) {
  const rows = lines
    .filter((line) => !isTableSeparator(line))
    .map(parseTableRow)
    .filter((cells) => cells.length > 0 && cells.some((c) => c !== ""));

  if (rows.length === 0) return "";

  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = [];
  for (let c = 0; c < colCount; c += 1) {
    widths[c] = Math.max(3, ...rows.map((r) => (r[c] ?? "").length));
  }

  return rows.map((row) => {
    let line = "";
    for (let c = 0; c < colCount; c += 1) {
      const cell = row[c] ?? "";
      line += c === 0 ? cell.padEnd(widths[c]) : `  ${cell.padEnd(widths[c])}`;
    }
    return line.trimEnd();
  }).join("\n");
}

/** Render collected GFM table lines as an aligned monospace <pre> block. */
function tableToPre(lines) {
  const text = tableToText(lines);
  return text === "" ? "" : `<pre>${escapeHtml(text)}</pre>`;
}

/** Strip inline markdown from a line, leaving readable plain text. */
function stripInline(text) {
  return text
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1$2");
}

/**
 * Convert a whole markdown document to Telegram HTML.
 * @param {string} md
 * @returns {string}
 */
export function markdownToTelegramHtml(md) {
  if (typeof md !== "string" || md.trim() === "") return "";
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```lang ... ```
    if (/^\s*```/.test(line)) {
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      out.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
      continue;
    }

    // GFM table (current line has pipes, next is a separator).
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i += 1;
      }
      const pre = tableToPre(tableLines);
      if (pre) out.push(pre);
      continue;
    }

    // Headings → bold.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inlineMarkdown(heading[2])}</b>`);
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      out.push("<i>————————</i>");
      i += 1;
      continue;
    }

    // Blockquote.
    if (/^\s*&gt;\s?/.test(line) || /^\s*>\s?/.test(line)) {
      const text = line.replace(/^\s*&gt;\s?/, "").replace(/^\s*>\s?/, "");
      out.push(`<i>${inlineMarkdown(text)}</i>`);
      i += 1;
      continue;
    }

    // Unordered list item.
    const bullet = /^\s*[-*+]\s+/.exec(line);
    if (bullet) {
      out.push(`• ${inlineMarkdown(line.slice(bullet[0].length))}`);
      i += 1;
      continue;
    }

    // Ordered list item.
    const ordered = /^\s*(\d+)[.)]\s+/.exec(line);
    if (ordered) {
      out.push(`${ordered[1]}. ${inlineMarkdown(line.slice(ordered[0].length))}`);
      i += 1;
      continue;
    }

    // Blank line → paragraph break.
    if (line.trim() === "") {
      out.push("");
      i += 1;
      continue;
    }

    // Ordinary paragraph line.
    out.push(inlineMarkdown(line));
    i += 1;
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Convert a whole markdown document to readable plain text (for channels with
 * no HTML/markdown support, e.g. WeChat iLink). Inline markdown is stripped,
 * tables become aligned text, code blocks are indented, and headings/lists
 * degrade to plain lines.
 */
export function markdownToPlainText(md) {
  if (typeof md !== "string" || md.trim() === "") return "";
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```lang ... ```
    if (/^\s*```/.test(line)) {
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      out.push(codeLines.map((codeLine) => `  ${codeLine}`).join("\n"));
      continue;
    }

    // GFM table.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i += 1;
      }
      const text = tableToText(tableLines);
      if (text) out.push(text);
      continue;
    }

    // Headings.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(stripInline(heading[2]));
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      out.push("————————");
      i += 1;
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      out.push(stripInline(line.replace(/^\s*>\s?/, "")));
      i += 1;
      continue;
    }

    // Unordered list item.
    const bullet = /^\s*[-*+]\s+/.exec(line);
    if (bullet) {
      out.push(`• ${stripInline(line.slice(bullet[0].length))}`);
      i += 1;
      continue;
    }

    // Ordered list item.
    const ordered = /^\s*(\d+)[.)]\s+/.exec(line);
    if (ordered) {
      out.push(`${ordered[1]}. ${stripInline(line.slice(ordered[0].length))}`);
      i += 1;
      continue;
    }

    // Blank line → paragraph break.
    if (line.trim() === "") {
      out.push("");
      i += 1;
      continue;
    }

    // Ordinary paragraph line.
    out.push(stripInline(line));
    i += 1;
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
