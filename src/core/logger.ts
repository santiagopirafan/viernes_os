import path from "node:path";
import fs from "node:fs";
import winston from "winston";
import { events } from "./events.js";

const LOGS_DIR = path.join(process.cwd(), "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(LOGS_DIR, "viernes.log") }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(
          (info) => `${info.timestamp} ${info.level}: ${info.message}`
        )
      ),
    }),
  ],
});

export function log(
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>
): void {
  if (meta === undefined) {
    logger.log(level, message);
  } else {
    logger.log(level, message, meta);
  }
  events.publish({ type: "log", level, message, ...(meta ? { meta } : {}), ts: Date.now() });
}
