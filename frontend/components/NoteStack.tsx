"use client";

import { useEffect, useRef } from "react";
import type { BufferAttribute, PlaneGeometry, WebGLRenderer } from "three";
import { Particles } from "@/components/Particles";
import { clamp01, lerp, prefersStill, smooth } from "@/lib/scroll";

/** "Notes Rag brings the receipts": a stack of chrome pages that turns as you
 *  scroll while numbered cards cascade in beside it (after the hand in
 *  lenis.dev's "brings the heat"). Over the first half the pages tell the
 *  story in four phases:
 *
 *    0. one sheet floats                  -> you upload a note
 *    1. more pages unfold into a stack    -> every page is read and indexed
 *    2. they scatter, passages light up   -> search finds the exact passages
 *    3. they settle, the answer on top    -> every sentence linked to its source
 *
 *  then the stack keeps turning while the feature cards come in, and at the
 *  very end the cards leave and big type takes over: the last screen of the
 *  page, with the button and the links.
 *
 *  Even at rest no page is still: each keeps its place while its corners drift
 *  up and down, like paper floating in air.
 *
 *  three.js (~160 kB) is fetched once the page is idle, so the hero never waits
 *  for it. Without WebGL the cards still tell the story. */

const N = 14;
const ANSWER = 0;                 // floats alone first, ends on top as the answer
const SOURCES = [3, 7, 11];       // the pages holding the passages that answer
const TURN = (Math.PI * 2) / 3;   // the stack turns a third of the way per phase
const W = 3.4, D = 2.6;           // a page, in scene units
const GAP = 0.29;                 // between pages in the stack
const SEG_X = 44, SEG_Z = 32;

const STEPS = [
  { title: "One note", text: "Upload a PDF, a Word file or your own notes. No set-up first." },
  { title: "Every page", text: "Every page is read and indexed, by meaning and by exact words." },
  { title: "The right passages", text: "Ask in plain language. The exact passages that answer it light up." },
  { title: "A cited answer", text: "They become one answer, every sentence linked to its source." },
  // the features, while the stack keeps turning
  { title: "Study map", text: "Every passage of your notes: lit where you've studied, dark where you haven't." },
  { title: "Teach me, quiz me", text: "Pick a dark spot to get it explained, or answer a question marked against your notes." },
  { title: "Chats that connect", text: "The Chat graph links conversations that drew on the same passages." },
  { title: "Says when it doesn't know", text: "If your files don't cover a question, the answer says so instead of inventing one." },
];

// Scroll progress through the section: the four phases play out by STORY,
// the feature cards come in from FEATURES, and the last screen takes over at END.
const STORY = 0.5, FEATURES = 0.54, FEATURE_STEP = 0.065, END = 0.86;
// Before all that, the first sheet rises in and floats alone (with a few words
// beside it) for this many screen heights of scrolling, before the cards come.
const INTRO = 0.6;

/** Seeded random, so the pages fall the same way on every visit. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How a page bends: an S-wave along its length, a twist, a cup, curled ends,
 *  and four corners that drift up and down. Neighbouring pages get nearly the
 *  same shape, and the corners ripple down the stack one page after another,
 *  so the pages nest close like a real stack instead of cutting through each other. */
type Shape = {
  amp: number; k: number; ph: number; twist: number; cup: number; flickR: number; flickL: number;
  drift: number; ca: number[]; cs: number[]; cp: number[];
};
const SHAPES: Shape[] = Array.from({ length: N }, (_, i) => ({
  amp: 0.17 + 0.06 * Math.sin(i * 0.7 + 0.3), k: 1.5 + 0.3 * Math.sin(i * 0.45 + 1), ph: 0.4 + i * 0.3,
  twist: 0.5 * Math.sin(i * 0.3 + 2), cup: 0.22 * Math.sin(i * 0.35 + 1),
  flickR: 0.3 * Math.sin(i * 0.4 + 0.5), flickL: 0.28 * Math.cos(i * 0.35), drift: 0.45,
  ca: [0.11, 0.1, 0.12, 0.09], cs: [0.8, 0.95, 0.7, 1.05], cp: [0, 1.7, 3.4, 5.1].map((c) => c + i * 0.45),
}));

