"use client";

import { useEffect, useRef, useState } from "react";

export interface ModalSpec {
  title: string;
  description?: string;
  /** Present => the modal asks for text. Absent => it is a confirmation. */
  input?: { label: string; placeholder?: string; initial?: string };
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (value: string) => Promise<void> | void;
}

export function Modal({ spec, onClose }: { spec: ModalSpec | null; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!spec) return;
    setValue(spec.input?.initial ?? "");
    setError(null);
    setBusy(false);
    // Focus what the user is about to act on, not the dialog container.
    const t = setTimeout(() => (spec.input ? field.current?.select() : confirmBtn.current?.focus()), 20);
    return () => clearTimeout(t);
  }, [spec]);

  useEffect(() => {
    if (!spec) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // The page behind must not scroll while a dialog is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [spec, onClose]);

  if (!spec) return null;

  const blocked = busy || (!!spec.input && !value.trim());

  async function go() {
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      await spec!.onConfirm(value.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
      setBusy(false);
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={spec.title}>
        <h3>{spec.title}</h3>
        {spec.description && <p className="dim">{spec.description}</p>}

        {spec.input && (
          <label className="field">
            <span>{spec.input.label}</span>
            <input
              ref={field}
              value={value}
              placeholder={spec.input.placeholder}
              maxLength={100}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }}
            />
          </label>
        )}

        {error && <p className="note err">{error}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            ref={confirmBtn}
            className={`btn primary ${spec.danger ? "danger" : ""}`}
            onClick={go}
            disabled={blocked}
          >
            {busy ? "Working…" : spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
