"use client";

import { useCallback, useEffect, useState } from "react";
import { I } from "@/components/Icons";
import type { ModalSpec } from "@/components/Modal";
import { api, type Conversation } from "@/lib/api";

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  if (mins < 10080) return `${Math.round(mins / 1440)}d ago`;
  return d.toLocaleDateString();
};

export function History({
  onOpen, onConfirm,
}: {
  onOpen: (id: string) => void;
  onConfirm: (spec: ModalSpec) => void;
}) {
  const [rows, setRows] = useState<Conversation[] | null>(null);

  const load = useCallback(async () => {
    try { setRows(await api.conversations()); } catch { setRows([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function remove(c: Conversation) {
    onConfirm({
      title: "Delete conversation?",
      description: `"${c.title}" and its saved answers will be removed. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        await api.deleteConversation(c.id);
        setRows((p) => (p ?? []).filter((x) => x.id !== c.id));
      },
    });
  }

  if (rows === null) return <div className="page"><p className="dim">Loading…</p></div>;

  return (
    <div className="page">
      <h2 className="page-h">Chat History</h2>
      {rows.length === 0 && <p className="dim">No conversations yet. Ask something to start one.</p>}
      {rows.map((c) => (
        <div key={c.id} className="filerow">
          <span className="ico">{I.chat}</span>
          <button className="grow trunc linkrow" onClick={() => onOpen(c.id)} title={c.title}>
            <span className="t trunc">{c.title}</span>
            <span className="s">{when(c.updated_at)}</span>
          </button>
          <button className="dim" title="Delete conversation"
            aria-label={`Delete conversation ${c.title}`} onClick={() => remove(c)}>
            {I.trash}
          </button>
        </div>
      ))}
    </div>
  );
}
