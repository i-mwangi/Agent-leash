import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Accountable Agent — Guardian console",
  description: "Agent wallets with verifiable identity and human oversight.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
