"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { I } from "@/components/Icons";
import { Orb } from "@/components/Orb";
import { useDictation } from "@/lib/dictation";
import { Markdown } from "@/lib/markdown";
import {
  api, chats, streamMessage, type ConversationDetail, type FileRow, type Folder, type Source,
} from "@/lib/api";

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
  /** What the turn is waiting on before its first word, if anything. */
  phase: Phase | null;
}

type Phase = "searching" | "thinking" | "reconnecting";
const PHASE_LABEL: Record<Phase, string> = {
  searching: "Searching your notes…",
  thinking: "Thinking…",
  reconnecting: "The model is busy. Reconnecting…",
};

const fromSource = (s: Source): Src => ({
  n: s.n,
  key: s.chunk_id,
  label: s.filename + (s.page_number && s.page_number > 1 ? `, p.${s.page_number}` : ""),
  excerpt: s.excerpt,
  score: s.score,
});

/** Stored messages -> rendered turns (a user message opens a turn, the
 *  assistant reply fills it in). */
function toTurns(c: ConversationDetail): Turn[] {
  const out: Turn[] = [];
  for (const m of c.messages) {
    if (m.role === "user") {
      out.push({
        id: m.id, question: m.content, answer: "", sources: [],
        lowConfidence: false, streaming: false, error: null, searchOnly: false, phase: null,
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
  return out;
}

/** A file being added from the chat: uploading, then read and indexed. */
interface Upload {
  key: string;
  name: string;
  status: "uploading" | FileRow["status"];
  error: string | null;
}

const IN_FLIGHT = new Set<Upload["status"]>(["uploading", "pending", "parsing"]);
const UPLOAD_LABEL: Partial<Record<Upload["status"], string>> = {
  uploading: "Uploading…", pending: "Queued", parsing: "Reading…",
};
/** A first-time user has no folder yet; their first upload makes this one. */
const FIRST_FOLDER = "My notes";

export function Chat({
  folders, scopeFolderId, resumeId, onScopeChange, onConversationCreated,
  onTurnDone, onFilesChanged, onNewChat,
}: {
  folders: Folder[];
  /** The folder a NEW chat searches. Once a chat exists its scope is fixed. */
  scopeFolderId: string | null;
  resumeId?: string | null;
  onScopeChange: (folderId: string) => void;
  onConversationCreated?: (id: string) => void;
  /** After every question, answered or not: titles and guest credits change. */
  onTurnDone?: () => void;
  /** Uploads change folder counts, storage and a guest's credits. */
  onFilesChanged?: () => void;
  onNewChat: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<"ask" | "search">("ask");
  const [active, setActive] = useState<number | null>(null);
  const [openSrc, setOpenSrc] = useState<Record<string, boolean>>({});
  // Folder scope of an existing chat -- fixed at creation, so older answers
  // stay explainable. null while this is still a new, unsent chat.
  const [fixedScope, setFixedScope] = useState<string[] | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const convo = useRef<string | null>(null);
  // Set once the user asks something here, so a background refresh of the
  // stored chat can't overwrite a turn that is on screen.
  const touched = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const busy = turns.some((t) => t.streaming);
  const empty = turns.length === 0;

  const scopeIds = fixedScope ?? (scopeFolderId ? [scopeFolderId] : []);
  const scopeFolders = folders.filter((f) => scopeIds.includes(f.id));
  // An old chat whose folders were all deleted has nothing left to search.
  const orphaned = fixedScope !== null && scopeFolders.length === 0;
  const canAsk = scopeFolders.length > 0 && !orphaned;
  const scopeName = scopeFolders.map((f) => f.name).join(", ");
  const hasFiles = scopeFolders.some((f) => f.file_count > 0)
    || uploads.some((u) => u.status === "indexed" || u.status === "partial");


  // Reopening a chat replays its stored messages, and it stays live: the
  // composer asks follow-ups in the same conversation. A chat opened (or
  // hovered) before shows at once from memory, then refreshes quietly.
  useEffect(() => {
    if (!resumeId) return;
    let cancelled = false;
    convo.current = resumeId;
    const show = (c: ConversationDetail) => {
      if (cancelled || touched.current) return;
      setFixedScope(c.folder_ids);
      setTurns(toTurns(c));
    };
    const cached = chats.cached(resumeId);
    if (cached) show(cached);
    else setLoading(true);
    chats.load(resumeId)
      .then(show)
      .catch(() => {
        // Deleted, or a stale link: carry on as a new chat rather than send
        // questions to a conversation that no longer exists.
        if (!cancelled && !cached) convo.current = null;
      })
      .finally(() => { if (!cancelled) setLoading(false); });
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

  const mic = useDictation(value, setValue, () => requestAnimationFrame(grow));

  // ---- files, added without leaving the chat -------------------------------

  const patchUpload = (key: string, fn: (u: Upload) => Upload) =>
    setUploads((prev) => prev.map((u) => (u.key === key ? fn(u) : u)));

  async function addFiles(list: FileList | File[] | null) {
    const files = Array.from(list ?? []);
    if (!files.length || orphaned) return;

    let target = scopeFolders[0]?.id ?? null;
    if (!target) {
      // New user: no folder yet. Make one rather than send them to set up a
      // workspace before they can do anything.
      try {
        const f = await api.createFolder(FIRST_FOLDER);
        target = f.id;
        onScopeChange(f.id);
      } catch (e) {
        setUploads((p) => [...p, {
          key: crypto.randomUUID(), name: files[0].name, status: "failed",
          error: e instanceof Error ? e.message : "Couldn't create a folder.",
        }]);
        return;
      }
    }

    for (const file of files) {
      const key = crypto.randomUUID();
      setUploads((p) => [...p, { key, name: file.name, status: "uploading", error: null }]);
      try {
        const row = await api.upload(target, file);
        patchUpload(key, (u) => ({ ...u, status: row.status }));
        onFilesChanged?.();
        void watch(key, row.id);
      } catch (e) {
        patchUpload(key, (u) => ({ ...u, status: "failed", error: e instanceof Error ? e.message : "Upload failed." }));
      }
    }
  }

  /** Reading happens in the background on the server; poll until it lands. */
  async function watch(key: string, fileId: string) {
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const f = await api.file(fileId);
        patchUpload(key, (u) => ({ ...u, status: f.status, error: f.status === "failed" ? f.error : null }));
        if (f.status !== "pending" && f.status !== "parsing") {
          onFilesChanged?.();
          return;
        }
      } catch { /* transient: keep polling */ }
    }
  }

  // ---- asking ---------------------------------------------------------------

  const patch = (id: string, fn: (t: Turn) => Turn) =>
    setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

  async function submit() {
    const q = value.trim();
    if (!q || busy || !canAsk) return;
    if (mic.listening) mic.stop();
    touched.current = true;
    setValue("");
    requestAnimationFrame(grow);

    const id = crypto.randomUUID();
    setTurns((p) => [...p, {
      id, question: q, answer: "", sources: [], lowConfidence: false,
      streaming: true, error: null, searchOnly: mode === "search", phase: "searching",
    }]);

    // Search mode never touches the model: no rate limit, nothing invented.
    if (mode === "search") {
      try {
        const r = await api.search(q, scopeIds);
        patch(id, (t) => ({
          ...t, sources: r.results.map(fromSource),
          lowConfidence: r.low_confidence, streaming: false, phase: null,
        }));
      } catch (e) {
        patch(id, (t) => ({ ...t, error: e instanceof Error ? e.message : "Search failed.", streaming: false, phase: null }));
      }
      onTurnDone?.();
      return;
    }

    try {
      if (!convo.current) {
        const c = await api.createConversation(scopeIds);
        convo.current = c.id;
        setFixedScope(c.folder_ids);
        onConversationCreated?.(c.id);
      }
    } catch (e) {
      patch(id, (t) => ({ ...t, error: e instanceof Error ? e.message : "Couldn't start chat.", streaming: false, phase: null }));
      return;
    }

    await streamMessage(convo.current, q, {
      // Sources arrive before the model starts: from here it is thinking.
      onSources: (s, low) => patch(id, (t) => ({ ...t, sources: s.map(fromSource), lowConfidence: low, phase: "thinking" })),
      onStatus: (st) => { if (st === "reconnecting") patch(id, (t) => ({ ...t, phase: "reconnecting" })); },
      onToken: (d) => patch(id, (t) => ({ ...t, answer: t.answer + d, phase: null })),
      onDone: () => patch(id, (t) => ({ ...t, streaming: false, phase: null })),
      onError: (m) => patch(id, (t) => ({ ...t, error: m, streaming: false, phase: null })),
    });
    patch(id, (t) => ({ ...t, streaming: false, phase: null }));
    // The stored copy no longer has this turn; reopening should fetch it.
    if (convo.current) chats.forget(convo.current);
    onTurnDone?.();
  }

  const placeholder = orphaned ? "This chat's folder was deleted"
    : !canAsk ? "Add a file to start asking…"
      : mode === "search" ? `Search ${scopeName}…` : "Ask your files…";

  const composer = (
    <div className="composer-wrap">
      {uploads.length > 0 && (
        <div className="attach">
          {uploads.map((u) => (
            <div key={u.key} className="chip" data-s={u.status} title={u.error ?? u.name}>
              {IN_FLIGHT.has(u.status)
                ? <Orb wait="reading" />
                : <span className="ico">{u.status === "failed" ? I.trash : I.check}</span>}
              <span className="trunc">{u.name}</span>
              <span className="chip-s">
                {UPLOAD_LABEL[u.status] ?? (u.status === "failed" ? (u.error ?? "Failed") : "Ready")}
              </span>
              {!IN_FLIGHT.has(u.status) && (
                <button className="chip-x" aria-label={`Dismiss ${u.name}`}
                  onClick={() => setUploads((p) => p.filter((x) => x.key !== u.key))}>×</button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <button className="iconbtn ghost" onClick={() => picker.current?.click()}
          disabled={orphaned} title="Add files" aria-label="Add files">{I.plus}</button>
        <input
          ref={picker} type="file" multiple hidden
          accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
        />
        <textarea
          ref={box} rows={1} value={value}
          placeholder={placeholder}
          disabled={!canAsk}
          onChange={(e) => { setValue(e.target.value); grow(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        {mic.supported && (
          <button className="iconbtn ghost mic" data-on={mic.listening} onClick={mic.toggle}
            disabled={!canAsk} title={mic.listening ? "Stop dictation" : "Dictate"}
            aria-label={mic.listening ? "Stop dictation" : "Start dictation"}>
            {I.mic}
          </button>
        )}
        <button className="iconbtn send" onClick={submit}
          disabled={!value.trim() || busy || !canAsk} title="Send" aria-label="Send">
          {I.send}
        </button>
      </div>
      <div className="actions">
        <button data-on={mode === "ask"} onClick={() => setMode("ask")}>Ask AI</button>
        <button data-on={mode === "search"} onClick={() => setMode("search")}>Search Notes</button>
      </div>
      {/* A new chat can still change folder; an existing one cannot. */}
      {fixedScope === null && folders.length > 1 ? (
        <label className="scope">
          {I.folder}
          <select value={scopeFolderId ?? ""} onChange={(e) => onScopeChange(e.target.value)}
            aria-label="Folder to ask across">
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      ) : scopeName && <div className="scope">{I.folder}<span>{scopeName}</span></div>}
    </div>
  );

  return (
    <div
      className="chatpane"
      onDragOver={(e) => {
        if (orphaned || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer leaves the pane, not when it crosses a child.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="dropzone">
          <div>{I.upload}<span>Drop to add to <b>{scopeName || FIRST_FOLDER}</b></span></div>
        </div>
      )}

      <div className="scroll" data-empty={empty}>
        {empty && loading ? (
          <div className="hero">
            <Orb wait="reading" size={32} label="Opening chat…" className="hero-wait" />
          </div>
        ) : empty ? (
          <div className="hero">
            {orphaned ? (
              <>
                <h2>This chat&apos;s folder was deleted</h2>
                <p>There&apos;s nothing left for it to search.</p>
                <button className="btn primary hero-btn" onClick={onNewChat}>{I.plus} Start a new chat</button>
              </>
            ) : hasFiles ? (
              <>
                <h2>What would you like to know?</h2>
                <p>Asking across <strong>{scopeName}</strong></p>
              </>
            ) : (
              <>
                <h2>Add a document to get started</h2>
                <p>PDFs, Word files, notes or images. Then ask anything about them.</p>
                <button className="btn primary hero-btn" onClick={() => picker.current?.click()}>
                  {I.upload} Add files
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            {orphaned && (
              <div className="turn">
                <p className="note warn">
                  This chat&apos;s folder was deleted, so it can&apos;t search anything new.{" "}
                  <button className="linkish" onClick={onNewChat}>Start a new chat</button>
                </p>
              </div>
            )}
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

                {t.streaming && !t.answer && t.phase && (
                  <Orb wait={t.phase} label={PHASE_LABEL[t.phase]} className="turn-wait" />
                )}

                {!t.searchOnly && t.answer && (
                  <div className="a">
                    <Markdown text={t.answer} ctx={{ active, onHover: setActive }} />
                    {t.streaming && <span className="caret" />}
                  </div>
                )}

                {t.sources.length > 0 && (() => {
                  // Search mode has nothing but sources, so they open by default;
                  // under an answer they stay folded until asked for.
                  const open = openSrc[t.id] ?? t.searchOnly;
                  return (
                    <div className="srcs">
                      <button className="srcs-toggle" data-open={open}
                        aria-expanded={open}
                        onClick={() => setOpenSrc((p) => ({ ...p, [t.id]: !open }))}>
                        <span className="ico">{I.file}</span>
                        <span className="grow">
                          {t.sources.length} {t.sources.length === 1 ? "source" : "sources"}
                        </span>
                        <span className="chev">{I.chevron}</span>
                      </button>

                      {open && (
                        <div className="srcs-scroll">
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
                    </div>
                  );
                })()}
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
