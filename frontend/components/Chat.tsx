"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { I } from "@/components/Icons";
import { api, streamMessage, type Folder, type Source } from "@/lib/api";

/** One rendered source card. Live results and stored citations both narrow to
 *  this, so history renders through exactly the same component as a live turn. */
interface Src {
  n: number;
  key: string;
  label: string;
  excerpt: string;
  score: number | null;
}

interface Turn {
  id: string;
  question: string;
  answer: string;
  sources: Src[];
  lowConfidence: boolean;
  streaming: boolean;
  error: string | null;
  searchOnly: boolean;
}

const fromSource = (s: Source): Src => ({
  n: s.n,
  key: s.chunk_id,
  label: s.filename + (s.page_number && s.page_number > 1 ? `, p.${s.page_number}` : ""),
  excerpt: s.excerpt,
  score: s.score,
});

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

// --- dictation -------------------------------------------------------------
// Web Speech API is prefixed in Chromium and absent in Firefox, so the button
// is hidden rather than shown broken where it cannot work.
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
interface SpeechEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
type RecognitionCtor = new () => Recognition;

const getRecognition = (): RecognitionCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export function Chat({
  folder, resumeId, onUpload, onConversationSaved,
}: {
  folder: Folder | null;
  resumeId?: string | null;
  onUpload: () => void;
  onConversationSaved?: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<"ask" | "search">("ask");
  const [active, setActive] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const [micOk, setMicOk] = useState(false);
  const convo = useRef<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const rec = useRef<Recognition | null>(null);

  const busy = turns.some((t) => t.streaming);
  const empty = turns.length === 0;

  useEffect(() => { setMicOk(getRecognition() !== null); }, []);

  // Reopening a conversation from history replays its stored messages.
  useEffect(() => {
    if (!resumeId) return;
    let cancelled = false;
    convo.current = resumeId;
    api.conversation(resumeId).then((c) => {
      if (cancelled) return;
      const out: Turn[] = [];
      for (const m of c.messages) {
        if (m.role === "user") {
          out.push({
            id: m.id, question: m.content, answer: "", sources: [],
            lowConfidence: false, streaming: false, error: null, searchOnly: false,
          });
        } else if (out.length) {
          const t = out[out.length - 1];
          t.answer = m.content;
          t.lowConfidence = m.low_confidence;
          t.sources = m.citations.map((c2) => ({
            n: c2.rank,
            key: c2.chunk_id ?? `${m.id}-${c2.rank}`,
            label: c2.source_label,
            excerpt: c2.excerpt_snapshot,
            score: c2.score,
          }));
        }
      }
      setTurns(out);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [resumeId]);

  // Keep the newest turn in view while tokens stream in.
  useEffect(() => {
    if (!empty) bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, empty]);

  const grow = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  function toggleMic() {
    if (listening) { rec.current?.stop(); return; }
    const Ctor = getRecognition();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    let settled = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) settled += res[0].transcript;
        else interim += res[0].transcript;
      }
      setValue((settled + interim).trimStart());
      requestAnimationFrame(grow);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  }

  const patch = (id: string, fn: (t: Turn) => Turn) =>
    setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

  async function submit() {
    const q = value.trim();
    if (!q || busy || !folder) return;
    if (listening) { rec.current?.stop(); setListening(false); }
    setValue("");
    requestAnimationFrame(grow);

    const id = crypto.randomUUID();
    setTurns((p) => [...p, {
      id, question: q, answer: "", sources: [], lowConfidence: false,
      streaming: true, error: null, searchOnly: mode === "search",
    }]);

    // Search mode never touches the model: no rate limit, nothing invented.
    if (mode === "search") {
      try {
        const r = await api.search(q, [folder.id]);
        patch(id, (t) => ({
          ...t, sources: r.results.map(fromSource),
          lowConfidence: r.low_confidence, streaming: false,
        }));
      } catch (e) {
        patch(id, (t) => ({ ...t, error: e instanceof Error ? e.message : "Search failed.", streaming: false }));
      }
      return;
    }

    try {
      // Folder scope is fixed when the conversation is created, so answers stay
      // explainable later.
      if (!convo.current) {
        convo.current = (await api.createConversation([folder.id])).id;
        onConversationSaved?.();
      }
    } catch (e) {
      patch(id, (t) => ({ ...t, error: e instanceof Error ? e.message : "Couldn't start chat.", streaming: false }));
      return;
    }

    await streamMessage(convo.current, q, {
      onSources: (s, low) => patch(id, (t) => ({ ...t, sources: s.map(fromSource), lowConfidence: low })),
      onToken: (d) => patch(id, (t) => ({ ...t, answer: t.answer + d })),
      onDone: () => patch(id, (t) => ({ ...t, streaming: false })),
      onError: (m) => patch(id, (t) => ({ ...t, error: m, streaming: false })),
    });
    patch(id, (t) => ({ ...t, streaming: false }));
  }

  const composer = (
    <div className="composer-wrap">
      <div className="composer">
        <button className="iconbtn ghost" onClick={onUpload} title="Add files"
          aria-label="Add files">{I.plus}</button>
        <textarea
          ref={box} rows={1} value={value}
          placeholder={folder ? "Ask your files…" : "Create a folder first"}
          disabled={!folder}
          onChange={(e) => { setValue(e.target.value); grow(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        {micOk && (
          <button className="iconbtn ghost mic" data-on={listening} onClick={toggleMic}
            disabled={!folder} title={listening ? "Stop dictation" : "Dictate"}
            aria-label={listening ? "Stop dictation" : "Start dictation"}>
            {I.mic}
          </button>
        )}
        <button className="iconbtn send" onClick={submit}
          disabled={!value.trim() || busy || !folder} title="Send" aria-label="Send">
          {I.send}
        </button>
      </div>
      <div className="actions">
        <button data-on={mode === "ask"} onClick={() => setMode("ask")}>Ask AI</button>
        <button data-on={mode === "search"} onClick={() => setMode("search")}>Search Notes</button>
        <button onClick={onUpload}>Upload Files</button>
      </div>
      {folder && <div className="scope">{I.folder}<span>{folder.name}</span></div>}
    </div>
  );

  return (
    <div className="chatpane">
      <div className="scroll" data-empty={empty}>
        {empty ? (
          <div className="hero">
            <h2>What would you like to know?</h2>
            <p>
              {folder
                ? <>Asking across <strong>{folder.name}</strong></>
                : "Create a folder and upload something to begin."}
            </p>
          </div>
        ) : (
          <>
            {turns.map((t) => (
              <article className="turn" key={t.id}>
                <h3 className="q">{t.question}</h3>

                {t.lowConfidence && !t.error && (
                  <p className="note warn">
                    Weak match — nothing in this folder scored well. Read the sources before
                    trusting this.
                  </p>
                )}
                {t.error && <p className="note err">{t.error}</p>}

                {!t.searchOnly && (t.answer || t.streaming) && (
                  <div className={`a ${t.streaming && !t.answer ? "caret" : ""}`}>
                    {withCitations(t.answer, active, setActive)}
                    {t.streaming && t.answer && <span className="caret" />}
                  </div>
                )}

                {t.sources.length > 0 && (
                  <div className="srcs">
                    {t.sources.map((s) => (
                      <div key={s.key} className="src" data-on={active === s.n}
                        onMouseEnter={() => setActive(s.n)} onMouseLeave={() => setActive(null)}>
                        <div className="h">
                          <span className="trunc">[{s.n}] {s.label}</span>
                          {s.score !== null && <span>{s.score.toFixed(3)}</span>}
                        </div>
                        <div className="x">{s.excerpt}</div>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
            <div ref={bottom} />
          </>
        )}
      </div>

      {composer}

      {/* Collapses to zero on the first question, which is what slides the
          composer from the middle of the screen down to the bottom. */}
      <div className="drop-spacer" data-empty={empty} />
    </div>
  );
}
