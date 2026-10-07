"use client";

import { useCallback, useEffect, useState } from "react";
import { I } from "@/components/Icons";
import { Orb } from "@/components/Orb";
import {
  study, type Folder, type MapFile, type Passage, type QuizResult, type StudyMapData,
} from "@/lib/api";
import { useDictation } from "@/lib/dictation";
import { Markdown } from "@/lib/markdown";

/** Passages per Teach me / Quiz me; matches PASSAGES on the server. */
const SPAN = 3;

type Selection = { file: MapFile; index: number };
type Session =
  | { kind: "idle" }
  | { kind: "busy"; label: string; wait: "thinking" | "searching" }
  | { kind: "teach"; text: string; passages: Passage[] }
  | { kind: "quiz"; quizId: string; question: string; passages: Passage[] }
  | { kind: "result"; question: string; answer: string; result: QuizResult }
  | { kind: "error"; message: string };

const state = (s: number, lit: number) => (s < 0 ? "dark" : s < lit ? "fading" : "lit");

/** "Page 12" where the file really has pages (PDFs); otherwise "Passage 3".
 *  Text and Markdown files report every passage as page 1. */
const where = (file: MapFile, i: number) =>
  file.pages[i] && new Set(file.pages).size > 1 ? `Page ${file.pages[i]}` : `Passage ${i + 1}`;

