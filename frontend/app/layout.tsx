import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Notes Rag",
  description: "Ask questions about your own documents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
