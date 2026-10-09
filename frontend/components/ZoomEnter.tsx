"use client";

import { useEffect, useRef } from "react";
import { prefersStill, smooth, useScrollProgress } from "@/lib/scroll";

/** Scroll progress through the zoom at which the screen is white from edge to
 *  edge (the top bar turns its text dark from here, see app/page.tsx). */
export const ZOOM_WHITE = 0.8;

/** "Enter notesrag." -- a pinned section where scrolling zooms into the full
 *  stop until it fills the screen with white. (After lenis.dev's "Enter
 *  Lenis".) The page stack follows, its first sheet rising from below
 *  (components/NoteStack.tsx).
 *
 *  The letters only grow while they're still on screen, then fade. The white
 *  that floods the screen is a circle clipped over the full stop, drawn sharp
 *  at every size: scaling the text itself all the way (260x) blurred it, since
 *  the browser stretches its first drawing, and made a layer too big to move
 *  smoothly.
 *
 *  Everything is driven by writing styles straight to elements: re-rendering
 *  React sixty times a second for a scroll effect would be wasteful. */
export function ZoomEnter() {
  const pin = useRef<HTMLDivElement>(null);
  const lines = useRef<HTMLDivElement>(null);
  const low = useRef<HTMLDivElement>(null);
  const word = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  const flood = useRef<HTMLDivElement>(null);
  const spot = useRef({ x: 0, y: 0, r: 0 });   // the full stop at rest: centre and radius in the pin

  // Zoom around the dot's centre: measured untransformed, again on resize and
  // once the web font has loaded (it changes the word's width).
  useEffect(() => {
    const measure = () => {
      const w = word.current, d = dot.current, box = pin.current;
      if (!w || !d || !box) return;
      const prev = w.style.transform;
      w.style.transform = "none";
      const wr = w.getBoundingClientRect(), dr = d.getBoundingClientRect(), br = box.getBoundingClientRect();
      w.style.transform = prev;
      w.style.transformOrigin =
        `${dr.left - wr.left + dr.width / 2}px ${dr.top - wr.top + dr.height / 2}px`;
      spot.current = { x: dr.left - br.left + dr.width / 2, y: dr.top - br.top + dr.height / 2, r: dr.width / 2 };
    };
    measure();
    window.addEventListener("resize", measure);
    document.fonts?.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const ref = useScrollProgress((p) => {
    if (prefersStill()) p = 1;
    const out = smooth(0.06, 0.3, p);                 // the other lines leave,
    lines.current!.style.opacity = String(1 - out);   // up and down out of the way
    lines.current!.style.transform = `translateY(${-30 * out}px)`;
    low.current!.style.opacity = String(1 - out);
    low.current!.style.transform = `translateY(${30 * out}px)`;

    const z = smooth(0.27, 0.97, p);                  // then the zoom: slow start,
    const scale = Math.pow(260, z * z);               // rushing finish
    const w = word.current!;
    w.style.transform = `scale(${Math.min(scale, 50)})`;
    w.style.opacity = String(1 - smooth(16, 40, scale));   // the letters fly past, then go
    w.style.visibility = scale > 40 ? "hidden" : "visible";

    // the full stop turns white as the zoom begins, then grows over everything
    const { x, y, r } = spot.current;
    const f = flood.current!, white = smooth(0.27, 0.37, p);
    f.style.opacity = String(white);
    f.style.clipPath = `circle(${(r * scale + 1).toFixed(1)}px at ${x.toFixed(1)}px ${y.toFixed(1)}px)`;
    dot.current!.style.opacity = String(1 - white);   // no green rim round the white
  });

  return (
    <section className="zoom" ref={ref} aria-label="What Notes Rag is">
      <div className="zoom-pin" ref={pin}>
        <div className="zoom-lines" ref={lines} aria-hidden="true">
          <span>So we built</span>
          <span>studying</span>
        </div>
        <div className="zoom-word" ref={word}>
          <span className="zoom-enter">Enter</span>
          <span className="zoom-mark"><b>notes</b>rag<span className="zoom-dot" ref={dot} /></span>
        </div>
        <div className="zoom-lines low" ref={low} aria-hidden="true">
          <span>that shows its work</span>
        </div>
        <div className="zoom-flood" ref={flood} />
      </div>
    </section>
  );
}
