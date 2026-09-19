"use client";
import { useActionState } from "react";
import { motion } from "framer-motion";
import { createRunAction, type FormState } from "@/app/actions";

const initialState: FormState = {};

export const NewRunForm = () => {
  const [state, action, pending] = useActionState(createRunAction, initialState);
  return <form action={action} className="form">
    <div className="grid grid-2"><div className="field"><label htmlFor="topic">Lesson topic</label><input id="topic" name="topic" required placeholder="How does a solar eclipse occur?" /></div><div className="field"><label htmlFor="learningLevel">Learner level</label><input id="learningLevel" name="learningLevel" required placeholder="Grade 8" /></div></div>
    <div className="grid grid-3"><div className="field"><label htmlFor="domain">Risk domain</label><select id="domain" name="domain" defaultValue="standard"><option value="standard">Standard</option><option value="engineering">Engineering</option><option value="medical">Medical</option><option value="client-production">Client production</option></select></div><div className="field"><label htmlFor="audienceCategory">Audience</label><select id="audienceCategory" name="audienceCategory" defaultValue="school"><option value="school">School</option><option value="college">College</option><option value="other">Other</option></select></div><div className="field"><label htmlFor="durationSeconds">Duration (seconds)</label><input id="durationSeconds" name="durationSeconds" type="number" min="15" max="900" defaultValue="60" required /></div></div>
    <div className="grid grid-2"><div className="field"><label htmlFor="aspectRatio">Aspect ratio</label><select id="aspectRatio" name="aspectRatio" defaultValue="16:9"><option value="16:9">16:9 landscape</option><option value="9:16">9:16 vertical</option></select></div><div /></div>
    <div className="grid grid-2"><div className="field"><label htmlFor="language">Language</label><input id="language" name="language" defaultValue="en" required /></div><div className="field"><label htmlFor="visualProfile">Visual profile</label><input id="visualProfile" name="visualProfile" defaultValue="Precise, calm educational motion graphics" required /></div></div>
    <div className="card"><div className="grid grid-2"><div className="field"><label htmlFor="sourceKind">Source type</label><select id="sourceKind" name="sourceKind"><option value="text">Pasted authoritative source text</option><option value="url">Authoritative source URL</option></select></div><div className="field"><label htmlFor="sourceName">Source name</label><input id="sourceName" name="sourceName" defaultValue="Primary source" required /></div></div><div className="field" style={{ marginTop: 16 }}><label htmlFor="sourceValue">Source content or URL</label><textarea id="sourceValue" name="sourceValue" required placeholder="Paste source text, or select URL and enter a complete https:// URL." /></div></div>
    {state.error ? <div className="error">{state.error}</div> : null}
    <div className="form-actions"><motion.button className="button button-primary" type="submit" disabled={pending} whileTap={{ scale: .98 }}>{pending ? "Reserving run…" : "Create durable run"}</motion.button><span className="muted">The input snapshot freezes before any billable provider work.</span></div>
  </form>;
};
