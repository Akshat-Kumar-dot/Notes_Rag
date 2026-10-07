/** A hash of stable browser traits, sent when starting a free trial.
 *
 *  It is a deterrent, not an identity: anyone can send a different value, and
 *  identical phones produce identical hashes. The server only acts on it
 *  together with the network, and the site-wide daily caps are what actually
 *  bound abuse. It survives incognito and cleared cookies, which is its job. */
export async function fingerprint(): Promise<string> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const traits = [
    nav.userAgent,
    nav.language,
    (nav.languages ?? []).join(","),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    String(window.devicePixelRatio),
    String(nav.hardwareConcurrency ?? ""),
    String(nav.deviceMemory ?? ""),
    canvasTrait(),
    webglTrait(),
  ].join("|");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(traits));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Text rendering differs subtly by GPU, driver and font stack. */
function canvasTrait(): string {
  try {
    const c = document.createElement("canvas");
    c.width = 220; c.height = 40;
    const g = c.getContext("2d");
    if (!g) return "";
    g.textBaseline = "top";
    g.font = "16px 'Arial'";
    g.fillStyle = "#f60";
    g.fillRect(100, 1, 62, 20);
    g.fillStyle = "#069";
    g.fillText("Notes Rag ✓ 2026", 2, 15);
    return c.toDataURL();
  } catch {
    return "";
  }
}

function webglTrait(): string {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? `${gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)}/${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}`
      : String(gl.getParameter(gl.RENDERER));
  } catch {
    return "";
  }
}
