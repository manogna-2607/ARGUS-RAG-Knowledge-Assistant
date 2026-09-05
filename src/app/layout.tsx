import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ARGUS — AI Knowledge Engine",
  description:
    "A grounded Retrieval-Augmented Generation (RAG) knowledge assistant that transforms documents into searchable knowledge and provides evidence-backed answers with source citations.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
