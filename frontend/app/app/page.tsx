"use client";

import { useEffect, useState } from "react";

interface User {
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

export default function Workspace() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetch("/api/v1/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setUser)
      .catch(() => window.location.replace("/"));
  }, []);

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
    window.location.replace("/");
  }

  if (!user) return null;

  return (
    <main className="wrap">
      <h1 className="title">Signed in</h1>
      <div className="row">
        {user.avatar_url && <img className="avatar" src={user.avatar_url} alt="" />}
        <div>
          <div>{user.display_name}</div>
          <div className="sub">{user.email}</div>
        </div>
      </div>
      <button className="btn ghost" onClick={logout}>
        Sign out
      </button>
    </main>
  );
}
