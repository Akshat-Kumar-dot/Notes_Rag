"use client";

import { useRef, useState } from "react";
import { I } from "@/components/Icons";
import { api, streamMessage, type Folder, type Source } from "@/lib/api";

interface Turn {
  id: string;
  question: string;
  answer: string;
  sources: Source[];
  lowConfidence: boolean;
  streaming: boolean;
  error: string | null;
  searchOnly: boolean;
}

/** Renders [2] markers as hoverable links to the matching source card. */
function withCitations(text: string, active: number | null, onHover: (n: number | null) => void) {
  return text.split(/(\[\d{1,2}\])/g).map((part, i) => {
    const m = /^\[(\d{1,2})\]$/.exec(part);
    if (!m) return <span key={i}>{part}</span>;
    const n = Number(m[1]);
    return (
      <span key={i} className="cite" data-on={active === n}
        onMouseEnter={() => onHover(n)} onMouseLeave={() => onHover(null)}>
        {n}
      </span>
    );
  });
}

export function Chat({ folder }: { folder: Folder | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<"ask" | "search">("ask");
  const [active, setActive] = useState<number | null>(null);
  const convo = useRef<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const busy = turns.some((t) => t.streaming);
  const patch = (id: string, fn: (t: Turn) => Turn) =>
    setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

  async function submit() {
    const q = value.trim();
    if (!q || busy || !folder) return;
    setValue("");
    const id = crypto.randomUUID();
    setTurns((p) => [...p, {
      id, question: q, answer: "", sources: [], lowConfidence: false,
      streaming: true, error: null, searchOnly: mode === "search",
    }]);

    // Search mode never touches the model: no rate limit, nothing invented.
    if (mode === "search") {
      try {
        const r = await api.search(q, [folder.id]);
        patch(id, (t) => ({ ...t, sources: r.results, lowConfidence: r.low_confidence, streaming: false }));
      } catch (e) {
        patch(id, (t) => ({ ...t, error: e instanceof Error ? e.message : "Search failed.", streaming: false }));
      }
      return;
    }

    try {
      // Folder scope is fixed when the conversation is created, so answers stay
      // explainable later.
      if (!convo.current) convo.current = (await api.createConversation([folder.id])).id;
    } catch (e) {
      patch(id, (t) => ({ ...t, error: e instanceof Error ? e.message : "Couldn't start chat.", streaming: false }));
      return;
    }

    await streamMessage(convo.current, q, {
      onSources: (s, low) => patch(id, (t) => ({ ...t, sources: s, lowConfidence: low })),
      onToken: (d) => patch(id, (t) => ({ ...t, answer: t.answer + d })),
      onDone: () => patch(id, (t) => ({ ...t, streaming: false })),
      onError: (m) => patch(id, (t) => ({ ...t, error: m, streaming: false })),
    });
    patch(id, (t) => ({ ...t, streaming: false }));
  }

  return (
    <>
      <div className="scroll">
        {turns.length === 0 ? (
          <div className="empty">
            <h2>What would you like to know?</h2>
            <p>
              {folder
                ? <>Asking across <strong>{folder.name}</strong></>
                : "Create a folder and upload something to begin."}
            </p>
          </div>
        ) : (
          turns.map((t) => (
            <article className="turn" key={t.id}>
              <h3 className="q">{t.question}</h3>

              {t.lowConfidence && !t.error && (
                <p className="note warn">
                  Weak match — nothing in this folder scored well. Read the sources before
                  trusting this.
                </p>
              )}
              {t.error && <p className="note err">{t.error}</p>}

              {!t.searchOnly && !t.error && (
                <div className={`a ${t.streaming && !t.answer ? "caret" : ""}`}>
                  {withCitations(t.answer, active, setActive)}
                  {t.streaming && t.answer && <span className="caret" />}
                </div>
              )}

              {t.sources.length > 0 && (
                <div className="srcs">
                  {t.sources.map((s) => (
                    <div key={s.chunk_id} className="src" data-on={active === s.n}
                      onMouseEnter={() => setActive(s.n)} onMouseLeave={() => setActive(null)}>
                      <div className="h">
                        <span className="trunc">
                          [{s.n}] {s.filename}
                          {s.page_number && s.page_number > 1 ? `, p.${s.page_number}` : ""}
                        </span>
                        <span>{s.score.toFixed(3)}</span>
                      </div>
                      <div className="x">{s.excerpt}</div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))
        )}
      </div>

      <div className="composer-wrap">
        <div className="composer">
          {folder && <span className="chip">{I.folder}{folder.name}</span>}
          <textarea
            ref={box} rows={1} value={value}
            placeholder={folder ? "Ask your files…" : "Create a folder first"}
            disabled={!folder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
          <button className="iconbtn send" onClick={submit} disabled={!value.trim() || busy || !folder}>
            {I.send}
          </button>
        </div>
        <div className="actions">
          <button data-on={mode === "ask"} onClick={() => setMode("ask")}>Ask AI</button>
          <button data-on={mode === "search"} onClick={() => setMode("search")}>Search Notes</button>
        </div>
      </div>
    </>
  );
}
