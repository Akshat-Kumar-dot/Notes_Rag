"use client";

import { ThinkingOrb, type OrbState, type OrbSize, type OrbTheme } from "thinking-orbs";

/** Every kind of wait in the app, and the orb that shows it. One place, so
 *  the same wait always looks the same wherever it appears. */
const ORB = {
  searching: "searching",       // a scan sweeps a globe: retrieval over your notes
  thinking: "composing",        // an undulating sash: the model writing its answer
  reconnecting: "connecting",   // a constellation rewiring: retrying a busy model
  reading: "weaving",           // strands plaiting: a document being read and indexed
  starting: "breathing",        // a calm, slow ring: setting things up
} satisfies Record<string, OrbState>;

export type Wait = keyof typeof ORB;

/** An orb with an optional line of text beside it. The text is what screen
 *  readers get (role="status"), so the canvas itself is hidden from them. */
export function Orb({ wait, label, size = 20, theme = "dark", className }: {
  wait: Wait;
  label?: string;
  size?: OrbSize;
  theme?: OrbTheme;
  className?: string;
}) {
  return (
    <span className={`orb ${className ?? ""}`} role="status">
      <ThinkingOrb state={ORB[wait]} size={size} theme={theme} aria-hidden="true" />
      {label && <span className="orb-label">{label}</span>}
    </span>
  );
}
