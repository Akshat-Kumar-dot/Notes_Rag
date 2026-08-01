"use client";

import { useEffect, useState } from "react";

export default function Landing() {
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(new URLSearchParams(window.location.search).get("error") !== null);
    // Already signed in? Skip the landing page.
    fetch("/api/v1/auth/me", { credentials: "include" })
      .then((r) => {
        if (r.ok) window.location.replace("/app");
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, []);

  if (checking) return null;

  return (
    <main className="wrap">
      <h1 className="title">
        notes<span>_</span>rag
      </h1>
      <p className="sub">
        Upload your notes, then ask questions about them. Answers come back with the
        passages they were built from.
      </p>
      <a className="btn" href="/api/v1/auth/google/login">
        Continue with Google
      </a>
      {failed && <p className="err">Sign-in didn&apos;t complete. Try again.</p>}
    </main>
  );
}
