"use client";

import { I, Logo } from "@/components/Icons";

/** Phone-only header. The drawer has no permanent rail on mobile, so this is
 *  the only way back to navigation — and the brand itself opens it. */
export function Topbar({ title, onMenu, onNew }: {
  title: string;
  onMenu: () => void;
  onNew: () => void;
}) {
  return (
    <header className="topbar">
      <button className="round" onClick={onMenu} aria-label="Open menu">{I.menu}</button>
      <button className="topbrand" onClick={onMenu} aria-label="Open menu">
        <Logo size={18} />
        <span className="trunc">{title}</span>
      </button>
      <button className="round" onClick={onNew} aria-label="New chat">{I.edit}</button>
    </header>
  );
}
