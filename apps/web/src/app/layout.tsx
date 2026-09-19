import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = { title: "Upcraft Video System", description: "Source-grounded educational video generation" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const shell = <AppShell>{children}</AppShell>;
  return <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}><body>{process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? <ClerkProvider>{shell}</ClerkProvider> : shell}</body></html>;
}
