import fs from "node:fs";
import path from "node:path";
import Groq, { toFile } from "groq-sdk";
import { getConfig } from "../core/config.js";
import { endExecution, startExecution, stepExecution } from "../core/executionLog.js";

const VOICE_DIR = path.join(process.cwd(), "data", "voice");
const MAX_BYTES = 25 * 1024 * 1024;

const ultimasTranscripciones = new Map<string, string>();

export function guardarTranscripcion(clave: string, texto: string): void {
  ultimasTranscripciones.set(clave, texto);
}

export function ultimaTranscripcion(clave: string): string | null {
  return ultimasTranscripciones.get(clave) ?? null;
}

function extensionDesdeMime(mime: string): string {
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "ogg";
}

export function guardarAudio(buffer: Buffer, mime = "audio/ogg"): string {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const ruta = path.join(VOICE_DIR, `${Date.now()}-nota.${extensionDesdeMime(mime)}`);
  fs.writeFileSync(ruta, buffer);
  return ruta;
}

export async function transcribirAudio(buffer: Buffer, mime = "audio/ogg"): Promise<string> {
  if (buffer.length === 0) throw new Error("Audio vacío.");
  if (buffer.length > MAX_BYTES) throw new Error("Audio demasiado largo para transcribir.");
  startExecution("voz_transcribir", `${buffer.length} bytes ${mime}`);
  const config = getConfig();
  const groq = new Groq({ apiKey: config.GROQ_API_KEY });
  const archivo = await toFile(buffer, `nota.${extensionDesdeMime(mime)}`, { type: mime });
  const resultado = await groq.audio.transcriptions.create({
    file: archivo,
    model: config.GROQ_TRANSCRIBE_MODEL,
    language: "es",
  });
  const texto = (resultado.text ?? "").trim();
  stepExecution(`Transcripción lista: ${texto.length} caracteres`);
  endExecution(texto ? "ok" : "error", "nota de voz");
  return texto;
}
