"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

const languages = ["en", "hi", "es", "fr", "de", "pt", "ja", "ko", "zh", "ar"];

export const IntakeChat = () => {
  const [language, setLanguage] = useState("en");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!status || !(status.startsWith("queued:") || status.startsWith("running:"))) return;
    const sessionId = status.split(":")[1];
    if (!sessionId) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/intake-sessions/${sessionId}`, { cache: "no-store" });
      if (!response.ok) return;
      const current = await response.json() as { status: string; runId?: string | null; error?: string | null };
      if (current.status === "completed" && current.runId) {
        window.clearInterval(timer);
        window.location.href = `/runs/${current.runId}`;
      } else if (current.status === "failed") {
        window.clearInterval(timer);
        setSending(false);
        setStatus(null);
        setError(current.error || "Chat intake failed.");
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true); setError(null); setStatus(null);
    const form = new FormData();
    form.set("message", message);
    form.set("language", language);
    if (file) form.set("file", file);
    const response = await fetch("/api/intake-sessions", { method: "POST", body: form });
    const body = await response.json() as { sessionId?: string; error?: string };
    if (!response.ok || !body.sessionId) { setSending(false); setError(body.error || "Unable to start intake."); return; }
    setStatus(`queued:${body.sessionId}`);
  };

  return <form className="intake-chat" onSubmit={submit}>
    <div className="intake-chat-head"><div><div className="eyebrow">Chat intake</div><h2>Describe the lesson. We’ll prepare the run.</h2><p className="muted">Sources are optional. Add one with the + button, a URL, or a <span className="mono">Source:</span> block — otherwise we research authoritative pages for you.</p></div><select aria-label="Language" className="language-select" value={language} onChange={(event) => setLanguage(event.target.value)}>{languages.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
    <div className="intake-composer"><textarea aria-label="Lesson request" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="photosynthesis working&#10;&#10;Optional — Source: paste the authoritative text here" disabled={sending} required /><div className="intake-composer-bar"><button type="button" className="button intake-upload" onClick={() => fileInput.current?.click()} disabled={sending} aria-label="Upload source">+</button><input ref={fileInput} type="file" accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf" hidden onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><span className="muted intake-file">{file ? file.name : "Optional: TXT, Markdown, or PDF source"}</span><button className="button button-primary" type="submit" disabled={sending || message.trim().length < 3}>{sending ? "Preparing…" : "Start generation"}</button></div></div>
    {status ? <div className="intake-progress">The Intake Briefing Agent is preparing your structured brief before the video pipeline starts…</div> : null}
    {error ? <div className="error">{error}</div> : null}
  </form>;
};
