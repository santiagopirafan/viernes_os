import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDocumentProxy, extractText } from "unpdf";
import { registerTool } from "./registry.js";
import { PERFIL_USUARIO } from "./perfil_candidato.js";
import { rememberFact } from "../memory/facts.js";
import { log } from "../core/logger.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = path.join(ROOT, "data");
const CV_TXT = path.join(DATA_DIR, "cv.txt");
const CV_META = path.join(DATA_DIR, "cv.meta.json");
const CV_PDF = path.join(DATA_DIR, "cv.pdf");

export async function extractPdfText(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(data);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  const limpio = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  log("info", `PDF extraido: ${totalPages} paginas, ${limpio.length} caracteres`);
  return limpio;
}

export function saveCv(
  text: string,
  meta: { nombre: string; fuente: string; ruta?: string; pdf?: Buffer }
): string {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (meta.pdf) fs.writeFileSync(CV_PDF, meta.pdf);
  const ruta = meta.ruta ?? (meta.pdf ? CV_PDF : undefined);
  fs.writeFileSync(CV_TXT, text, "utf8");
  fs.writeFileSync(
    CV_META,
    JSON.stringify(
      { ...meta, ruta, pdf: undefined, chars: text.length, fecha: new Date().toISOString() },
      null,
      2
    ),
    "utf8"
  );
  rememberFact("cv_cargado", `${meta.nombre} (${text.length} caracteres, via ${meta.fuente})`);
  if (ruta) rememberFact("ruta_cv_original", ruta);
  return CV_TXT;
}

export function getCvPdfPath(): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(CV_META, "utf8")) as { ruta?: string };
    if (meta.ruta && fs.existsSync(meta.ruta)) return meta.ruta;
  } catch {
    // sin meta
  }
  if (fs.existsSync(CV_PDF)) return CV_PDF;
  const carpeta = path.dirname(ROOT);
  try {
    const candidatos = fs
      .readdirSync(carpeta)
      .filter((f) => f.toLowerCase().endsWith(".pdf") && f.toLowerCase().includes("cv"));
    if (candidatos.length) {
      const ruta = path.join(carpeta, candidatos[0]);
      if (fs.existsSync(ruta)) return ruta;
    }
  } catch {
    // sin acceso
  }
  return null;
}

export function loadCvText(): string | null {
  try {
    return fs.readFileSync(CV_TXT, "utf8");
  } catch {
    return null;
  }
}

export function getCandidateProfile(): string {
  const cv = loadCvText();
  if (cv && cv.length > 100) {
    const skills = ["sql", "java", "python", "qa", "automation", "selenium", "cypress", "javascript", "typescript", "react", "node", "aws", "docker", "kubernetes", "linux", "excel", "powerbi", "soporte", "help desk", "call center"];
    const found = skills.filter((s) => new RegExp(`\\b${s}\\b`, "i").test(cv));
    const years = (cv.match(/(\d+)\s*(?:años|anos|year)/i) || [])[1];
    return `CV DEL CANDIDADO (extraido de su PDF, ${cv.length} caracteres):\nSkills detectadas: ${found.join(", ") || "no detectadas"}\nAños mencionados: ${years ?? "no detectados"}\n${cv.slice(0, 6000)}`;
  }
  return PERFIL_USUARIO;
}

async function runCvTool(input: string): Promise<string> {
  const ruta = input.trim().replace(/^["']|["']$/g, "");
  if (!ruta) {
    const cv = loadCvText();
    if (!cv) return "Envia la ruta de un PDF, ej: usa cv C:/Users/santi/Documents/cv.pdf";
    return `CV cargado actualmente (${cv.length} caracteres):\n\n${cv.slice(0, 800)}...`;
  }
  if (!fs.existsSync(ruta)) return `No encuentro el archivo: ${ruta}`;
  if (!ruta.toLowerCase().endsWith(".pdf")) return "Solo leo archivos .pdf por ahora.";
  const buf = fs.readFileSync(ruta);
  const texto = await extractPdfText(new Uint8Array(buf));
  if (texto.length < 50) {
    return "El PDF no contiene texto extraible (¿es un escaneo/foto?). Enviame un CV con texto.";
  }
  saveCv(texto, { nombre: path.basename(ruta), fuente: "cli", ruta: path.resolve(ruta), pdf: buf });
  return `CV cargado: ${path.basename(ruta)}\n${texto.length} caracteres extraidos.\nYa lo uso para evaluar vacantes.\n\nPrimeras lineas:\n${texto.slice(0, 500)}`;
}

registerTool({
  name: "cv",
  description: "Carga tu CV en PDF (extrae el texto y queda como perfil para buscar empleo).",
  risk: "green",
  channels: ["cli", "whatsapp"],
  handler: runCvTool,
});