type Pose = { x: number; y: number; z: number; rx: number; ry: number; rz: number; s: number; o: number; bend: number };

/** Turn the nearest way round: an angle equal to `a`, within half a turn of `ref`. */
const nearest = (a: number, ref: number) => ref + Math.atan2(Math.sin(a - ref), Math.cos(a - ref));
/** A spot in the room -> the same spot inside the stack when it has turned by `yaw`. */
const inside = (x: number, z: number, yaw: number): [number, number] =>
  [x * Math.cos(yaw) - z * Math.sin(yaw), x * Math.sin(yaw) + z * Math.cos(yaw)];

/** Where every page is at each of the four phases. Phases 2 and 3 are laid out
 *  as seen from the camera, then turned back by however far the stack will have
 *  turned by then, so the lit pages face you when they light up. */
function buildPoses(): Pose[][] {
  const r = rng(7);
  const alone: Pose = { x: 0, y: 0.25, z: 0, rx: 0.5, ry: -0.3, rz: 0.16, s: 1.35, o: 1, bend: 1.2 };
  // the others wait inside the first page, unseen, and unfold out of it
  const first = Array.from({ length: N }, (_, i) =>
    i === ANSWER ? alone : { ...alone, y: alone.y - 0.012 * i, s: 1.15, o: 0 });

  // a tall stack, the pages nested close, fanning slowly round on the way down
  const top = ((N - 1) * GAP) / 2;
  const stack = Array.from({ length: N }, (_, i) => ({
    x: 0.16 * Math.sin(i * 0.9), y: top - i * GAP, z: 0.14 * Math.cos(i * 0.7),
    rx: 0.05 * Math.sin(i * 1.3), ry: 0.4 * Math.sin(i * 0.45) + i * 0.05, rz: 0.06 * Math.cos(i * 1.1),
    s: 1, o: 1, bend: 0.7,
  }));

  // scattered, as seen from the camera; the lit pages float in front, tilted to you
  const LIT = [[-1.9, 1.1, 0.8, 0.6, 0.35, 0.18], [1.9, 0.2, 0.9, 0.55, -0.4, -0.16], [-0.2, -1.4, 1.1, 0.62, 0.15, 0.1]];
  let n = 0;
  const around = () => {   // the rest spread round and behind them
    const a = n * 2.39996 + 0.6, rr = 2.3 + 0.7 * r(), y = -2.0 + 4.0 * ((n * 0.618 + 0.3) % 1);
    n++;
    return [Math.cos(a) * rr * 1.25, y, Math.sin(a) * rr * 0.8 - 0.7,
      (r() - 0.5) * 1.6, r() * Math.PI * 2, (r() - 0.5) * 1.4];
  };
  const yaw2 = 2 * TURN;
  const scatter = Array.from({ length: N }, (_, i) => {
    const l = SOURCES.indexOf(i);
    const [x, y, z, rx, ry, rz] = l >= 0 ? LIT[l] : around();
    const [lx, lz] = inside(x, z, yaw2);
    return { x: lx, y, z: lz, rx, ry: nearest(ry - yaw2, stack[i].ry), rz,
      s: l >= 0 ? 0.8 : 0.74, o: 1, bend: l >= 0 ? 0.7 : 0.9 };
  });

  // the same stack gathered tight and tidy -- in the same order, so the pages
  // still nest -- with the answer lifted off the top and tilted to you
  const yaw3 = 3 * TURN;
  const answer = Array.from({ length: N }, (_, i) => {
    const onTop = i === ANSWER, yaw = 0.15 * Math.sin(i * 0.45) + i * 0.02;
    const [lx, lz] = inside(onTop ? 0 : 0.06 * Math.sin(i * 0.9), onTop ? 0.2 : 0.05 * Math.cos(i * 0.7), yaw3);
    return { x: lx, y: onTop ? 1.3 : 1.0 - i * 0.2, z: lz,
      rx: onTop ? 0.35 : 0.03 * Math.sin(i * 1.3),
      ry: nearest((onTop ? -0.1 : yaw) - yaw3, scatter[i].ry),
      rz: onTop ? 0 : 0.04 * Math.cos(i * 1.1), s: 1, o: 1, bend: onTop ? 0.45 : 0.7 };
  });

  return Array.from({ length: N }, (_, i) => [first[i], stack[i], scatter[i], answer[i]]);
}
const POSES = buildPoses();

