import { appendMessage, listRecentGlobal } from "./sqlite.js";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

const MAX_TURNS = 20;
const turns: Turn[] = [];
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const rows = listRecentGlobal(MAX_TURNS);
  for (const row of rows) {
    if (row.role === "user" || row.role === "assistant") {
      turns.push({ role: row.role, content: row.content });
    }
  }
}

export function addTurn(role: Turn["role"], content: string, channel = "cli"): void {
  ensureLoaded();
  const resumen = content.length > 600 ? `${content.slice(0, 600)}…` : content;
  turns.push({ role, content: resumen });
  if (turns.length > MAX_TURNS) {
    turns.shift();
  }
  appendMessage(channel, role, content);
}

export function getContext(): Turn[] {
  ensureLoaded();
  return [...turns];
}

export function clearContext(): void {
  loaded = true;
  turns.length = 0;
}
