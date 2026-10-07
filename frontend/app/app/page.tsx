"use client";

import { useCallback, useEffect, useState } from "react";
import { Chat } from "@/components/Chat";
import { ChatGraph } from "@/components/ChatGraph";
import { Files } from "@/components/Files";
import { Modal, type ModalSpec } from "@/components/Modal";
import { Orb } from "@/components/Orb";
import { Settings } from "@/components/Settings";
import { Sidebar, type View } from "@/components/Sidebar";
import { StudyMap } from "@/components/StudyMap";
import { Topbar } from "@/components/Topbar";
import {
  api, chats, type Conversation, type Folder, type GuestCredits, type Storage, type User,
} from "@/lib/api";

export default function Workspace() {
  const [user, setUser] = useState<User | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  // The open chat (null = a new, unsent one), and the key that remounts the
  // chat pane. They are separate on purpose: when a new chat is saved it gets
  // an id, and remounting then would wipe the answer that is still streaming.
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState("new-0");
  const [collapsed, setCollapsed] = useState(false);
  const [modal, setModal] = useState<ModalSpec | null>(null);
  const [drawer, setDrawer] = useState(false);

  const loadFolders = useCallback(async () => {
    const list = await api.folders();
    setFolders(list);
    setActiveId((cur) => (cur && list.some((f) => f.id === cur) ? cur : list[0]?.id ?? null));
  }, []);

  const loadConversations = useCallback(async () => {
    try { setConversations(await api.conversations()); } catch { /* list just stays stale */ }
  }, []);

  const loadStorage = useCallback(async () => {
    try { setStorage(await api.storage()); } catch { /* meter just stays blank */ }
  }, []);

  // Re-read after uploads and questions too: for a guest, /me carries the
  // credits left, and the banner should count down as they are spent.
  const loadUser = useCallback(async () => {
    try { setUser(await api.me()); } catch { /* 401 already redirects */ }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadFolders(), loadStorage(), loadUser(), loadConversations()]);
  }, [loadFolders, loadStorage, loadUser, loadConversations]);

  const openChat = useCallback((id: string) => {
    setChatId(id);
    setChatKey(id);
    setView("chat");
    setDrawer(false);
  }, []);

  const newChat = useCallback(() => {
    setChatId(null);
    setChatKey(`new-${Date.now()}`);
    setView("chat");
    setDrawer(false);
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
    // A reload (or a shared link) reopens the chat that was open.
    const c = new URLSearchParams(window.location.search).get("c");
    if (c) openChat(c);
  }, [refresh, openChat]);

  // Keep the open chat in the address bar, so reloading doesn't lose it.
  useEffect(() => {
    const url = view === "chat" && chatId ? `/app?c=${chatId}` : "/app";
    if (window.location.pathname + window.location.search !== url) {
      window.history.replaceState(null, "", url);
    }
  }, [view, chatId]);

  // Collapsing lasts for this page only. It used to persist, which meant one
  // accidental collapse greeted every later sign-in with a narrow rail.
  useEffect(() => {
    try { localStorage.removeItem("sidebar"); } catch { /* private mode */ }
  }, []);
  const toggleCollapse = () => setCollapsed((c) => !c);

  // Escape closes the drawer, matching the dialog's behaviour.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawer(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  // Errors are thrown so the dialog can show them inline and stay open, rather
  // than closing and dropping the user's typing on the floor.
  function newFolder() {
    setModal({
      title: "New folder",
      description: "Folders scope what a question is answered from.",
      input: { label: "Name", placeholder: "Research papers" },
      confirmLabel: "Create folder",
      onConfirm: async (name) => {
        const f = await api.createFolder(name);
        await refresh();
        setActiveId(f.id);
        newChat();   // lands on "Add a document to get started" for this folder
      },
    });
  }

  function deleteFolder(f: Folder) {
    setModal({
      title: `Delete "${f.name}"?`,
      description: f.file_count > 0
        ? `Its ${f.file_count} ${f.file_count === 1 ? "file" : "files"} and everything indexed from ${f.file_count === 1 ? "it" : "them"} will be removed. Its chats stay readable. This can't be undone.`
        : "This can't be undone.",
      confirmLabel: "Delete folder",
      danger: true,
      onConfirm: async () => {
        await api.deleteFolder(f.id);
        if (activeId === f.id) setActiveId(null);
        await refresh();
      },
    });
  }

  function deleteChat(c: Conversation) {
    setModal({
      title: "Delete chat?",
      description: `"${c.title}" and its saved answers will be removed. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        await api.deleteConversation(c.id);
        chats.forget(c.id);
        if (chatId === c.id) newChat();
        await loadConversations();
      },
    });
  }

  // Several round trips before anything can render; show that it's working.
  if (!user) {
    return (
      <div className="boot">
        <Orb wait="starting" size={64} label="Loading your workspace…" />
      </div>
    );
  }
  const active = folders.find((f) => f.id === activeId) ?? null;
  const openTitle = conversations.find((c) => c.id === chatId)?.title;

  return (
    <div className="shell">
      <Sidebar
        user={user}
        folders={folders}
        conversations={conversations}
        storage={storage}
        activeFolder={activeId}
        activeChat={chatId}
        view={view}
        collapsed={collapsed}
        drawer={drawer}
        onNewChat={newChat}
        onOpenChat={openChat}
        onSelectFolder={(id) => { setActiveId(id); newChat(); }}
        onFiles={(id) => { if (id) setActiveId(id); setView("files"); setDrawer(false); }}
        onMap={() => { setView("map"); setDrawer(false); }}
        onGraph={() => { setView("graph"); setDrawer(false); }}
        onNewFolder={newFolder}
        onDeleteFolder={deleteFolder}
        onDeleteChat={deleteChat}
        onSettings={() => { setView("settings"); setDrawer(false); }}
        onToggleCollapse={toggleCollapse}
        onCloseDrawer={() => setDrawer(false)}
      />

      <main className="main">
        {user.guest && <TrialBar credits={user.guest} />}
        <Topbar
          title={view === "files" ? (active?.name ?? "Files")
            : view === "settings" ? "Settings"
              : view === "map" ? "Study map"
                : view === "graph" ? "Chat graph"
              : openTitle ?? "New chat"}
          onMenu={() => setDrawer(true)}
          onNew={newChat}
        />

        {view === "files" && (
          <div className="scroll">
            {active
              ? <Files folderId={active.id} folderName={active.name} onChanged={refresh} />
              : (
                <div className="page">
                  <h2 className="page-h">Files</h2>
                  <p className="dim">No folders yet. Add a file from the chat and one is made for you.</p>
                  <button className="btn primary" style={{ marginTop: 16 }} onClick={newChat}>Go to chat</button>
                </div>
              )}
          </div>
        )}

        {view === "graph" && (
          <ChatGraph folders={folders} activeChat={chatId} onOpenChat={openChat} />
        )}

        {view === "map" && (
          <div className="scroll">
            <StudyMap
              folders={folders}
              folderId={activeId}
              onPickFolder={setActiveId}
              onStudied={() => { if (user.is_guest) loadUser(); }}
            />
          </div>
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
          <Chat
            key={chatKey}
            folders={folders}
            scopeFolderId={activeId}
            // Only a chat opened from the sidebar resumes. A new chat that has
            // just been saved keeps streaming in place instead of reloading.
            resumeId={chatKey.startsWith("new-") ? null : chatKey}
            onScopeChange={(id) => { setActiveId(id); loadFolders(); }}
            onConversationCreated={(id) => { setChatId(id); loadConversations(); }}
            onTurnDone={() => { loadConversations(); if (user.is_guest) loadUser(); }}
            onFilesChanged={() => { loadFolders(); loadStorage(); if (user.is_guest) loadUser(); }}
            onNewChat={newChat}
          />
        )}
      </main>

      <Modal spec={modal} onClose={() => setModal(null)} />
    </div>
  );
}

function TrialBar({ credits }: { credits: GuestCredits }) {
  const { uploads_left: docs, messages_left: qs } = credits;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <div className="trialbar" role="status">
      <span>
        Free trial: <strong>{plural(docs, "document", "documents")}</strong> and{" "}
        <strong>{plural(qs, "question", "questions")}</strong> left. Everything is deleted after 24 hours.
      </span>
      <a href="/api/v1/auth/google/login">Sign in with Google</a>
    </div>
  );
}
