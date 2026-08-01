"use client";

import { I } from "@/components/Icons";
import { fmtBytes } from "@/components/Sidebar";
import type { Storage, User } from "@/lib/api";

export function Settings({
  user, storage, onSignOut,
}: {
  user: User;
  storage: Storage | null;
  onSignOut: () => void;
}) {
  const pct = storage && storage.limit_bytes
    ? Math.min(100, (storage.used_bytes / storage.limit_bytes) * 100)
    : 0;

  return (
    <div className="page">
      <h2 className="page-h">Settings</h2>

      <section className="panel">
        <h3>Account</h3>
        <div className="row">
          {user.avatar_url
            ? <img className="avatar lg" src={user.avatar_url} alt="" />
            : <span className="ico">{I.user}</span>}
          <span className="grow trunc">
            <span className="t trunc">{user.display_name ?? "Signed in"}</span>
            <span className="s trunc">{user.email ?? "No email on file"}</span>
          </span>
          <button className="btn danger" onClick={onSignOut}>
            {I.logout} Sign out
          </button>
        </div>
      </section>

      <section className="panel">
        <h3>Storage</h3>
        <div className="meter lg" title={`${pct.toFixed(0)}% used`}>
          <span style={{ width: `${pct}%` }} data-full={pct > 90} />
        </div>
        <div className="stats">
          <div><b>{storage ? fmtBytes(storage.used_bytes) : "—"}</b><span>Used</span></div>
          <div><b>{storage ? fmtBytes(storage.limit_bytes) : "—"}</b><span>Limit</span></div>
          <div><b>{storage?.file_count ?? "—"}</b><span>Files</span></div>
          <div><b>{storage?.folder_count ?? "—"}</b><span>Folders</span></div>
        </div>
        <p className="dim">
          Counts the bytes you uploaded. Originals are discarded after indexing —
          only extracted text and its embeddings are kept.
        </p>
      </section>

      <section className="panel">
        <h3>How answers work</h3>
        <p className="dim">
          <strong>Ask AI</strong> retrieves passages from the selected folder, then
          has a model answer using only those passages, with <span className="cite">1</span>-style
          markers pointing at what it used. <strong>Search Notes</strong> skips the model
          entirely and returns the matching passages verbatim.
        </p>
      </section>
    </div>
  );
}
