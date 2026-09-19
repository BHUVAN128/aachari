"use client";

import Link from "next/link";
import { motion } from "framer-motion";

export const AppShell = ({ children }: { children: React.ReactNode }) => <div className="shell">
  <header className="topbar"><Link href="/" className="brand"><motion.span className="glyph" initial={{ rotateY: -20, opacity: 0 }} animate={{ rotateY: 0, opacity: 1 }}><span className="glyph-shape" /></motion.span>Upcraft <span className="muted">/ Video System</span></Link><nav className="nav"><Link href="/">Runs</Link><Link href="/runs/new">New run</Link><Link href="/settings/capabilities">Capabilities</Link></nav></header>
  {children}
</div>;