// The glowing lines, as [x, y, width] fractions of the page.
const ANSWER_LINES = [0.72, 0.66, 0.7, 0.58, 0.68, 0.62, 0.4].map((w, j) => [0.14, 0.22 + j * 0.085, w]);
const SOURCE_LINES = [
  [[0.12, 0.2, 0.5], [0.12, 0.28, 0.44], [0.12, 0.36, 0.48]],
  [[0.3, 0.46, 0.52], [0.3, 0.54, 0.46], [0.3, 0.62, 0.5], [0.3, 0.7, 0.3]],
  [[0.14, 0.6, 0.56], [0.14, 0.68, 0.5], [0.14, 0.76, 0.36]],
];

type Three = typeof import("three");
type Scene = {
  draw(t: number, enter: number, spin: number, time: number): void; resize(): void; warm(): void; dispose(): void;
};

/** The room the chrome reflects, painted as a panorama: a grey sky, a darker
 *  floor, white light strips, and dark flags standing all round the set (the
 *  stack turns, so every side gets seen). Mirror metal shows nothing but its
 *  surroundings, so the look is all in here: a pale room made the pages read
 *  as white paper; the dark bands are what make them read as chrome. */
function studio(T: Three) {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 512;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, c.height);
  sky.addColorStop(0, "#e4e4e7");
  sky.addColorStop(0.18, "#c4c4c8");
  sky.addColorStop(0.34, "#9b9ba0");
  sky.addColorStop(0.46, "#75757a");
  sky.addColorStop(0.52, "#58585d");
  sky.addColorStop(0.62, "#424246");
  sky.addColorStop(1, "#333337");
  g.fillStyle = sky;
  g.fillRect(0, 0, c.width, c.height);
  g.filter = "blur(20px)";
  g.fillStyle = "#26262a";
  for (const [x, y, w, h] of [[70, 40, 60, 240], [300, 20, 80, 260], [520, 70, 50, 220], [700, 30, 70, 250], [900, 50, 60, 230]]) {
    g.fillRect(x, y, w, h);
  }
  g.fillStyle = "#ffffff";
  for (const [x, y, w, h] of [[150, 60, 110, 30], [400, 110, 36, 130], [600, 40, 80, 24], [800, 90, 40, 140], [960, 120, 50, 20], [180, 170, 90, 14]]) {
    g.fillRect(x, y, w, h);
  }
  g.filter = "none";
  const tex = new T.CanvasTexture(c);
  tex.mapping = T.EquirectangularReflectionMapping;
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

