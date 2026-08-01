"use client";

import { I } from "@/components/Icons";
import type { Folder, User } from "@/lib/api";

const fmt = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function Sidebar({
  user, folders, activeFolder, view, indexedBytes,
  onSelectFolder, onView, onNewFolder, onSignOut,
}: {
  user: User;
  folders: Folder[];
  activeFolder: string | null;
  view: "chat" | "files";
  indexedBytes: number;
  onSelectFolder: (id: string) => void;
  onView: (v: "chat" | "files") => void;
  onNewFolder: () => void;
  onSignOut: () => void;
}) {
  return (
    <aside className="side">
      <div className="brand">{I.logo} Notes Rag</div>

      <nav className="nav">
        <button data-on={view === "files"} onClick={() => onView("files")}>
          {I.file} My Files
        </button>
        <button data-on={view === "chat"} onClick={() => onView("chat")}>
          {I.chat} Chat
        </button>
      </nav>

      <div className="sect">Workspace</div>
      {folders.map((f) => (
        <button
          key={f.id}
          className="fcard"
          data-on={activeFolder === f.id}
          onClick={() => onSelectFolder(f.id)}
        >
          {I.folder}
          <span className="grow trunc">
            <span className="t trunc" style={{ display: "block" }}>{f.name}</span>
            <span className="s">{f.file_count} {f.file_count === 1 ? "file" : "files"}</span>
          </span>
          {I.chevron}
        </button>
      ))}
      <button className="fcard" onClick={onNewFolder}>
        {I.plus}
        <span className="grow"><span className="t">New folder</span></span>
      </button>

      <div className="sect">Indexed</div>
      <div style={{ padding: "0 8px" }}>
        {/* Size of extracted text, not uploaded bytes -- originals are discarded.
            No cap shown: quotas don't exist yet, and a fake limit would mislead. */}
        <div className="meter"><span style={{ width: indexedBytes ? "100%" : "0%" }} /></div>
        <div className="s" style={{ color: "var(--muted)", fontSize: 11 }}>
          {fmt(indexedBytes)} across {folders.length} {folders.length === 1 ? "folder" : "folders"}
        </div>
      </div>

      <div className="user">
        <button className="fcard" onClick={onSignOut} title="Sign out">
          {user.avatar_url
            ? <img className="avatar" src={user.avatar_url} alt="" />
            : I.user}
          <span className="grow trunc">
            <span className="t trunc" style={{ display: "block" }}>{user.display_name ?? "Signed in"}</span>
            <span className="s trunc" style={{ display: "block" }}>Sign out</span>
          </span>
        </button>
      </div>
    </aside>
  );
}
