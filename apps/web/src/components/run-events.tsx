"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { RunEvent } from "@upcraft/contracts";

export const RunEvents = ({ runId, initialEvents }: { runId: string; initialEvents: RunEvent[] }) => {
  const [events, setEvents] = useState(initialEvents);
  useEffect(() => {
    const latest = events.at(-1)?.data.sequence;
    const stream = new EventSource(`/api/runs/${runId}/events?after=${typeof latest === "number" ? latest : 0}`);
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
    };
    return () => stream.close();
  }, [runId]);
  return <div className="events"><AnimatePresence initial={false}>{events.map((event) => <motion.div className="event" key={event.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}><div className="mono muted">{event.stage ?? "run"}</div><div><div>{event.message}</div><div className="mono muted" style={{ fontSize: 11, marginTop: 5 }}>{new Date(event.createdAt).toLocaleString()}</div></div></motion.div>)}</AnimatePresence></div>;
};
