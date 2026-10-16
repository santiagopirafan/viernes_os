import fs from "node:fs";
import path from "node:path";
import { upsertNote, searchNotes, listNotes } from "./sqlite.js";

const NOTES_DIR = path.join(process.cwd(), "notes");

export function syncNotes(): number {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const files = fs
    .readdirSync(NOTES_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith(".md") || e.name.endsWith(".txt")));

  for (const entry of files) {
    const full = path.join(NOTES_DIR, entry.name);
    const content = fs.readFileSync(full, "utf8");
    const firstLine = content.split("\n")[0].replace(/^#+\s*/, "").trim();
    upsertNote(full, firstLine || entry.name, content);
  }
  return files.length;
}

export { searchNotes, listNotes };
