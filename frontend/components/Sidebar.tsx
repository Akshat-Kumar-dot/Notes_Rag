"use client";

import { I, Logo } from "@/components/Icons";
import type { Folder, Storage, User } from "@/lib/api";

export type View = "chat" | "files" | "history" | "settings";

export const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B`
    : n < 1048576 ? `${(n / 1024).toFixed(0)} KB`
      : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB`
        : `${(n / 1073741824).toFixed(2)} GB`;

const NAV: { id: View; label: string; icon: keyof typeof I }[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "files", label: "My Files", icon: "file" },
  { id: "history", label: "Chat History", icon: "history" },
];

export function Sidebar({
  user, folders, storage, activeFolder, view, collapsed, drawer,
  onSelectFolder, onView, onNewFolder, onDeleteFolder, onToggleCollapse, onCloseDrawer,
}: {
  user: User;
  folders: Folder[];
  storage: Storage | null;
  activeFolder: string | null;
  view: View;
  collapsed: boolean;
  drawer: boolean;
  onSelectFolder: (id: string) => void;
  onView: (v: View) => void;
  onNewFolder: () => void;
  onDeleteFolder: (f: Folder) => void;
  onToggleCollapse: () => void;
  onCloseDrawer: () => void;
}) {
  const pct = storage && storage.limit_bytes
    ? Math.min(100, (storage.used_bytes / storage.limit_bytes) * 100)
    : 0;

  return (
    <>
      {/* Phone drawer scrim. Absent from the layout entirely on desktop. */}
      <div className="scrim" data-on={drawer} onClick={onCloseDrawer} aria-hidden="true" />
      <aside className="side" data-collapsed={collapsed} data-drawer={drawer}>
      <div className="brand">
        {/* Collapsed, the mark is the only way back -- so it is the control. */}
        <button className="brand-mark" onClick={collapsed ? onToggleCollapse : undefined}
          data-btn={collapsed}
          title={collapsed ? "Expand sidebar" : undefined}
          aria-label={collapsed ? "Expand sidebar" : undefined}>
          <Logo size={20} />
        </button>
        <span className="lbl brand-name grow">Notes Rag</span>
        {/* Hidden once collapsed: nothing to collapse, and no room for it. */}
        {!collapsed && (
          <button className="collapse" onClick={onToggleCollapse}
            title="Collapse sidebar" aria-label="Collapse sidebar">{I.panel}</button>
        )}
      </div>

      <nav className="nav">
        {NAV.map((n) => (
          <button key={n.id} data-on={view === n.id} onClick={() => onView(n.id)} title={n.label}>
            <span className="ico">{I[n.icon]}</span>
            <span className="lbl">{n.label}</span>
          </button>
        ))}
      </nav>

      <div className="sep" />

      <div className="sect">
        <span className="lbl">Workspace</span>
        <button className="mini" onClick={onNewFolder} title="New folder">{I.plus}</button>
      </div>

      <div className="folders">
        {folders.map((f) => (
          <div key={f.id} className="fcard" data-on={activeFolder === f.id}>
            <button className="fmain" onClick={() => onSelectFolder(f.id)} title={f.name}>
              <span className="ico">{I.folder}</span>
              <span className="grow trunc lbl">
                <span className="t trunc">{f.name}</span>
                <span className="s">
                  {f.file_count} {f.file_count === 1 ? "file" : "files"}
                  {f.size_bytes > 0 && ` · ${fmtBytes(f.size_bytes)}`}
                </span>
              </span>
            </button>
            <button
              className="fdel lbl"
              title={`Delete "${f.name}"`}
              aria-label={`Delete folder ${f.name}`}
              onClick={() => onDeleteFolder(f)}
            >
              {I.trash}
            </button>
          </div>
        ))}

        {folders.length === 0 && (
          <button className="fcard newf lbl" onClick={onNewFolder}>
            <span className="ico">{I.plus}</span>
            <span className="t">New folder</span>
          </button>
        )}
      </div>

      <div className="sep" />

      <div className="sect"><span className="lbl">Storage</span></div>
      <div className="storage lbl">
        <div className="meter" title={`${pct.toFixed(0)}% used`}>
          <span style={{ width: `${pct}%` }} data-full={pct > 90} />
        </div>
        <div className="s">
          {storage
            ? <>{fmtBytes(storage.used_bytes)} / {fmtBytes(storage.limit_bytes)} · {storage.file_count} {storage.file_count === 1 ? "file" : "files"}</>
            : "—"}
        </div>
      </div>
      {/* Collapsed rail still needs a usage signal, but the text won't fit. */}
      {collapsed && (
        <div className="rail-meter" title={storage ? `${pct.toFixed(0)}% of storage used` : "Storage"}>
          <span style={{ height: `${pct}%` }} />
        </div>
      )}

      <div className="foot">
        <div className="sep" />
        <button
          className="nav-item"
          data-on={view === "settings"}
          onClick={() => onView("settings")}
          title="Settings"
        >
          <span className="ico">{I.settings}</span>
          <span className="lbl">Settings</span>
        </button>

        <button className="nav-item acct" onClick={() => onView("settings")} title={user.email ?? "Account"}>
          {user.avatar_url
            ? <img className="avatar" src={user.avatar_url} alt="" />
            : <span className="ico">{I.user}</span>}
          <span className="grow trunc lbl">
            <span className="t trunc">{user.display_name ?? "Account"}</span>
            <span className="s trunc">{user.email ?? "Signed in"}</span>
          </span>
        </button>
      </div>
      </aside>
    </>
  );
}
