import path from "node:path";
import fs from "node:fs";
import { events } from "./events.js";
import { log } from "./logger.js";

const LOG_DIR = path.join(process.cwd(), "data", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

let currentRun = {
  id: "",
  startedAt: 0,
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function filePath(): string {
  return path.join(LOG_DIR, `${today()}.log`);
}

export function startExecution(action: string, detail = ""): void {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  currentRun = { id, startedAt: Date.now() };
  const line = `[${new Date().toISOString()}] START ${action} ${detail}`;
  fs.appendFileSync(filePath(), line + "\n", "utf8");
  log("info", line);
  events.publish({ type: "log", level: "info", message: line, ts: Date.now() });
}

export function stepExecution(message: string): void {
  const line = `[${new Date().toISOString()}] STEP ${message}`;
  fs.appendFileSync(filePath(), line + "\n", "utf8");
  log("info", line);
  events.publish({ type: "log", level: "info", message: line, ts: Date.now() });
}

export function endExecution(status: "ok" | "error", detail = ""): void {
  const ms = currentRun.startedAt ? Date.now() - currentRun.startedAt : 0;
  const line = `[${new Date().toISOString()}] END ${status} ${detail} (${ms}ms)`;
  fs.appendFileSync(filePath(), line + "\n", "utf8");
  log(status === "ok" ? "info" : "error", line);
  events.publish({ type: "log", level: status === "ok" ? "info" : "error", message: line, ts: Date.now() });
  currentRun = { id: "", startedAt: 0 };
}
