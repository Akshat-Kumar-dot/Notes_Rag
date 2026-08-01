import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Notes Rag",
  description: "Ask questions about your own documents.",
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
