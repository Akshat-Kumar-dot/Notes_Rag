/**
 * Cloudflare Pages Function: forwards every /api/* request to the backend on
 * Render.
 *
 * Cloudflare serves the pages instantly from near each visitor; this function
 * passes the API calls through. To the browser everything stays on ONE site, so
 * the sign-in cookie, Google login and streamed answers keep working with no
 * CORS setup -- a page on Cloudflare calling the Render address directly would
 * make the login cookie third-party, which browsers block.
 *
 * Set in Cloudflare Pages -> Settings -> Variables and secrets (Production):
 *   API_ORIGIN    e.g. https://note-rag.onrender.com   (no trailing slash)
 *   PROXY_SECRET  the same random value as PROXY_SECRET on Render
 *
 * Plain JS on purpose: Next's type-check covers every .ts file in frontend/,
 * and this file runs on Cloudflare, not in Next.
 */
export async function onRequest({ request, env }) {
  if (!env.API_ORIGIN) {
    return Response.json({ detail: "API_ORIGIN is not set in Cloudflare Pages." }, { status: 500 });
  }
  const url = new URL(request.url);
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
