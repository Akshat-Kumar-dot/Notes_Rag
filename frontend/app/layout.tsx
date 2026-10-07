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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
