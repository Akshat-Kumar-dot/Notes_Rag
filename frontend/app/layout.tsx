import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Self-hosted at build time (no request to Google at runtime). Exposed as a
// CSS variable only, so the workspace keeps the system font and just the
// landing page opts in.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Notes Rag",
  description: "Upload your notes and papers, ask questions, and get answers that cite the exact passage they came from.",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

// Dark UI, and the composer must sit above the phone's home indicator.
export const viewport: Viewport = {
  themeColor: "#0d0d0e",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// The site has one address. The old workers.dev one still loads, but forwards
// here first thing: Google sign-in returns to exactly one address, so a
// sign-in started on the other domain failed, and a session on one domain
// is invisible on the other. Branch preview URLs are left alone.
const SITE = "https://notesrag.byakshat.in";
const OLD_HOST = "notes-rag.akshat-kumar-singh05.workers.dev";
const toSite = `if(location.hostname===${JSON.stringify(OLD_HOST)})`
  + `location.replace(${JSON.stringify(SITE)}+location.pathname+location.search+location.hash)`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: toSite }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
