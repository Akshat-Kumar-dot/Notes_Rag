"use client";

import { useEffect, useRef, useState } from "react";

// Web Speech API is prefixed in Chromium and absent in Firefox, so callers
// hide the mic button rather than show it broken where it cannot work.
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
interface SpeechEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
type RecognitionCtor = new () => Recognition;

const getRecognition = (): RecognitionCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/** Everything heard so far, rebuilt from ALL results on every event.
 *
 *  Appending each event's new results duplicated words: Chrome can deliver the
 *  same result again, and on Android every final result repeats the whole
 *  utterance before it ("hello", "hello world", "hello world how"). Rebuilding,
 *  and collapsing a final that merely extends or repeats the previous one,
 *  gives each word exactly once. */
export function transcriptOf(results: SpeechEvent["results"]): string {
  const finals: string[] = [];
  let interim = "";
  for (let i = 0; i < results.length; i++) {
    const text = results[i][0].transcript.trim();
    if (!text) continue;
    if (!results[i].isFinal) {
      interim = interim ? `${interim} ${text}` : text;
      continue;
    }
    const prev = finals[finals.length - 1]?.toLowerCase();
    const low = text.toLowerCase();
    if (prev && low.startsWith(prev)) finals[finals.length - 1] = text;   // cumulative repeat
    else if (prev && prev.endsWith(low)) continue;                         // re-delivered
    else finals.push(text);
  }
  const said = finals.join(" ");
  // Android can also repeat the finals at the start of the interim text.
  if (interim && said && interim.toLowerCase().startsWith(said.toLowerCase())) return interim;
  return [said, interim].filter(Boolean).join(" ");
}

/** Dictation into a text field. Speech is added after whatever is already
 *  typed, never replacing it. */
export function useDictation(value: string, setValue: (v: string) => void, onChange?: () => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);

  useEffect(() => { setSupported(getRecognition() !== null); }, []);
  // Never leave the microphone running after the field goes away.
  useEffect(() => () => rec.current?.abort(), []);

  function stop() {
    rec.current?.stop();
    setListening(false);
  }

  function toggle() {
    if (listening) { stop(); return; }
    const Ctor = getRecognition();
    if (!Ctor) return;
    const r = new Ctor();
    // The browser's own language, e.g. en-IN, recognises its accent better
    // than a generic en-US.
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    const before = value.trimEnd();
    r.onresult = (e) => {
      const said = transcriptOf(e.results);
      setValue(before && said ? `${before} ${said}` : before || said);
      onChange?.();
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  }

  return { supported, listening, toggle, stop };
}
