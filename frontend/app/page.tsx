"use client";

import { useEffect, useRef, useState } from "react";
import { I, Logo } from "@/components/Icons";
import { Orb } from "@/components/Orb";
import { Particles } from "@/components/Particles";
import { api } from "@/lib/api";
import { fingerprint } from "@/lib/fingerprint";

const LOGIN = "/api/v1/auth/google/login";

/** Example answers for the hero card. Each sentence carries the number of the
 *  passage it came from -- the same shape the real chat renders. */
const EXAMPLES = [
  {
    folder: "NoSQL course",
    question: "When should I embed instead of reference in MongoDB?",
    answer: [
      { text: "Embed data that is read together and belongs to one parent, like a post and its comments.", cite: 1 },
      { text: "Reference it instead when it grows without bound or is shared by many documents.", cite: 2 },
      { text: "Either way, a single document must stay under the 16 MB limit.", cite: 3 },
    ],
    sources: ["mongodb-schema-design.pdf · p.4", "lecture-6-notes.md", "mongodb-schema-design.pdf · p.9"],
  },
  {
    folder: "Distributed systems",
    question: "What does the CAP theorem actually say?",
    answer: [
      { text: "When the network partitions, a distributed store has to choose between consistency and availability.", cite: 1 },
      { text: "It cannot guarantee both while nodes are cut off from each other.", cite: 1 },
      { text: "Cassandra leans towards availability and may return slightly stale data.", cite: 2 },
    ],
    sources: ["cap-theorem.pdf · p.2", "week-3-slides.pdf · p.17"],
  },
  {
    folder: "ML research",
    question: "How does backpropagation update the weights?",
    answer: [
      { text: "It uses the chain rule to compute how the loss changes with each weight,", cite: 1 },
      { text: "working backwards from the output layer.", cite: 1 },
      { text: "Every weight then takes a small step against its gradient, scaled by the learning rate.", cite: 2 },
    ],
    sources: ["deep-learning-ch6.pdf · p.204", "lecture-9.md"],
  },
];

