"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Orb } from "@/components/Orb";
import { api, type ChatGraphData, type Folder } from "@/lib/api";

/** Muted per-folder colours: enough to tell courses apart, quiet enough to
 *  keep the app's grey, un-flashy look. */
const PALETTE = ["#6fbf8a", "#7aa7e0", "#d9a55a", "#c79be6", "#e0897a", "#62c2c2", "#c4c47c", "#9aa2ff"];
const LOOSE = "#6a6a72";   // chats whose folder was deleted

type N = {
  id: string; title: string; r: number; color: string; folder: string;
  msgs: number; passages: number;
  x: number; y: number; vx: number; vy: number; held: boolean;
};
type E = { a: N; b: N; w: number; passages: number; files: string[] };
type Tip = { node: N; x: number; y: number; links: number; files: string[] } | null;

/** Obsidian-style graph of the user's chats. A line joins two chats whose
 *  answers drew on the same passages (or files) of their notes. */
export function ChatGraph({ folders, activeChat, onOpenChat }: {
  folders: Folder[];
  activeChat: string | null;
  onOpenChat: (id: string) => void;
}) {
  const [data, setData] = useState<ChatGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Through refs, so a parent re-render doesn't restart the layout.
  const openRef = useRef(onOpenChat);
  openRef.current = onOpenChat;
  const activeRef = useRef(activeChat);
  activeRef.current = activeChat;

  const load = useCallback(async () => {
    try { setData(await api.chatGraph()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't load the graph."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const folderIndex = new Map(folders.map((f, i) => [f.id, i]));
  const folderName = new Map(folders.map((f) => [f.id, f.name]));

  useEffect(() => {
    const cv = canvas.current, box = wrap.current, ctx = cv?.getContext("2d");
    if (!cv || !box || !ctx || !data || data.nodes.length === 0) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---- build the graph, grouped by folder to start with ------------------
    const byId = new Map<string, N>();
    const groups = Math.max(1, folders.length);
    data.nodes.forEach((n) => {
      const home = n.folder_ids.find((id) => folderIndex.has(id));
      const gi = home ? folderIndex.get(home)! : groups;
      const angle = (gi / (groups + 1)) * Math.PI * 2;
      byId.set(n.id, {
        id: n.id, title: n.title, msgs: n.message_count, passages: n.passages,
        r: Math.max(4, Math.min(16, 4 + Math.sqrt(n.message_count) * 1.6)),
        color: home ? PALETTE[gi % PALETTE.length] : LOOSE,
        folder: home ? folderName.get(home) ?? "" : "Deleted folder",
        x: Math.cos(angle) * 160 + (Math.random() - 0.5) * 120,
        y: Math.sin(angle) * 160 + (Math.random() - 0.5) * 120,
        vx: 0, vy: 0, held: false,
      });
    });
    const nodes = [...byId.values()];
    const edges: E[] = data.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ a: byId.get(e.source)!, b: byId.get(e.target)!, w: e.weight, passages: e.passages, files: e.files }));
    const neighbours = new Map<N, Set<N>>(nodes.map((n) => [n, new Set()]));
    for (const e of edges) { neighbours.get(e.a)!.add(e.b); neighbours.get(e.b)!.add(e.a); }

    // ---- physics: repulsion, springs on links, a gentle pull to the centre --
    let alpha = 1;
    const tick = () => {
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const q = nodes[j];
          let dx = q.x - p.x, dy = q.y - p.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const f = Math.min(40, (1600 / d2)) * alpha;
          const d = Math.sqrt(d2);
          p.vx -= (dx / d) * f; p.vy -= (dy / d) * f;
          q.vx += (dx / d) * f; q.vy += (dy / d) * f;
        }
      }
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
        const d = Math.hypot(dx, dy) || 1;
        const rest = 55 + e.a.r + e.b.r;
        const f = (d - rest) * 0.02 * (0.5 + Math.min(1, e.w / 2)) * alpha;
        e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f;
        e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f;
      }
      for (const n of nodes) {
        n.vx -= n.x * 0.006 * alpha; n.vy -= n.y * 0.006 * alpha;
        if (n.held) { n.vx = n.vy = 0; continue; }
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
      }
      alpha *= 0.99;
    };
    if (still) { for (let i = 0; i < 400; i++) tick(); alpha = 0; }

    // ---- view: pan and zoom --------------------------------------------------
    const view = { x: 0, y: 0, k: 1 };
    let w = 0, h = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const b = box.getBoundingClientRect();
      w = b.width; h = b.height;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`; cv.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    const toScreen = (n: N) => [w / 2 + view.x + n.x * view.k, h / 2 + view.y + n.y * view.k];
    const toWorld = (sx: number, sy: number) => [(sx - w / 2 - view.x) / view.k, (sy - h / 2 - view.y) / view.k];

    let hovered: N | null = null;
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const near = hovered ? neighbours.get(hovered)! : null;
      const lit = (n: N) => !hovered || n === hovered || near!.has(n);

      for (const e of edges) {
        const on = hovered && (e.a === hovered || e.b === hovered);
        const [x1, y1] = toScreen(e.a), [x2, y2] = toScreen(e.b);
        ctx.strokeStyle = on ? "rgba(95,208,143,0.75)"
          : `rgba(255,255,255,${hovered ? 0.04 : 0.08 + 0.2 * Math.min(1, e.w / 2)})`;
        ctx.lineWidth = on ? 1.6 : 0.6 + Math.min(1.4, e.w * 0.35);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      for (const n of nodes) {
        const [x, y] = toScreen(n);
        const r = n.r * Math.sqrt(view.k);
        ctx.globalAlpha = lit(n) ? 1 : 0.22;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.color; ctx.fill();
        if (n.id === activeRef.current) {
          ctx.lineWidth = 2; ctx.strokeStyle = "#f5f5f5";
          ctx.beginPath(); ctx.arc(x, y, r + 3.5, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // Labels: the hovered chat and its neighbours, the open chat, and
      // everything once zoomed in far enough to read them.
      // canvas can't read CSS variables, so the font list is spelled out
      ctx.font = "12px -apple-system, 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "center";
      for (const n of nodes) {
        const show = view.k >= 1.35 || n.id === activeRef.current || (hovered && lit(n));
        if (!show) continue;
        const [x, y] = toScreen(n);
        const label = n.title.length > 34 ? `${n.title.slice(0, 33)}…` : n.title;
        ctx.fillStyle = hovered && !lit(n) ? "rgba(200,200,206,0.25)" : n === hovered ? "#f5f5f5" : "#b8b8be";
        ctx.fillText(label, x, y + n.r * Math.sqrt(view.k) + 15);
      }
    };

    let raf = 0;
    const loop = () => {
      raf = 0;
      if (alpha > 0.015) { tick(); raf = requestAnimationFrame(loop); }
      draw();
    };
    const heat = (to: number) => {
      if (still) { draw(); return; }
      alpha = Math.max(alpha, to);
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };

    // ---- pointer: hover, drag a chat, pan the canvas, click to open --------
    const hit = (sx: number, sy: number) => {
      const [x, y] = toWorld(sx, sy);
      let best: N | null = null, bestD = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < (n.r + 6) / Math.sqrt(view.k) && d < bestD) { best = n; bestD = d; }
      }
      return best;
    };
    const showTip = (n: N | null, sx = 0, sy = 0) => {
      if (!n) { setTip(null); return; }
      const links = edges.filter((e) => e.a === n || e.b === n);
      setTip({ node: n, x: sx, y: sy, links: links.length, files: [...new Set(links.flatMap((e) => e.files))].slice(0, 3) });
    };

    let drag: { node: N | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
    const local = (e: PointerEvent) => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };

    const onDown = (e: PointerEvent) => {
      const [sx, sy] = local(e);
      const node = hit(sx, sy);
      drag = { node, sx, sy, vx: view.x, vy: view.y, moved: false };
      if (node) node.held = true;
      cv.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const [sx, sy] = local(e);
      if (drag) {
        if (Math.hypot(sx - drag.sx, sy - drag.sy) > 4) drag.moved = true;
        if (drag.node) {
          const [x, y] = toWorld(sx, sy);
          drag.node.x = x; drag.node.y = y;
          showTip(null);
          heat(0.3);
        } else {
          view.x = drag.vx + sx - drag.sx; view.y = drag.vy + sy - drag.sy;
          redraw();
        }
        return;
      }
      const n = hit(sx, sy);
      if (n !== hovered) { hovered = n; cv.style.cursor = n ? "pointer" : "grab"; redraw(); }
      showTip(n, sx, sy);
    };
    const onUp = () => {
      if (drag?.node) {
        drag.node.held = false;
        if (!drag.moved) openRef.current(drag.node.id);
      }
      drag = null;
    };
    const onLeave = () => { if (!drag) { hovered = null; showTip(null); redraw(); } };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [sx, sy] = [e.offsetX, e.offsetY];
      const [wx, wy] = toWorld(sx, sy);
      view.k = Math.min(3, Math.max(0.3, view.k * Math.exp(-e.deltaY * 0.0015)));
      // keep the point under the cursor fixed while zooming
      view.x = sx - w / 2 - wx * view.k; view.y = sy - h / 2 - wy * view.k;
      redraw();
    };
    const onDbl = (e: MouseEvent) => {
      if (hit(e.offsetX, e.offsetY)) return;
      view.x = view.y = 0; view.k = 1; redraw();
    };

    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointerleave", onLeave);
    cv.addEventListener("wheel", onWheel, { passive: false });
    cv.addEventListener("dblclick", onDbl);
    cv.style.cursor = "grab";
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    resize();
    heat(1);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("pointerleave", onLeave);
      cv.removeEventListener("wheel", onWheel);
      cv.removeEventListener("dblclick", onDbl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, folders]);

  const legend = folders.filter((f) => data?.nodes.some((n) => n.folder_ids.includes(f.id)));
  const loose = data?.nodes.some((n) => !n.folder_ids.some((id) => folderIndex.has(id)));

  return (
    <div className="graph">
      <div className="graph-head">
        <div>
          <h2 className="page-h">Chat graph</h2>
          <p className="dim">Chats that drew on the same passages of your notes are linked. Click one to open it.</p>
        </div>
        {data && data.nodes.length > 0 && (
          <div className="graph-legend">
            {legend.map((f) => (
              <span key={f.id}><i style={{ background: PALETTE[folderIndex.get(f.id)! % PALETTE.length] }} />{f.name}</span>
            ))}
            {loose && <span><i style={{ background: LOOSE }} />Deleted folder</span>}
          </div>
        )}
      </div>

      {error && <p className="note err">{error}</p>}
      {!data && !error && <Orb wait="reading" size={32} label="Connecting your chats…" className="map-wait" />}
      {data && data.nodes.length < 2 && (
        <div className="panel graph-empty">
          <p className="dim">Ask a few questions and your chats will connect here, wherever their answers use the same parts of your notes.</p>
        </div>
      )}

      {data && data.nodes.length >= 2 && (
        <>
          <div className="graph-canvas" ref={wrap}>
            <canvas ref={canvas} role="img"
              aria-label={`Graph of ${data.nodes.length} chats with ${data.edges.length} links`} />
            {tip && (
              <div className="graph-tip" style={{ left: tip.x, top: tip.y }}>
                <b>{tip.node.title}</b>
                <span>{tip.node.folder} · {tip.node.msgs} {tip.node.msgs === 1 ? "message" : "messages"}</span>
                <span>
                  {tip.links === 0 ? "Not linked yet"
                    : `Linked to ${tip.links} ${tip.links === 1 ? "chat" : "chats"}${tip.files.length ? ` via ${tip.files.join(", ")}` : ""}`}
                </span>
              </div>
            )}
          </div>
          <p className="dim graph-hint">
            {data.edges.length === 0
              ? "None of your chats share sources yet. Links appear as answers draw on the same passages."
              : "Drag to move · scroll to zoom · double-click empty space to reset"}
          </p>
        </>
      )}
    </div>
  );
}
