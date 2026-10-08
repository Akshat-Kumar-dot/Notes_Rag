/**
 * Cloudflare Worker: serves the frontend and forwards /api/* to Render.
 *
 * Pages (the built files in out/) are served by Cloudflare's static assets
 * directly -- wrangler.jsonc sends only /api/* to this script -- so they load
 * instantly from near each visitor, even while the Render server is asleep.
 *
 * API calls are passed through to Render. To the browser everything stays on
 * ONE site, so the sign-in cookie, Google login and streamed answers keep
 * working with no CORS setup -- a page calling the Render address directly
 * would make the login cookie third-party, which browsers block.
 *
 * Config (see wrangler.jsonc):
 *   API_ORIGIN    var     the Render address, e.g. https://note-rag.onrender.com
 *   PROXY_SECRET  secret  `npx wrangler secret put PROXY_SECRET`; same value as
 *                         PROXY_SECRET on Render
 *
 * Plain JS on purpose: Next's type-check covers every .ts file in frontend/,
 * and this file runs on Cloudflare, not in Next.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return forward(request, env, url);
    // Only reached if run_worker_first is ever widened; pages come from assets.
    return env.ASSETS.fetch(request);
  },
};

async function forward(request, env, url) {
  if (!env.API_ORIGIN || env.API_ORIGIN.includes("YOUR-SERVICE")) {
    return Response.json(
      { detail: "API_ORIGIN is not set: put your Render address in frontend/wrangler.jsonc." },
      { status: 500 },
    );
  }
  const target = new URL(url.pathname + url.search, env.API_ORIGIN);

  const headers = new Headers(request.headers);
  headers.delete("host");
  // Render only sees Cloudflare's address. Pass the visitor's real one --
  // CF-Connecting-IP is set by Cloudflare's edge, so visitors can't forge it --
  // with the shared secret that tells the backend to believe it.
  headers.set("X-Client-IP", request.headers.get("CF-Connecting-IP") ?? "");
  headers.set("X-Proxy-Secret", env.PROXY_SECRET ?? "");

  const init = {
    method: request.method,
    headers,
    // Hand redirects (Google sign-in) back to the browser instead of following them here.
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    // Streamed, not buffered: uploads go straight through. ("duplex" is what
    // standard fetch requires for a streamed body; Cloudflare ignores it.)
    init.body = request.body;
    init.duplex = "half";
  }

  let res;
  try {
    res = await fetch(target, init);
  } catch {
    return Response.json(
      { detail: "The server is waking up or unreachable. Try again in a moment." },
      { status: 502 },
    );
  }
  // Passing the body through unbuffered keeps streamed answers (SSE) streaming.
  return new Response(res.body, res);
}
