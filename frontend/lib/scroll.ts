"use client";

import { useEffect, useRef } from "react";

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** 0 before a, 1 after b, smooth in between. */
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Reports how far the page has scrolled through a tall "pinned" section:
 *  0 when its top reaches the top of the screen, 1 when its bottom reaches the
 *  bottom. Runs only while the section is near the screen, and calls back only
 *  when the value changes, so idle sections cost nothing.
 *
 *  Reads the layout every frame instead of listening for scroll events: with
 *  Lenis smoothing the scroll, the position keeps moving after the wheel stops. */
export function useScrollProgress(onProgress: (p: number) => void) {
  const ref = useRef<HTMLElement>(null);
  const cb = useRef(onProgress);
  cb.current = onProgress;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0, last = -1, near = false;
    const tick = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const travel = r.height - window.innerHeight;
      const p = travel > 0 ? clamp01(-r.top / travel) : 0;
      if (Math.abs(p - last) > 0.0002) { last = p; cb.current(p); }
      if (near) raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      near = e.isIntersecting;
      if (near && !raf) raf = requestAnimationFrame(tick);
    }, { rootMargin: "200px 0px" });
    io.observe(el);
    tick();   // right state on first paint, wherever the page was reloaded
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  return ref;
}

/** prefers-reduced-motion, read once on the client. */
export function prefersStill(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
