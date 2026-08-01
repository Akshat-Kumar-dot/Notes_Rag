import type { NextConfig } from "next";

// Static export: `next build` emits plain HTML/JS into ./out, which FastAPI
// serves. No Node process in production, no separate service.
const config: NextConfig = { output: "export", reactStrictMode: true };
export default config;
