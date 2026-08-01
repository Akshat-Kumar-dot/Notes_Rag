"use client";

import { useEffect, useState } from "react";
import { I, Logo } from "@/components/Icons";

export default function Landing() {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(new URLSearchParams(window.location.search).has("error"));
    fetch("/api/v1/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? window.location.replace("/app") : setReady(true)))
      .catch(() => setReady(true));
  }, []);

  if (!ready) return null;

  return (
    <main className="landing">
      <div>
        <span className="landing-mark"><Logo size={54} /></span>
        <h1>Notes Rag</h1>
        <p>
          Upload your notes, papers and documents — then ask questions about them.
          Every answer shows the passages it came from.
        </p>
        <a className="gbtn" href="/api/v1/auth/google/login">
          {I.google} Continue with Google
        </a>
        {failed && <p className="note err" style={{ marginTop: 20 }}>Sign-in didn&apos;t complete. Try again.</p>}
      </div>
    </main>
  );
}
