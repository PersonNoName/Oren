import type { Metadata } from "next";
import { Source_Sans_3, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const sans = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const serif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Oren Panel",
  description: "Warm observatory panel for Oren",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body style={{
        ["--sans" as string]: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
        ["--serif" as string]: "var(--font-serif), Georgia, serif",
      }}>{children}</body>
    </html>
  );
}
