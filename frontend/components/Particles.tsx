"use client";

import { useEffect, useRef } from "react";

/** Floating dots. They drift slowly upward (a nod to "antigravity") and part
 *  around the pointer.
 *
 *    hero   behind the landing hero, on black: pale dots that, near the
 *           pointer, link up into a small constellation, the same idea as the
 *           "connecting" orb.
 *    motes  on the white page-stack section (after lenis.dev's drifting dots):
 *           fewer, green, some soft and out of focus, each fading in and out
 *           on its own slow beat.
 *
 *  Plain 2D canvas, DPR capped at 2, paused while offscreen or in a background
 *  tab, and not started at all under prefers-reduced-motion. */
export function Particles({ className, variant = "hero" }: { className?: string; variant?: "hero" | "motes" }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    type P = {
      x: number; y: number; vx: number; vy: number; r: number; a: number;
      green: boolean; soft: boolean; beat: number; phase: number;
    };
    const motes = variant === "motes";
    let w = 0, h = 0, dots: P[] = [];
    const pointer = { x: -9999, y: -9999 };
    let raf = 0, visible = true;

    const seed = () => {
      const n = motes ? Math.min(120, Math.round((w * h) / 11000)) : Math.min(170, Math.round((w * h) / 8500));
      dots = Array.from({ length: n }, () => {
        const soft = motes && Math.random() < 0.18;
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * (motes ? 0.08 : 0.12),
          vy: motes ? -(0.03 + Math.random() * 0.12) : -(0.05 + Math.random() * 0.22),   // upward: anti-gravity
          r: soft ? 4 + Math.random() * 6 : motes ? 1 + Math.random() * 1.6 : 0.6 + Math.random() * 1.3,
          a: soft ? 0.12 + Math.random() * 0.12 : motes ? 0.4 + Math.random() * 0.45 : 0.12 + Math.random() * 0.4,
          green: motes || Math.random() < 0.12,
          soft, beat: 0.4 + Math.random() * 0.9, phase: Math.random() * Math.PI * 2,
        };
      });
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const box = canvas.getBoundingClientRect();
      w = box.width; h = box.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const REPEL = 130, LINK = 170;
    const frame = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      ctx.clearRect(0, 0, w, h);
      const time = now / 1000;
      const near: P[] = [];
      for (const d of dots) {
        const dx = d.x - pointer.x, dy = d.y - pointer.y;
        const dist = Math.hypot(dx, dy);
        if (dist < REPEL && dist > 0.1) {
          // push away from the pointer, strongest up close
          const f = (1 - dist / REPEL) * 0.9;
          d.x += (dx / dist) * f;
          d.y += (dy / dist) * f;
        }
        if (!motes && dist < LINK) near.push(d);
        d.x += d.vx; d.y += d.vy;
        if (d.y < -4) { d.y = h + 4; d.x = Math.random() * w; }
        if (d.x < -4) d.x = w + 4; else if (d.x > w + 4) d.x = -4;

        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        if (motes) {
          const a = d.a * (0.5 + 0.5 * Math.sin(time * d.beat + d.phase));
          if (d.soft) {   // out of focus: a blur rather than a dot
            const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r);
            g.addColorStop(0, `rgba(47,174,102,${a})`);
            g.addColorStop(1, "rgba(47,174,102,0)");
            ctx.fillStyle = g;
          } else {
            ctx.fillStyle = `rgba(47,174,102,${a})`;
          }
        } else {
          ctx.fillStyle = d.green ? `rgba(95,208,143,${d.a + 0.15})` : `rgba(235,235,240,${d.a})`;
        }
        ctx.fill();
      }
      // a faint web between dots close to the pointer (the hero only)
      ctx.lineWidth = 0.6;
      for (let i = 0; i < near.length; i++) {
        for (let j = i + 1; j < near.length; j++) {
          const a = near[i], b = near[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 70) {
            ctx.strokeStyle = `rgba(95,208,143,${0.22 * (1 - d / 70)})`;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame); };

    const onMove = (e: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      pointer.x = e.clientX - box.left;
      pointer.y = e.clientY - box.top;
    };
    const onLeave = () => { pointer.x = pointer.y = -9999; };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; start(); });
    io.observe(canvas);
    const host = canvas.parentElement ?? canvas;
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", start);
    start();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", start);
    };
  }, [variant]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
