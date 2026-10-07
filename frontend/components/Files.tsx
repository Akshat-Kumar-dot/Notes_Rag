"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { I } from "@/components/Icons";
import { Orb } from "@/components/Orb";
import { api, type FileRow } from "@/lib/api";

const LABEL: Record<FileRow["status"], string> = {
  pending: "Queued", parsing: "Processing", indexed: "Ready",
  partial: "Partial", failed: "Failed",
};

function statusLine(f: FileRow): string | null {
  if (f.status === "failed") return f.error ?? "Couldn't be processed.";
  if (f.status === "partial" && f.page_count && f.pages_with_text !== null) {
    const missing = f.page_count - f.pages_with_text;
    // Specific beats vague: "partial" alone tells the user nothing actionable.
    return `${missing} of ${f.page_count} pages had no readable text. Those pages aren't searchable.`;
  }
  // e.g. a free-trial document that was only partly indexed
  return f.error;
}

export function Files({ folderId, folderName, onChanged }: {
  folderId: string; folderName: string; onChanged: () => void;
}) {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setFiles(await api.files(folderId)); } catch { /* ignore */ }
  }, [folderId]);

  useEffect(() => { load(); }, [load]);

  // Parsing is asynchronous, so poll while anything is still in flight.
  useEffect(() => {
    const busy = files.some((f) => f.status === "pending" || f.status === "parsing");
    if (!busy) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [files, load]);

  async function send(list: FileList | null) {
    if (!list?.length) return;
    setError(null);
    setUploading(true);
    for (const file of Array.from(list)) {
      try { await api.upload(folderId, file); }
      catch (e) { setError(e instanceof Error ? e.message : "Upload failed."); }
    }
    setUploading(false);
    load();
    onChanged();
  }

  return (
    <div className="page">
      <h2 className="page-h">{folderName}</h2>
      {error && <p className="note err">{error}</p>}

      <div
        className="drop"
        data-over={over}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files); }}
        onClick={() => input.current?.click()}
        style={{ cursor: "pointer", marginBottom: 18 }}
      >
        {uploading ? (
          <Orb wait="reading" size={32} label="Uploading…" className="drop-wait" />
        ) : (
          <div style={{ display: "grid", placeItems: "center", gap: 8 }}>
            {I.upload}
            <div>Drop files here, or click to choose</div>
            <div style={{ fontSize: 11 }}>PDF, Word, text, Markdown, images — up to 20MB</div>
          </div>
        )}
        <input
          ref={input} type="file" multiple hidden
          accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
          onChange={(e) => { send(e.target.files); e.target.value = ""; }}
        />
      </div>

      {files.length === 0 && <p className="dim">No files in this folder yet.</p>}

      {files.map((f) => {
        const line = statusLine(f);
        return (
          <div key={f.id}>
            <div className="filerow">
              <span className="ico">{I.file}</span>
              <span className="grow trunc">
                <span className="t trunc">{f.original_filename}</span>
                <span className="s">
                  {f.chunk_count > 0 ? `${f.chunk_count} passages indexed` : "—"}
                </span>
              </span>
              {f.status === "pending" || f.status === "parsing"
                ? <Orb wait="reading" label={f.status === "pending" ? "Queued" : "Reading…"} className="file-wait" />
                : <span className="badge" data-s={f.status}>{LABEL[f.status]}</span>}
              <button
                className="dim"
                title="Delete"
                onClick={async () => { await api.deleteFile(f.id); load(); onChanged(); }}
              >
                {I.trash}
              </button>
            </div>
            {line && (
              <p className={`note ${f.status === "failed" ? "err" : "warn"}`} style={{ marginTop: -4 }}>
                {line}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
