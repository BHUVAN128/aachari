"use client";

import { useState } from "react";
import { IntakeChat } from "./intake-chat";
import { NewRunForm } from "./new-run-form";

export const NewRunExperience = () => {
  const [mode, setMode] = useState<"chat" | "manual">("chat");
  return <>
    <div className="mode-toggle" role="tablist" aria-label="Run creation mode"><button className={mode === "chat" ? "active" : ""} type="button" onClick={() => setMode("chat")}>Chat</button><button className={mode === "manual" ? "active" : ""} type="button" onClick={() => setMode("manual")}>Advanced form</button></div>
    {mode === "chat" ? <IntakeChat /> : <NewRunForm />}
  </>;
};
