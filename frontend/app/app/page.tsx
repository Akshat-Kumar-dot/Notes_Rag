"use client";

import { useCallback, useEffect, useState } from "react";
import { Chat } from "@/components/Chat";
import { Files } from "@/components/Files";
import { Sidebar } from "@/components/Sidebar";
import { api, type Folder, type User } from "@/lib/api";

export default function Workspace() {
  const [user, setUser] = useState<User | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "files">("chat");

  const loadFolders = useCallback(async () => {
    const list = await api.folders();
    setFolders(list);
    setActiveId((cur) => cur ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    api.me().then(setUser).catch(() => {});
    loadFolders().catch(() => {});
  }, [loadFolders]);

  async function newFolder() {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    try {
      const f = await api.createFolder(name.trim());
      await loadFolders();
      setActiveId(f.id);
      setView("files");
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Couldn't create that folder.");
    }
  }

  if (!user) return null;
  const active = folders.find((f) => f.id === activeId) ?? null;

  return (
    <div className="shell">
      <Sidebar
        user={user}
        folders={folders}
        activeFolder={activeId}
        view={view}
        indexedBytes={0}
        onSelectFolder={(id) => { setActiveId(id); }}
        onView={setView}
        onNewFolder={newFolder}
        onSignOut={async () => { await api.logout(); window.location.replace("/"); }}
      />
      <main className="main">
        {view === "files" ? (
          <div className="scroll">
            {active
              ? <Files folderId={active.id} onChanged={loadFolders} />
              : <p className="dim">Create a folder to upload files.</p>}
          </div>
        ) : (
          <Chat folder={active} />
        )}
      </main>
    </div>
  );
}