export default function Landing() {
  const [failed, setFailed] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const tilt = useRef<HTMLDivElement>(null);

  // Sections ease in as they scroll into view. The hidden starting state is
  // only applied once this runs, so without JavaScript everything just shows.
  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.classList.add("lp-reveal-ready");
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      }
    }, { threshold: 0.15 });
    el.querySelectorAll("[data-reveal]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);

  // The demo card leans gently toward the pointer. Written straight to CSS
  // variables: re-rendering React on every mouse move would be wasteful.
  function lean(e: React.PointerEvent<HTMLElement>) {
    const card = tilt.current;
    if (!card || e.pointerType !== "mouse") return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width - 0.5;
    const y = (e.clientY - box.top) / box.height - 0.5;
    card.style.setProperty("--ry", `${(x * 7).toFixed(2)}deg`);
    card.style.setProperty("--rx", `${(-y * 6).toFixed(2)}deg`);
  }
  function unlean() {
    tilt.current?.style.setProperty("--ry", "0deg");
    tilt.current?.style.setProperty("--rx", "0deg");
  }

  // Render straight away and redirect only if already signed in: waiting on
  // /me first meant a blank screen for the ~0.5s a Neon round trip takes.
  useEffect(() => {
    setFailed(new URLSearchParams(window.location.search).has("error"));
    fetch("/api/v1/auth/me", { credentials: "include" })
      .then((r) => { if (r.ok) window.location.replace("/app"); })
      .catch(() => {});
  }, []);

  async function tryFree() {
    setStarting(true);
    setTrialError(null);
    try {
      await api.startGuest(await fingerprint());
      window.location.replace("/app");
    } catch (e) {
      setTrialError(e instanceof Error ? e.message : "Couldn't start a free trial.");
      setStarting(false);
    }
  }

  // On the white button, so the orb draws dark ink (theme "light").
  const tryLabel = starting
    ? <Orb wait="starting" theme="light" label="Setting up…" />
    : "Try it free";

  return (
    <div className="lp" ref={root}>
      <header className="lp-nav">
        <a className="lp-brand" href="/" aria-label="Notes Rag home">
          <Logo size={26} />
          <span><b>notes</b>rag</span>
        </a>
        <nav className="lp-links" aria-label="Main">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href={LOGIN}>Sign in</a>
          <button className="lp-btn primary sm" onClick={tryFree} disabled={starting} aria-busy={starting}>{tryLabel}</button>
        </nav>
      </header>

      <main>
        <section className="lp-hero" onPointerMove={lean} onPointerLeave={unlean}>
          <Particles className="lp-particles" />
          <div className="lp-copy">
            <span className="lp-pill">{I.sparkle} Chat with your documents · Cited answers</span>
            <h1>
              Ask your notes.
              <span className="lp-fade">See the source.</span>
            </h1>
            <p className="lp-sub">
              Upload lecture notes, papers and PDFs. Notes Rag answers from your own files, and
              shows the exact passage behind every sentence.
            </p>
            <div className="lp-ctas">
              <button className="lp-btn primary" onClick={tryFree} disabled={starting} aria-busy={starting}>
                {tryLabel} {!starting && I.arrow}
              </button>
              <a className="lp-btn ghost" href={LOGIN}>{I.google} Sign in with Google</a>
            </div>
            <ul className="lp-checks">
              <li>{I.check} No sign-up to try</li>
              <li>{I.check} 1 document, 2 questions free</li>
              <li>{I.check} Every answer cited</li>
            </ul>
            {failed && <p className="note err lp-note">Sign-in didn&apos;t complete. Try again.</p>}
            {trialError && <p className="note err lp-note">{trialError}</p>}
          </div>

          <div className="lp-float">
            <div className="lp-tilt" ref={tilt}><DemoCard /></div>
          </div>
        </section>

        <section className="lp-section" id="how">
          <h2 data-reveal>How it works</h2>
          <p className="lp-lead" data-reveal>Three steps, and no answer you can&apos;t check.</p>
          <ol className="lp-steps">
            <li data-reveal style={{ "--d": 0 } as React.CSSProperties}>
              <span className="lp-step-ico">{I.upload}</span>
              <h3>Upload</h3>
              <p>PDFs, Word documents, text, Markdown and images. Group them into folders by course or project.</p>
            </li>
            <li data-reveal style={{ "--d": 1 } as React.CSSProperties}>
              <span className="lp-step-ico">{I.chat}</span>
              <h3>Ask</h3>
              <p>Ask in plain language. Follow-ups understand the conversation, so &ldquo;what about the second one?&rdquo; works.</p>
            </li>
            <li data-reveal style={{ "--d": 2 } as React.CSSProperties}>
              <span className="lp-step-ico">{I.quote}</span>
              <h3>Check</h3>
              <p>Every answer lists the passages it used, with file and page, so you can verify it in seconds.</p>
            </li>
          </ol>
        </section>

        <section className="lp-section" id="features">
          <h2 data-reveal>Built for studying, not guessing</h2>
          <div className="lp-grid">
            <Feature n={0} icon={I.db} title="Finds meaning and exact words">
              Hybrid search combines semantic matching with keyword search, so names, formulas
              and course codes are found too.
            </Feature>
            <Feature n={1} icon={I.chat} title="Says when it doesn't know">
              If your files don&apos;t cover a question, the answer is flagged as low confidence
              instead of confidently made up.
            </Feature>
            <Feature n={2} icon={I.search} title="Search without AI">
              Search Notes returns the matching passages only. Nothing is generated, nothing is
              invented.
            </Feature>
            <Feature n={3} icon={I.folder} title="Scoped by folder">
              Each chat is tied to the folders you pick, so an answer about one course never
              leaks in from another.
            </Feature>
          </div>
        </section>

        <section className="lp-final" data-reveal>
          <h2>Try it on your own notes</h2>
          <p>One document and two questions, free. No account needed.</p>
          <div className="lp-ctas center">
            <button className="lp-btn primary" onClick={tryFree} disabled={starting} aria-busy={starting}>
              {tryLabel} {!starting && I.arrow}
            </button>
            <a className="lp-btn ghost" href={LOGIN}>{I.google} Sign in with Google</a>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <span className="lp-brand small"><Logo size={16} /><span><b>notes</b>rag</span></span>
        <span>Answers from your documents, with sources.</span>
      </footer>
    </div>
  );
}

