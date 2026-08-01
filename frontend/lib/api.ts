const BASE = "/api/v1";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { credentials: "include", ...init });
  if (res.status === 401) {
    window.location.replace("/");
    throw new Error("unauthorised");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? "Something went wrong.");
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export interface User { id: string; email: string | null; display_name: string | null; avatar_url: string | null; }
export interface Folder { id: string; name: string; created_at: string; file_count: number; }
export interface FileRow {
  id: string; folder_id: string; original_filename: string; size_bytes: number;
  status: "pending" | "parsing" | "indexed" | "partial" | "failed";
  error: string | null; page_count: number | null; pages_with_text: number | null;
  coverage: number | null; chunk_count: number;
}
export interface Source {
  n: number; chunk_id: string; file_id: string; filename: string; folder_name: string;
  page_number: number | null; heading: string | null; excerpt: string; score: number;
}
export interface Conversation { id: string; title: string; folder_ids: string[]; updated_at: string; }

export const api = {
  me: () => req<User>("/auth/me"),
  logout: () => req<void>("/auth/logout", { method: "POST" }),

  folders: () => req<Folder[]>("/folders"),
  createFolder: (name: string) => req<Folder>("/folders", json({ name })),
  deleteFolder: (id: string) => req<void>(`/folders/${id}`, { method: "DELETE" }),

  files: (folderId: string) => req<FileRow[]>(`/folders/${folderId}/files`),
  file: (id: string) => req<FileRow>(`/files/${id}`),
  deleteFile: (id: string) => req<void>(`/files/${id}`, { method: "DELETE" }),
  upload: (folderId: string, file: File) => {
    const fd = new FormData();
    fd.append("upload", file);
    return req<FileRow>(`/folders/${folderId}/files`, { method: "POST", body: fd });
  },

  search: (q: string, folderIds: string[]) => {
    const p = new URLSearchParams({ q });
    folderIds.forEach((f) => p.append("folder_ids", f));
    return req<{ results: Source[]; low_confidence: boolean; elapsed_ms: number }>(
      `/search?${p}`,
    );
  },

  conversations: () => req<Conversation[]>("/conversations"),
  createConversation: (folderIds: string[]) =>
    req<Conversation>("/conversations", json({ folder_ids: folderIds })),
  conversation: (id: string) => req<Conversation & { messages: unknown[] }>(`/conversations/${id}`),
};

export interface StreamHandlers {
  onSources: (s: Source[], lowConfidence: boolean) => void;
  onToken: (delta: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/** SSE over POST. EventSource is GET-only and the question can be long. */
export async function streamMessage(
  conversationId: string,
  message: string,
  h: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal,
    });
  } catch {
    h.onError("Couldn't reach the server.");
    return;
  }
  if (!res.ok || !res.body) {
    h.onError(res.status === 401 ? "Your session expired." : "The server rejected that.");
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // Events are blank-line separated; a network chunk can split one in half.
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";

    for (const frame of frames) {
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (!data.length) continue;
      let p: Record<string, unknown>;
      try { p = JSON.parse(data.join("\n")); } catch { continue; }

      if (event === "sources") h.onSources(p.chunks as Source[], Boolean(p.low_confidence));
      else if (event === "token") h.onToken(String(p.delta ?? ""));
      else if (event === "done") h.onDone();
      else if (event === "error") h.onError(String(p.message ?? "Something went wrong."));
    }
  }
}
