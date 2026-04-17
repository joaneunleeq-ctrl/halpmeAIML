import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "halpmeAIML — Learn ML from the papers that matter",
  description:
    "An AI tutor grounded in real research. Every explanation cites the source. Every concept builds on what you know.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
