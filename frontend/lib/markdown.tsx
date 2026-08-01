import type { ReactNode } from "react";

/* A small Markdown renderer for model output.
 *
 * Why not a library: the answer streams in token by token, so it re-renders on
 * every chunk and is frequently *invalid* mid-flight (an unclosed ** or a half
 * written fence). This degrades gracefully -- an unmatched marker just stays
 * literal text -- and keeps citation markers as interactive elements, which a
 * generic renderer would flatten into plain text. */

export interface CiteCtx {
  active: number | null;
  onHover: (n: number | null) => void;
}

// Order matters: code before links, links before bare [1] citations, bold
// before italic (so ** is not eaten by the single-* rule).
const INLINE_SRC = [
  "(`[^`\\n]+`)",                        // 1 inline code
  "(\\[[^\\]\\n]+\\]\\([^)\\s]+\\))",    // 2 [text](url)
  "(\\[\\d{1,2}\\])",                    // 3 [1] citation
  "(\\*\\*[\\s\\S]+?\\*\\*)",            // 4 **bold**
  "(__[\\s\\S]+?__)",                    // 5 __bold__
  "(\\*(?!\\s)[^*\\n]+?\\*)",            // 6 *italic*
  "(~~[\\s\\S]+?~~)",                    // 7 ~~strike~~
].join("|");

function inline(src: string, ctx: CiteCtx, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // A fresh instance per call: this function recurses for bold/italic content,
  // and a shared /g/ regex would have its lastIndex reset by the inner call,
  // restarting the outer scan from zero forever.
  const re = new RegExp(INLINE_SRC, "g");

  while ((m = re.exec(src)) !== null) {
    const tok = m[0];
    if (!tok) { re.lastIndex++; continue; }   // never let the scan stall
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `${keyBase}-${m.index}`;

    if (m[1]) {
      out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    } else if (m[2]) {
      const cut = tok.indexOf("](");
      const label = tok.slice(1, cut);
      const href = tok.slice(cut + 2, -1);
      const safe = /^(https?:|mailto:)/i.test(href);
      out.push(
        safe
          ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{label}</a>
          : <span key={k}>{label}</span>,
      );
    } else if (m[3]) {
      const n = Number(tok.slice(1, -1));
      out.push(
        <span key={k} className="cite" data-on={ctx.active === n}
          onMouseEnter={() => ctx.onHover(n)} onMouseLeave={() => ctx.onHover(null)}>
          {n}
        </span>,
      );
    } else if (m[4] || m[5]) {
      out.push(<strong key={k}>{inline(tok.slice(2, -2), ctx, k)}</strong>);
    } else if (m[6]) {
      out.push(<em key={k}>{inline(tok.slice(1, -1), ctx, k)}</em>);
    } else if (m[7]) {
      out.push(<s key={k}>{inline(tok.slice(2, -2), ctx, k)}</s>);
    }
    last = m.index + tok.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

/** Soft line breaks inside a paragraph are meaningful in chat answers, so they
 *  are kept rather than collapsed into spaces the way strict Markdown would. */
function lines(src: string, ctx: CiteCtx, key: string): ReactNode[] {
  return src.split("\n").flatMap((ln, i) => {
    const parts = inline(ln, ctx, `${key}-${i}`);
    return i === 0 ? parts : [<br key={`${key}-br${i}`} />, ...parts];
  });
}

const HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEAD = /^\s{0,3}(#{1,6})\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ROW = /^\s*\|(.+)\|\s*$/;
const SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

const cells = (row: string) =>
  row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

export function Markdown({ text, ctx }: { text: string; ctx: CiteCtx }) {
  const src = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;

  while (i < src.length) {
    const line = src[i];

    if (!line.trim()) { i++; continue; }

    // fenced code — the closing fence may not have streamed in yet
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < src.length && !/^\s*```\s*$/.test(src[i])) body.push(src[i++]);
      i++;
      out.push(
        <pre key={i}><code data-lang={fence[1] || undefined}>{body.join("\n")}</code></pre>,
      );
      continue;
    }

    if (HR.test(line)) { out.push(<hr key={i} />); i++; continue; }

    const h = HEAD.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 6);
      const Tag = `h${level}` as "h1";
      out.push(<Tag key={i}>{inline(h[2], ctx, `h${i}`)}</Tag>);
      i++;
      continue;
    }

    // table: a header row followed by a |---|---| separator
    if (ROW.test(line) && i + 1 < src.length && SEP.test(src[i + 1]) && src[i + 1].includes("|")) {
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < src.length && ROW.test(src[i])) body.push(cells(src[i++]));
      out.push(
        <div className="tablewrap" key={`t${i}`}>
          <table>
            <thead><tr>{head.map((c, x) => <th key={x}>{inline(c, ctx, `th${i}-${x}`)}</th>)}</tr></thead>
            <tbody>
              {body.map((r, y) => (
                <tr key={y}>{r.map((c, x) => <td key={x}>{inline(c, ctx, `td${i}-${y}-${x}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < src.length && QUOTE.test(src[i])) body.push(QUOTE.exec(src[i++])![1]);
      out.push(<blockquote key={i}>{lines(body.join("\n"), ctx, `q${i}`)}</blockquote>);
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line) && !UL.test(line);
      const items: string[] = [];
      while (i < src.length) {
        const mm = ordered ? OL.exec(src[i]) : UL.exec(src[i]);
        if (!mm) break;
        let item = mm[1];
        i++;
        // continuation lines belong to the item they are indented under
        while (i < src.length && /^\s{2,}\S/.test(src[i]) && !UL.test(src[i]) && !OL.test(src[i])) {
          item += "\n" + src[i++].trim();
        }
        items.push(item);
      }
      const Tag = ordered ? "ol" : "ul";
      out.push(
        <Tag key={i}>
          {items.map((it, x) => <li key={x}>{lines(it, ctx, `li${i}-${x}`)}</li>)}
        </Tag>,
      );
      continue;
    }

    const para: string[] = [];
    while (
      i < src.length && src[i].trim() &&
      !HEAD.test(src[i]) && !UL.test(src[i]) && !OL.test(src[i]) &&
      !QUOTE.test(src[i]) && !HR.test(src[i]) && !/^\s*```/.test(src[i])
    ) para.push(src[i++]);
    out.push(<p key={i}>{lines(para.join("\n"), ctx, `p${i}`)}</p>);
  }

  return <>{out}</>;
}