function Feature({ n, icon, title, children }: {
  n: number; icon: React.ReactNode; title: string; children: React.ReactNode;
}) {
  return (
    <div className="lp-feature" data-reveal style={{ "--d": n } as React.CSSProperties}>
      <span className="lp-step-ico">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

/** Timings for one example, played like the real app: the question types in,
 *  retrieval runs, the model thinks, the answer streams word by word, then
 *  the sources it used appear one by one. */
const CHAR_MS = 24, SEARCH_MS = 1100, THINK_MS = 950, WORD_MS = 55, SRC_MS = 300, HOLD_MS = 4200;

function timeline(ex: (typeof EXAMPLES)[number]) {
  const words = ex.answer.map((s) => s.text.split(" "));
  const nWords = words.reduce((n, w) => n + w.length, 0);
  const tQ = ex.question.length * CHAR_MS;
  const tS = tQ + SEARCH_MS;
  const tT = tS + THINK_MS;
  const tA = tT + nWords * WORD_MS;
  const tSrc = tA + ex.sources.length * SRC_MS;
  return { words, nWords, tQ, tS, tT, tA, total: tSrc + HOLD_MS };
}

/** The hero preview, animated. Hovering pauses it (so the sources can be
 *  explored: hovering a sentence or a source highlights its partner). */
function DemoCard() {
  const [idx, setIdx] = useState(0);
  const [t, setT] = useState(0);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);   // prefers-reduced-motion
  const [hot, setHot] = useState<number | null>(null);
  const ex = EXAMPLES[idx];
  const tl = timeline(ex);

  useEffect(() => {
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (still || paused) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = document.hidden ? 0 : now - last;
      last = now;
      setT((cur) => cur + dt);
    }, 30);
    return () => window.clearInterval(id);
  }, [still, paused, idx]);

  useEffect(() => {
    if (t < tl.total) return;
    setIdx((i) => (i + 1) % EXAMPLES.length);
    setT(0);
    setHot(null);
  }, [t, tl.total]);

  // Reduced motion: every example is shown finished, and only the dots move.
  const now = still ? tl.total - 1 : t;
  const typed = Math.min(ex.question.length, Math.floor(now / CHAR_MS));
  const phase = now < tl.tQ ? "typing" : now < tl.tS ? "searching" : now < tl.tT ? "thinking" : "answering";
  const shownWords = phase === "answering" ? Math.min(tl.nWords, Math.floor((now - tl.tT) / WORD_MS) + 1) : 0;
  const shownSources = now < tl.tA ? 0 : Math.min(ex.sources.length, Math.floor((now - tl.tA) / SRC_MS) + 1);

  let budget = shownWords;
  const sentences = tl.words.map((w, i) => {
    const take = Math.max(0, Math.min(w.length, budget));
    budget -= take;
    return { cite: ex.answer[i].cite, text: w.slice(0, take).join(" "), done: take === w.length };
  });

  return (
    <div
      className="lp-card"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => { setPaused(false); setHot(null); }}
      aria-label="Example answer"
    >
      <div className="lp-card-head">
        <span className="lp-scope">
          {I.search}<span className="lp-wide-only">Asking across</span><b className="trunc">{ex.folder}</b>
        </span>
      </div>

      <div className="lp-card-body">
        <p className="lp-q">
          {ex.question.slice(0, typed)}
          {phase === "typing" && <span className="lp-caret" />}
        </p>

        {(phase === "searching" || phase === "thinking") && (
          <div className="lp-wait">
            <Orb wait={phase} label={phase === "searching" ? "Searching your notes…" : "Thinking…"} />
          </div>
        )}

        {phase === "answering" && (
          <p className="lp-a">
            {sentences.filter((s) => s.text).map((s, i) => (
              <span key={i}>
                <mark className={hot === s.cite ? "on" : undefined} onMouseEnter={() => setHot(s.cite)}>
                  {s.text}{s.done && <sup>{s.cite}</sup>}
                </mark>{" "}
              </span>
            ))}
            {shownWords < tl.nWords && <span className="lp-caret" />}
          </p>
        )}
      </div>

      <ol className="lp-sources">
        {ex.sources.map((src, i) => (
          <li
            key={src}
            className={`${hot === i + 1 ? "on" : ""} ${i < shownSources ? "in" : ""}`}
            onMouseEnter={() => setHot(i + 1)}
          >
            <span className="n">{i + 1}</span>{I.file}<span className="trunc">{src}</span>
          </li>
        ))}
      </ol>

      <div className="lp-dots">
        {EXAMPLES.map((e, i) => (
          <button
            key={e.folder}
            className={i === idx ? "on" : undefined}
            onClick={() => { setIdx(i); setT(0); setHot(null); }}
            aria-label={`Example ${i + 1}: ${e.folder}`}
            aria-current={i === idx}
          />
        ))}
      </div>
    </div>
  );
}
