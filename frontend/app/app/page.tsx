"use client";

import { useCallback, useEffect, useState } from "react";
import { Chat } from "@/components/Chat";
import { Files } from "@/components/Files";
import { History } from "@/components/History";
import { Settings } from "@/components/Settings";
import { Sidebar, type View } from "@/components/Sidebar";
import { api, type Folder, type Storage, type User } from "@/lib/api";

export default function Workspace() {
  const [user, setUser] = useState<User | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  const [collapsed, setCollapsed] = useState(false);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  const loadFolders = useCallback(async () => {
    const list = await api.folders();
    setFolders(list);
    setActiveId((cur) => (cur && list.some((f) => f.id === cur) ? cur : list[0]?.id ?? null));
  }, []);

  const loadStorage = useCallback(async () => {
    try { setStorage(await api.storage()); } catch { /* meter just stays blank */ }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadFolders(), loadStorage()]);
  }, [loadFolders, loadStorage]);

  useEffect(() => {
    api.me().then(setUser).catch(() => {});
    refresh().catch(() => {});
  }, [refresh]);

  // Sidebar preference is per-device, so it belongs in localStorage.
  useEffect(() => {
    setCollapsed(localStorage.getItem("sidebar") === "collapsed");
  }, []);
  const toggleCollapse = () =>
    setCollapsed((c) => {
      localStorage.setItem("sidebar", c ? "open" : "collapsed");
      return !c;
    });

  async function newFolder() {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    try {
      const f = await api.createFolder(name.trim());
      await refresh();
      setActiveId(f.id);
      setView("files");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Couldn't create that folder.");
    }
  }

  async function deleteFolder(f: Folder) {
    const msg = f.file_count > 0
      ? `Delete "${f.name}" and its ${f.file_count} ${f.file_count === 1 ? "file" : "files"}? This can't be undone.`
      : `Delete "${f.name}"?`;
    if (!window.confirm(msg)) return;
    try {
      await api.deleteFolder(f.id);
      if (activeId === f.id) setActiveId(null);
      await refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Couldn't delete that folder.");
    }
  }

  function openConversation(id: string) {
    setResumeId(id);
    setView("chat");
  }

  if (!user) return null;
  const active = folders.find((f) => f.id === activeId) ?? null;

  return (
    <div className="shell">
      <Sidebar
        user={user}
        folders={folders}
        storage={storage}
        activeFolder={activeId}
        view={view}
        collapsed={collapsed}
        onSelectFolder={(id) => { setActiveId(id); if (view === "settings" || view === "history") setView("chat"); }}
        onView={setView}
        onNewFolder={newFolder}
        onDeleteFolder={deleteFolder}
        onToggleCollapse={toggleCollapse}
      />

      <main className="main">
        {view === "files" && (
          <div className="scroll">
            {active
              ? <Files folderId={active.id} onChanged={refresh} />
              : <p className="dim">Create a folder to upload files.</p>}
          </div>
        )}

        {view === "history" && (
          <div className="scroll"><History key={historyKey} onOpen={openConversation} /></div>
        )}

        {view === "settings" && (
          <div className="scroll">
            <Settings
              user={user}
              storage={storage}
              onSignOut={async () => { await api.logout(); window.location.replace("/"); }}
            />
          </div>
        )}

        {view === "chat" && (
          // Remounting on resume clears the previous thread's state cleanly.
          <Chat
            key={resumeId ?? "new"}
            folder={active}
            resumeId={resumeId}
            onUpload={() => setView("files")}
            onConversationSaved={() => setHistoryKey((k) => k + 1)}
          />
        )}
      </main>
    </div>
  );
}
