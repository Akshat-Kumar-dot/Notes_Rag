"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { I, Logo } from "@/components/Icons";
import { chats, type Conversation, type Folder, type Storage, type User } from "@/lib/api";

export type View = "chat" | "files" | "map" | "graph" | "settings";

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B`
    : n < 1048576 ? `${(n / 1024).toFixed(0)} KB`
      : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB`
        : `${(n / 1073741824).toFixed(2)} GB`;

/** Chats shown per folder before "Show more": enough to find recent work
 *  without one busy folder pushing every other folder off the screen. */
const PER_FOLDER = 5;

/** Drag the sidebar's right edge to resize it. The width is remembered per
 *  device, but it can never be dragged narrower than MIN_W. */
const DEFAULT_W = 320, MIN_W = 260, MAX_W = 520;
const WIDTH_KEY = "sidebar-width";
const clampW = (w: number) => Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));

export function Sidebar({
  user, folders, conversations, storage, activeFolder, activeChat, view, collapsed, drawer,
  onNewChat, onOpenChat, onSelectFolder, onFiles, onMap, onGraph, onNewFolder, onDeleteFolder, onDeleteChat,
  onSettings, onToggleCollapse, onCloseDrawer,
}: {
  user: User;
  folders: Folder[];
  conversations: Conversation[];
  storage: Storage | null;
  activeFolder: string | null;
  activeChat: string | null;
  view: View;
  collapsed: boolean;
  drawer: boolean;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onSelectFolder: (id: string) => void;
  onFiles: (folderId: string | null) => void;
  onMap: () => void;
  onGraph: () => void;
  onNewFolder: () => void;
  onDeleteFolder: (f: Folder) => void;
  onDeleteChat: (c: Conversation) => void;
  onSettings: () => void;
  onToggleCollapse: () => void;
  onCloseDrawer: () => void;
}) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [width, setWidth] = useState(DEFAULT_W);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(DEFAULT_W);
  widthRef.current = width;

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      if (saved) setWidth(clampW(saved));
    } catch { /* private mode: default width */ }
  }, []);

  const saveWidth = (w: number) => {
    setWidth(w);
    try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private mode */ }
  };

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = widthRef.current;
    // Tracked here, not read back from state: a release in the same frame as
    // the last move would otherwise save the width from before it.
    let latest = startW;
    setResizing(true);
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      latest = clampW(startW + ev.clientX - startX);
      setWidth(latest);
    };
    const up = () => {
      setResizing(false);
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveWidth(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const pct = storage && storage.limit_bytes
    ? Math.min(100, (storage.used_bytes / storage.limit_bytes) * 100)
    : 0;

  // Each chat lives under the first of its folders that still exists; chats
  // whose folders were all deleted collect under "Other chats".
  const { byFolder, orphans } = useMemo(() => {
    const ids = new Set(folders.map((f) => f.id));
    const by = new Map<string, Conversation[]>();
    const rest: Conversation[] = [];
    for (const c of conversations) {
      const home = c.folder_ids.find((id) => ids.has(id));
      if (home) by.set(home, [...(by.get(home) ?? []), c]);
      else rest.push(c);
    }
    return { byFolder: by, orphans: rest };
  }, [folders, conversations]);

  const q = query.trim().toLowerCase();
  const matches = q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : [];

  const chatRow = (c: Conversation) => (
    <div key={c.id} className="crow" data-on={view === "chat" && activeChat === c.id}>
      {/* Hover or focus starts loading it, so the click usually finds it ready. */}
      <button className="cname" onClick={() => onOpenChat(c.id)} title={c.title}
        onMouseEnter={() => chats.prefetch(c.id)} onFocus={() => chats.prefetch(c.id)}>
        <span className="cdot" aria-hidden="true" />
        <span className="trunc">{c.title}</span>
      </button>
      <button className="mini del" onClick={() => onDeleteChat(c)}
        title="Delete chat" aria-label={`Delete chat ${c.title}`}>{I.trash}</button>
    </div>
  );

  return (
    <>
      {/* Phone drawer scrim. Absent from the layout entirely on desktop. */}
      <div className="scrim" data-on={drawer} onClick={onCloseDrawer} aria-hidden="true" />
      <aside className="side" data-collapsed={collapsed} data-drawer={drawer} data-resizing={resizing}
        style={{ "--side-w": `${width}px` } as React.CSSProperties}>
        <div className="brand">
          {/* Collapsed, the mark is the only way back -- so it is the control. */}
          <button className="brand-mark" onClick={collapsed ? onToggleCollapse : undefined}
            data-btn={collapsed}
            title={collapsed ? "Expand sidebar" : undefined}
            aria-label={collapsed ? "Expand sidebar" : undefined}>
            <Logo size={26} />
          </button>
          {/* Home: the landing page, where you can sign in with Google or out. */}
          <a className="lbl brand-name wordmark grow" href="/" title="Home">
            <b>notes</b>rag
          </a>
          {!collapsed && (
            <button className="collapse" onClick={onToggleCollapse}
              title="Collapse sidebar" aria-label="Collapse sidebar">{I.panel}</button>
          )}
        </div>

        {/* The logo also expands, but nobody guesses that: give the rail a
            button that says what it does. */}
        {collapsed && (
          <button className="collapse rail" onClick={onToggleCollapse}
            title="Expand sidebar" aria-label="Expand sidebar">{I.expand}</button>
        )}

        <label className="sb-search lbl">
          <span className="ico">{I.search}</span>
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats" aria-label="Search chats"
            onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
          />
        </label>

        <nav className="nav">
          <button onClick={onNewChat} data-on={view === "chat" && !activeChat} title="New chat">
            <span className="ico">{I.plus}</span>
            <span className="lbl">New chat</span>
          </button>
          <button onClick={() => onFiles(activeFolder)} data-on={view === "files"} title="Files">
            <span className="ico">{I.file}</span>
            <span className="lbl">Files</span>
          </button>
          <button onClick={onMap} data-on={view === "map"} title="Study map">
            <span className="ico">{I.grid}</span>
            <span className="lbl">Study map</span>
          </button>
          <button onClick={onGraph} data-on={view === "graph"} title="Chat graph">
            <span className="ico">{I.graph}</span>
            <span className="lbl">Chat graph</span>
          </button>
        </nav>

        <div className="tree lbl">
          {q ? (
            <>
              <div className="sect"><span>Results</span></div>
              {matches.map(chatRow)}
              {matches.length === 0 && <p className="tree-empty">No chats match &ldquo;{query}&rdquo;.</p>}
            </>
          ) : (
            <>
              <div className="sect">
                <span>Folders</span>
                <button className="mini" onClick={onNewFolder} title="New folder" aria-label="New folder">{I.plus}</button>
              </div>

              {folders.map((f) => {
                const chats = byFolder.get(f.id) ?? [];
                const open = !closed[f.id];
                const all = showAll[f.id];
                const shown = all ? chats : chats.slice(0, PER_FOLDER);
                return (
                  <div key={f.id} className="tnode">
                    <div className="frow" data-on={activeFolder === f.id}>
                      <button className="twist" data-open={open} aria-expanded={open}
                        aria-label={`${open ? "Collapse" : "Expand"} ${f.name}`}
                        onClick={() => setClosed((p) => ({ ...p, [f.id]: open }))}>
                        {I.chevron}
                      </button>
                      <button className="fname" onClick={() => onSelectFolder(f.id)}
                        title={`New chat in ${f.name} · ${f.file_count} ${f.file_count === 1 ? "file" : "files"}`}>
                        <span className="ico">{I.folder}</span>
                        <span className="trunc">{f.name}</span>
                      </button>
                      <button className="mini" onClick={() => onFiles(f.id)}
                        title={`Files in ${f.name}`} aria-label={`Files in ${f.name}`}>{I.file}</button>
                      <button className="mini del" onClick={() => onDeleteFolder(f)}
                        title={`Delete "${f.name}"`} aria-label={`Delete folder ${f.name}`}>{I.trash}</button>
                    </div>
                    {open && shown.map(chatRow)}
                    {open && chats.length > PER_FOLDER && (
                      <button className="more" onClick={() => setShowAll((p) => ({ ...p, [f.id]: !all }))}>
                        {all ? "Show less" : `Show ${chats.length - PER_FOLDER} more`}
                      </button>
                    )}
                  </div>
                );
              })}

              {folders.length === 0 && (
                <p className="tree-empty">Add a file from the chat and a folder is made for you.</p>
              )}

              {orphans.length > 0 && (
                <>
                  <div className="sect"><span>Other chats</span></div>
                  {orphans.map(chatRow)}
                </>
              )}
            </>
          )}
        </div>

        <div className="foot">
          <div className="storage lbl" title={storage ? `${storage.file_count} files` : undefined}>
            <div className="meter"><span style={{ width: `${pct}%` }} data-full={pct > 90} /></div>
            <div className="s">
              {storage ? <>{fmtBytes(storage.used_bytes)} of {fmtBytes(storage.limit_bytes)} used</> : "—"}
            </div>
          </div>
          {/* Collapsed rail still needs a usage signal, but the text won't fit. */}
          {collapsed && (
            <div className="rail-meter" title={storage ? `${pct.toFixed(0)}% of storage used` : "Storage"}>
              <span style={{ height: `${pct}%` }} />
            </div>
          )}
          <button className="nav-item acct" data-on={view === "settings"} onClick={onSettings}
            title="Settings">
            {user.avatar_url
              ? <img className="avatar" src={user.avatar_url} alt="" />
              : <span className="ico">{I.user}</span>}
            <span className="grow trunc lbl">
              <span className="t trunc">{user.display_name ?? "Account"}</span>
              <span className="s trunc">{user.email ?? (user.is_guest ? "Free trial" : "Signed in")}</span>
            </span>
            <span className="ico lbl acct-gear">{I.settings}</span>
          </button>
        </div>

        {!collapsed && (
          <div
            className="side-resize"
            role="separator" aria-orientation="vertical" aria-label="Resize sidebar"
            aria-valuemin={MIN_W} aria-valuemax={MAX_W} aria-valuenow={width}
            tabIndex={0} title="Drag to resize · double-click to reset"
            onPointerDown={startResize}
            onDoubleClick={() => saveWidth(DEFAULT_W)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") saveWidth(clampW(width - 16));
              else if (e.key === "ArrowRight") saveWidth(clampW(width + 16));
              else if (e.key === "Home") saveWidth(DEFAULT_W);
            }}
          />
        )}
      </aside>
    </>
  );
}