function describe(file: MapFile, i: number, lit: number) {
  const page = where(file, i);
  const s = file.cells[i], age = file.ages[i];
  const when = age <= 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`;
  if (s < 0) return `${page} · not studied yet`;
  return s < lit ? `${page} · fading, last studied ${when}` : `${page} · studied ${when}`;
}

/** The longest run of never-studied passages in the folder: the best place
 *  to start when you don't know where to start. */
function biggestBlindSpot(files: MapFile[]): Selection | null {
  let best: Selection | null = null, bestLen = 0;
  for (const file of files) {
    let run = 0;
    for (let i = 0; i < file.cells.length; i++) {
      run = file.cells[i] < 0 ? run + 1 : 0;
      if (run > bestLen) { bestLen = run; best = { file, index: i - run + 1 }; }
    }
  }
  return best;
}

export function StudyMap({ folders, folderId, onPickFolder, onStudied }: {
  folders: Folder[];
  folderId: string | null;
  onPickFolder: (id: string) => void;
  /** A guest's credits changed. */
  onStudied?: () => void;
}) {
  const [map, setMap] = useState<StudyMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [session, setSession] = useState<Session>({ kind: "idle" });
  const [answer, setAnswer] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const mic = useDictation(answer, setAnswer);

  const load = useCallback(async () => {
    if (!folderId) return;
    try {
      setMap(await study.map(folderId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the map.");
    }
  }, [folderId]);

  useEffect(() => {
    setMap(null); setSel(null); setSession({ kind: "idle" });
    load();
  }, [load]);

  function select(file: MapFile, index: number) {
    if (session.kind === "busy") return;
    setSel({ file, index });
    setSession({ kind: "idle" });
    setAnswer("");
  }

  async function run(mode: "teach" | "quiz") {
    if (!sel || !folderId) return;
    setSession({ kind: "busy", wait: "thinking", label: mode === "teach" ? "Reading these passages…" : "Writing a question…" });
    try {
      const out = await study.start(folderId, sel.file.id, sel.file.ordinals[sel.index], mode);
      if (out.mode === "teach") {
        setSession({ kind: "teach", text: out.text ?? "", passages: out.passages });
        load();
      } else {
        setSession({ kind: "quiz", quizId: out.quiz_id!, question: out.question ?? "", passages: out.passages });
      }
    } catch (e) {
      setSession({ kind: "error", message: e instanceof Error ? e.message : "Something went wrong." });
    }
    onStudied?.();
  }

  async function submit() {
    if (session.kind !== "quiz" || !answer.trim()) return;
    if (mic.listening) mic.stop();
    const { quizId, question } = session;
    setSession({ kind: "busy", wait: "searching", label: "Checking your answer against your notes…" });
    try {
      const result = await study.answer(quizId, answer.trim());
      setSession({ kind: "result", question, answer: answer.trim(), result });
      load();
    } catch (e) {
      setSession({ kind: "error", message: e instanceof Error ? e.message : "Couldn't check that answer." });
    }
  }

  if (!folderId) {
    return (
      <div className="page map">
        <h2 className="page-h">Study map</h2>
        <p className="dim">Add a file from the chat first. Its passages will show up here.</p>
      </div>
    );
  }

  const pct = (n: number) => (map && map.total ? Math.round((n / map.total) * 100) : 0);
  const selected = (file: MapFile, i: number) =>
    sel?.file.id === file.id && i >= sel.index && i < sel.index + SPAN;
  const blind = map ? biggestBlindSpot(map.files) : null;

  return (
    <div className="page map">
      <div className="map-head">
        <div>
          <h2 className="page-h">Study map</h2>
          <p className="dim">Every square is a passage of your notes. Dark ones you have never studied.</p>
        </div>
        {folders.length > 1 && (
          <label className="map-folder">
            {I.folder}
            <select value={folderId} onChange={(e) => onPickFolder(e.target.value)} aria-label="Folder">
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {error && <p className="note err">{error}</p>}
      {!map && !error && <Orb wait="reading" size={32} label="Mapping your notes…" className="map-wait" />}

      {map && map.total === 0 && (
        <div className="panel">
          <p className="dim">Nothing to map in <strong>{map.folder_name}</strong> yet. Upload a document from the chat and its passages appear here.</p>
        </div>
      )}

      {map && map.total > 0 && (
        <>
          <div className="map-stats">
            <div><b>{pct(map.studied)}%</b><span>studied</span></div>
            <div><b>{pct(map.fading)}%</b><span>fading</span></div>
            <div><b>{map.total - map.studied}</b><span>never studied</span></div>
            <div className="map-legend">
              <span><i data-s="dark" /> Not yet</span>
              <span><i data-s="lit" /> Studied</span>
              <span><i data-s="fading" /> Fading</span>
            </div>
          </div>

          {blind && !sel && (
            <button className="btn primary map-start" onClick={() => select(blind.file, blind.index)}>
              {I.sparkle} Start with my biggest blind spot
            </button>
          )}

          {map.files.map((file) => {
            const seen = file.cells.filter((s) => s >= 0).length;
            return (
              <section key={file.id} className="map-file">
                <div className="map-file-h">
                  <span className="ico">{I.file}</span>
                  <span className="trunc">{file.name}</span>
                  <span className="dim">{seen} of {file.cells.length} studied</span>
                </div>
                {file.cells.length === 0 ? (
                  <p className="dim">{file.status === "failed" ? "This file couldn't be read." : "Still being read…"}</p>
                ) : (
                  <div className="cells">
                    {file.cells.map((s, i) => (
                      <button
                        key={i}
                        className="cell"
                        data-s={state(s, map.lit)}
                        data-sel={selected(file, i)}
                        // brightness follows strength, so fresh reads brighter than old
                        style={{ "--a": s < 0 ? 0 : Math.min(1, 0.3 + (s / (map.lit * 3)) * 0.7) } as React.CSSProperties}
                        title={describe(file, i, map.lit)}
                        aria-label={describe(file, i, map.lit)}
                        onClick={() => select(file, i)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}

      {sel && map && (
        <div className="study-panel" role="region" aria-label="Study these passages">
          <div className="study-h">
            <span className="grow">
              <span className="t">{(() => {
                const last = Math.min(sel.index + SPAN, sel.file.cells.length) - 1;
                const a = where(sel.file, sel.index), b = where(sel.file, last);
                if (last === sel.index || a === b) return a;
                // "Passages 4–6", or "Page 3 – Page 5"
                return a.startsWith("Passage") ? `Passages ${sel.index + 1}–${last + 1}` : `${a} – ${b}`;
              })()}</span>
              <span className="s trunc">{sel.file.name}</span>
            </span>
            <button className="mini" onClick={() => { setSel(null); setSession({ kind: "idle" }); }}
              aria-label="Close" title="Close">×</button>
          </div>

          {(session.kind === "idle" || session.kind === "error") && (
            <>
              {session.kind === "error" && <p className="note err">{session.message}</p>}
              <div className="study-actions">
                <button className="btn primary" onClick={() => run("teach")}>{I.chat} Teach me</button>
                <button className="btn" onClick={() => run("quiz")}>{I.sparkle} Quiz me</button>
              </div>
            </>
          )}

          {session.kind === "busy" && <Orb wait={session.wait} label={session.label} className="study-wait" />}

          {session.kind === "teach" && (
            <div className="study-body">
              <div className="a"><Markdown text={session.text} ctx={{ active, onHover: setActive }} /></div>
              <Sources passages={session.passages} active={active} onHover={setActive} />
              <div className="study-actions">
                <button className="btn" onClick={() => run("quiz")}>{I.sparkle} Now quiz me on it</button>
              </div>
            </div>
          )}

          {session.kind === "quiz" && (
            <div className="study-body">
              <p className="study-q">{session.question}</p>
              <div className="composer study-answer">
                <textarea rows={3} value={answer} placeholder="Answer in your own words…"
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }} />
                {mic.supported && (
                  <button className="iconbtn ghost mic" data-on={mic.listening} onClick={mic.toggle}
                    title={mic.listening ? "Stop dictation" : "Answer by voice"}
                    aria-label={mic.listening ? "Stop dictation" : "Answer by voice"}>{I.mic}</button>
                )}
                <button className="iconbtn send" onClick={submit} disabled={!answer.trim()}
                  title="Check my answer" aria-label="Check my answer">{I.send}</button>
              </div>
              <p className="dim">The passages stay hidden until you answer.</p>
            </div>
          )}

          {session.kind === "result" && (
            <div className="study-body">
              <p className="study-q">{session.question}</p>
              <div className="verdict" data-v={session.result.verdict}>
                <b>{session.result.verdict === "correct" ? "Correct" : session.result.verdict === "partial" ? "Partly right" : "Not quite"}</b>
                <span>{Math.round(session.result.score * 100)}%</span>
              </div>
              {session.result.feedback && <p>{session.result.feedback}</p>}
              {session.result.missed.length > 0 && (
                <>
                  <p className="dim study-sub">You missed</p>
                  <ul className="study-missed">{session.result.missed.map((m) => <li key={m}>{m}</li>)}</ul>
                </>
              )}
              <Sources passages={session.result.passages} active={active} onHover={setActive} open />
              <div className="study-actions">
                <button className="btn" onClick={() => { setAnswer(""); run("quiz"); }}>{I.sparkle} Another question</button>
                <button className="btn" onClick={() => run("teach")}>{I.chat} Teach me this</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Sources({ passages, active, onHover, open: startOpen = false }: {
  passages: Passage[]; active: number | null; onHover: (n: number | null) => void; open?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  if (!passages.some((p) => p.excerpt)) return null;
  return (
    <div className="srcs">
      <button className="srcs-toggle" data-open={open} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ico">{I.file}</span>
        <span className="grow">From your notes: {passages.length} {passages.length === 1 ? "passage" : "passages"}</span>
        <span className="chev">{I.chevron}</span>
      </button>
      {open && (
        <div className="srcs-scroll">
          {passages.map((p) => (
            <div key={p.n} className="src" data-on={active === p.n}
              onMouseEnter={() => onHover(p.n)} onMouseLeave={() => onHover(null)}>
              <div className="h"><span className="trunc">[{p.n}] {p.label}</span></div>
              <div className="x">{p.excerpt}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
