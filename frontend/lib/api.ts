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

export interface GuestCredits { uploads_left: number; messages_left: number; expires_at: string; }
export interface User {
  id: string; email: string | null; display_name: string | null; avatar_url: string | null;
  is_guest: boolean; guest: GuestCredits | null;
}
export interface Folder { id: string; name: string; created_at: string; file_count: number; size_bytes: number; }
export interface Storage { used_bytes: number; limit_bytes: number; file_count: number; folder_count: number; }
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
export interface Citation {
  rank: number; score: number | null; excerpt_snapshot: string;
  source_label: string; chunk_id: string | null;
}
export interface Message {
  id: string; role: "user" | "assistant"; content: string;
  low_confidence: boolean; created_at: string; citations: Citation[];
}

export const api = {
  me: () => req<User>("/auth/me"),
  /** Not via req(): a refusal here is a message for the landing page, not a
   *  reason to redirect to it. */
  startGuest: async (fingerprint: string): Promise<User> => {
    const res = await fetch(BASE + "/auth/guest", { credentials: "include", ...json({ fingerprint }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail ?? "Couldn't start a free trial.");
    return body;
  },
  logout: () => req<void>("/auth/logout", { method: "POST" }),

  storage: () => req<Storage>("/storage"),

  folders: () => req<Folder[]>("/folders"),
  renameFolder: (id: string, name: string) =>
    req<Folder>(`/folders/${id}`, { ...json({ name }), method: "PATCH" }),
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
  chatGraph: () => req<ChatGraphData>("/conversations/graph"),
  createConversation: (folderIds: string[]) =>
    req<Conversation>("/conversations", json({ folder_ids: folderIds })),
  conversation: (id: string) => req<Conversation & { messages: Message[] }>(`/conversations/${id}`),
  deleteConversation: (id: string) => req<void>(`/conversations/${id}`, { method: "DELETE" }),
};

// --- chat graph ---
export interface GraphNode {
  id: string; title: string; folder_ids: string[];
  message_count: number; updated_at: string; passages: number;
}
export interface GraphEdge {
  source: string; target: string; weight: number; passages: number; files: string[];
}
export interface ChatGraphData { nodes: GraphNode[]; edges: GraphEdge[]; }

// --- study map ---
export interface MapFile {
  id: string; name: string; status: FileRow["status"];
  /** Per passage, in reading order: strength, or -1 if never studied. */
  cells: number[];
  /** Whole days since last studied, or -1. */
  ages: number[];
  pages: (number | null)[];
  ordinals: number[];
}
export interface StudyMapData {
  folder_id: string; folder_name: string;
  total: number; studied: number; fading: number;
  /** Strength at and above which a passage counts as fresh. */
  lit: number;
  files: MapFile[];
}
export interface Passage { n: number; ordinal: number; label: string; excerpt: string | null; }
export interface StudyOut {
  mode: "teach" | "quiz"; text: string | null;
  quiz_id: string | null; question: string | null; passages: Passage[];
}
export interface QuizResult {
  score: number; verdict: "correct" | "partial" | "wrong";
  feedback: string; missed: string[]; points: string[]; passages: Passage[];
}

export const study = {
  map: (folderId: string) => req<StudyMapData>(`/folders/${folderId}/map`),
  start: (folderId: string, fileId: string, start: number, mode: "teach" | "quiz") =>
    req<StudyOut>(`/folders/${folderId}/study`, json({ file_id: fileId, start, mode })),
  answer: (quizId: string, answer: string) =>
    req<QuizResult>(`/quizzes/${quizId}/answer`, json({ answer })),
};

export type ConversationDetail = Conversation & { messages: Message[] };

/** Opened chats, kept in memory for this tab. Clicking one that was opened (or
 *  hovered, which prefetches) before renders at once, then refreshes quietly. */
const chatCache = new Map<string, ConversationDetail>();
const chatInflight = new Map<string, Promise<ConversationDetail>>();

export const chats = {
  cached: (id: string) => chatCache.get(id),
  load(id: string): Promise<ConversationDetail> {
    const pending = chatInflight.get(id);
    if (pending) return pending;
    const p = api.conversation(id)
      .then((c) => { chatCache.set(id, c); return c; })
      .finally(() => chatInflight.delete(id));
    chatInflight.set(id, p);
    return p;
  },
  prefetch(id: string) {
    if (!chatCache.has(id)) chats.load(id).catch(() => {});
  },
  /** After a new turn or a delete, the cached copy is stale. */
  forget: (id: string) => { chatCache.delete(id); },
};

export interface StreamHandlers {
  onSources: (s: Source[], lowConfidence: boolean) => void;
  onToken: (delta: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  /** e.g. "reconnecting" while the server retries a busy model. */
  onStatus?: (state: string) => void;
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
    // Out-of-credit guests get a 403 whose detail says what to do next.
    const body = await res.json().catch(() => ({}));
    h.onError(body.detail ?? (res.status === 401 ? "Your session expired." : "The server rejected that."));
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
      else if (event === "status") h.onStatus?.(String(p.state ?? ""));
    }
  }
}