function createScene(T: Three, box: HTMLElement): Scene | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    return null;   // no WebGL: the cards alone tell the story
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  box.appendChild(renderer.domElement);

  // chrome is all reflection: a studio for it to reflect
  const scene = new T.Scene();
  const pmrem = new T.PMREMGenerator(renderer);
  const panorama = studio(T);
  const env = pmrem.fromEquirectangular(panorama).texture;
  scene.environment = env;
  panorama.dispose();
  pmrem.dispose();

  const camera = new T.PerspectiveCamera(28, 1, 0.1, 200);
  const group = new T.Group();
  scene.add(group);

  const textures: { dispose(): void }[] = [];
  /** The passage lines on a page: `glow` paints the light (emissive), otherwise
   *  the grooves -- darker metal, so the page reads as a note before it lights
   *  up, and the green isn't washed out by the chrome after. */
  const lines = (rows: number[][], glow: boolean) => {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 392;
    const g = c.getContext("2d")!;
    g.fillStyle = glow ? "#000" : "#fff";
    g.fillRect(0, 0, c.width, c.height);
    if (glow) { g.fillStyle = "#3dff95"; g.shadowColor = "#19c964"; g.shadowBlur = 24; }
    else { g.fillStyle = "#707070"; g.shadowColor = "#707070"; g.shadowBlur = 6; }
    for (const [x, y, w] of rows) {
      for (let k = 0; k < (glow ? 2 : 1); k++) {   // twice, for a stronger halo
        g.beginPath();
        if (g.roundRect) g.roundRect(x * c.width, y * c.height, w * c.width, 11, 5.5);
        else g.rect(x * c.width, y * c.height, w * c.width, 11);
        g.fill();
      }
    }
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    textures.push(tex);
    return tex;
  };

  const pages = Array.from({ length: N }, (_, i) => {
    const geo: PlaneGeometry = new T.PlaneGeometry(W, D, SEG_X, SEG_Z);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as BufferAttribute;
    const uv = new Float32Array(pos.count * 2);   // -1..1 across and along the page
    for (let j = 0; j < pos.count; j++) {
      uv[2 * j] = pos.getX(j) / (W / 2);
      uv[2 * j + 1] = pos.getZ(j) / (D / 2);
    }
    const rows = i === ANSWER ? ANSWER_LINES : SOURCES.includes(i) ? SOURCE_LINES[SOURCES.indexOf(i)] : null;
    const mat = new T.MeshStandardMaterial({
      color: 0xffffff, metalness: 1, roughness: 0.15, side: T.DoubleSide, transparent: true,
      map: rows ? lines(rows, false) : null,
      emissive: rows ? 0xffffff : 0x000000, emissiveMap: rows ? lines(rows, true) : null, emissiveIntensity: 0,
    });
    const mesh = new T.Mesh(geo, mat);
    mesh.rotation.order = "YXZ";   // turn, then tilt
    mesh.frustumCulled = false;    // it bends every frame; its bounds never catch up
    group.add(mesh);
    return { mesh, mat, geo, pos, uv };
  });

  // a soft shadow on the floor, far below
  const sc = document.createElement("canvas");
  sc.width = sc.height = 128;
  const sg = sc.getContext("2d")!;
  const grad = sg.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.5)");
  grad.addColorStop(0.5, "rgba(0,0,0,0.16)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  sg.fillStyle = grad; sg.fillRect(0, 0, 128, 128);
  const shadowTex = new T.CanvasTexture(sc);
  textures.push(shadowTex);
  const shadowMat = new T.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false });
  const shadow = new T.Mesh(new T.PlaneGeometry(6, 6), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -3.1;
  shadow.renderOrder = -1;
  scene.add(shadow);
  const SHADOW = [[0.9, 0.22], [1.25, 0.34], [1.7, 0.16], [1.15, 0.34]];   // [size, opacity] per phase

  /** Bend one page: its shape, scaled by `bend`, plus the drifting corners. */
  const bendPage = (i: number, time: number, bend: number, flutter: number) => {
    const { pos, uv, geo } = pages[i], sh = SHAPES[i];
    const ph = sh.ph + 0.4 * Math.sin(time * sh.drift + i * 0.3);
    const c = sh.ca.map((a, k) => a * flutter * Math.sin(time * sh.cs[k] + sh.cp[k]));
    const arr = pos.array as Float32Array;
    for (let j = 0, n = pos.count; j < n; j++) {
      const u = uv[2 * j], v = uv[2 * j + 1];
      // each corner's weight falls off fast, so the middle of the page stays put
      const a0 = (1 - u) * 0.5, a1 = (1 + u) * 0.5, b0 = (1 - v) * 0.5, b1 = (1 + v) * 0.5;
      const w0 = a0 * b0, w1 = a1 * b0, w2 = a0 * b1, w3 = a1 * b1;
      const corners = c[0] * w0 * w0 + c[1] * w1 * w1 + c[2] * w2 * w2 + c[3] * w3 * w3;
      const tipR = Math.max(0, u - 0.45), tipL = Math.max(0, -u - 0.45);
      arr[3 * j + 1] = corners + bend * (
        sh.amp * Math.sin(sh.k * u + ph) * (1 - 0.3 * v) + sh.twist * u * v + sh.cup * v * v +
        3.3 * (sh.flickR * tipR * tipR + sh.flickL * tipL * tipL));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  };

  return {
    draw(t, enter, spin, time) {
      const k = Math.min(2, Math.floor(t));
      const f = smooth(0.2, 0.8, t - k);                 // rest on each phase, travel between
      const flutter = 1 + 1.3 * Math.sin(Math.PI * f);   // pages flap harder while they travel
      group.rotation.y = TURN * t + spin - 0.7 * (1 - enter);   // turning as it scrolls in, and all the way through
      for (let i = 0; i < N; i++) {
        const a = POSES[i][k], b = POSES[i][k + 1], { mesh, mat } = pages[i];
        const m = (key: keyof Pose) => lerp(a[key], b[key], f);
        mat.opacity = lerp(a.o, b.o, smooth(0, 0.4, f));
        mesh.visible = mat.opacity > 0.01;
        if (!mesh.visible) continue;
        mesh.position.set(m("x"), m("y"), m("z"));
        mesh.rotation.set(m("rx"), m("ry"), m("rz"));
        mesh.scale.setScalar(m("s"));
        const lit = i === ANSWER ? smooth(2.45, 2.95, t)
          : SOURCES.includes(i) ? smooth(1.45, 1.95, t) * (1 - 0.6 * smooth(2.35, 2.85, t)) : 0;
        mat.emissiveIntensity = lit * 1.3;
        bendPage(i, time, m("bend"), flutter);
      }
      const [s0, o0] = SHADOW[k], [s1, o1] = SHADOW[k + 1];
      shadow.scale.setScalar(lerp(s0, s1, f));
      shadowMat.opacity = lerp(o0, o1, f);
      renderer.render(scene, camera);
    },
    resize() {
      const w = box.clientWidth, h = box.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      const aspect = w / h, tanV = Math.tan((camera.fov * Math.PI) / 360), wide = aspect >= 1.05;
      // Wide screens: the stack stands the full height of the screen (like the
      // lenis hand), right of centre and clear of the cards. Phones: smaller,
      // above the cards. Either way the scattered pages still fit across.
      const dist = wide ? Math.max(5.6 / (2 * tanV), 10 / (2 * tanV * aspect))
        : Math.max(13.1 / (2 * tanV), 8 / (2 * tanV * aspect));
      camera.aspect = aspect;
      camera.position.set(0, dist * 0.36, dist);   // looking down ~20 degrees, onto the pages
      camera.lookAt(0, 0, 0);
      camera.setViewOffset(w, h, wide ? -w * 0.08 : 0, wide ? -h * 0.04 : h * 0.14, w, h);
      camera.updateProjectionMatrix();
    },
    warm() {
      renderer.compile(scene, camera);
    },
    dispose() {
      pages.forEach(({ geo, mat }) => { geo.dispose(); mat.dispose(); });
      shadow.geometry.dispose(); shadowMat.dispose();
      textures.forEach((x) => x.dispose());
      env.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export function NoteStack({ cta, foot }: { cta: React.ReactNode; foot: React.ReactNode }) {
  const sec = useRef<HTMLElement>(null);
  const gl = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const cards = useRef<(HTMLLIElement | null)[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const lede = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = sec.current!, box = gl.current!;
    const still = prefersStill();
    let scene: Scene | null = null, gone = false, starting = false, raf = 0, near = false;

    const frame = (now: number) => {
      raf = 0;
      const r = el.getBoundingClientRect(), vh = window.innerHeight, intro = INTRO * vh;
      const travel = r.height - vh - intro;
      const p = travel > 0 ? clamp01((-r.top - intro) / travel) : 0;
      const enter = still ? 1 : clamp01((vh - r.top) / vh);   // 1 once the section fills the screen
      const lead = still ? 1 : clamp01(-r.top / intro);       // 1 once the sheet has had its moment
      // a short rest at both ends of the story; reduced motion shows the stack, standing still
      const t = still ? 1 : Math.min(3, Math.max(0, (p / STORY) * 3.4 - 0.2));
      // turning on its own, then all through the story, then it just keeps turning
      const spin = still ? 0 : Math.max(0, p - STORY) * 2.4 - 0.5 * (1 - lead);
      const ended = !still && p > END;
      const ready = lead > 0.95;   // the cards can come in
      // The title is in the pinned screen, so it rises from below with the first
      // sheet (as lenis.dev's "brings the heat" does); the few words beside the
      // sheet make way for the cards.
      title.current?.toggleAttribute("data-on", enter > 0.12 && !ended);
      lede.current?.toggleAttribute("data-on", enter > 0.3 && !ready);
      cards.current.forEach((c, i) => {
        const on = i === 0 ? ready : i < 4 ? t > i - 0.5 : p > FEATURES + (i - 4) * FEATURE_STEP;
        c?.toggleAttribute("data-on", on && !ended);
        c?.toggleAttribute("data-gone", ended);
      });
      end.current?.toggleAttribute("data-on", ended);
      scene?.draw(t, enter, spin, still ? 0 : now / 1000);
      if (near && !still) raf = requestAnimationFrame(frame);
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

    // Fetch three.js and build the scene (studio, pages, shaders) while the
    // visitor reads the hero, so none of that lands in the middle of the zoom.
    const start = async () => {
      if (starting) return;
      starting = true;
      const T = await import("three");
      if (gone) return;
      scene = createScene(T, box);
      scene?.resize();
      scene?.warm();
      kick();
    };
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(start, { timeout: 4000 })
      : window.setTimeout(start, 2500);

    // and draw only while the section is actually on screen
    const io = new IntersectionObserver(([e]) => {
      near = e.isIntersecting;
      if (near) {
        start();
        kick();
      }
    }, { rootMargin: "60px 0px" });
    io.observe(el);
    const ro = new ResizeObserver(() => { scene?.resize(); kick(); });
    ro.observe(box);

    return () => {
      gone = true;
      io.disconnect(); ro.disconnect(); cancelAnimationFrame(raf);
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle); else window.clearTimeout(idle);
      scene?.dispose();
    };
  }, []);

  return (
    <section className="paper" id="how" ref={sec} aria-label="How Notes Rag works">
      <div className="paper-pin">
        <Particles className="paper-motes" variant="motes" />
        <div className="paper-gl" ref={gl} aria-hidden="true" />
        <h2 className="paper-h rise" ref={title} aria-label="Notes Rag brings the receipts">
          <span aria-hidden="true"><span>Notes Rag brings</span></span>
          <span aria-hidden="true"><span>the receipts</span></span>
        </h2>
        <p className="paper-lede rise" ref={lede}>
          <span><span>Your notes, read page by page.</span></span>
          <span><span>Ask anything, and every answer</span></span>
          <span><span>shows <em>the exact passage</em> it came from.</span></span>
        </p>
        <ol className="paper-cards">
          {STEPS.map((s, i) => (
            <li key={s.title} className="paper-card" style={{ "--i": i } as React.CSSProperties}
              ref={(c) => { cards.current[i] = c; }}>
              <span className="paper-n">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="paper-end" ref={end}>
          <h2 className="paper-big top rise" aria-label="Notes Rag is free to try">
            <span aria-hidden="true"><span>Notes Rag is</span></span>
            <span aria-hidden="true"><span>free to try</span></span>
          </h2>
          <p className="paper-big bottom rise" aria-label="Every answer cited">
            <span aria-hidden="true"><span>Every answer</span></span>
            <span aria-hidden="true"><span>cited</span></span>
          </p>
          <div className="paper-cta">{cta}</div>
          <footer className="paper-foot">{foot}</footer>
        </div>
      </div>
      <span className="paper-anchor" id="features" />
    </section>
  );
}
