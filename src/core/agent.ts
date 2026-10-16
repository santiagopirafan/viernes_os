import Groq from "groq-sdk";
import { getConfig } from "./config.js";
import { buildSystemPrompt } from "./identity.js";
import { getContext, addTurn } from "../memory/context.js";
import { rememberFact } from "../memory/facts.js";
import { log } from "./logger.js";

export interface ExtractedFact {
  k: string;
  v: string;
}

const EXTRACT_PROMPT = `Extrae datos duraderos y concretos del usuario de este mensaje (ciudad, salario, tecnologias, horario, estudios, empresa, contacto, preferencias, cuentas, criterios de busqueda).
NO extraigas saludos, despedidas ni pedidos unicos de busqueda.
Responde SOLO con JSON valido: {"facts":[{"k":"clave_en_snake_case","v":"valor corto"}]}
Si no hay nada que guardar responde: {"facts":[]}`;

export async function extractFacts(message: string): Promise<ExtractedFact[]> {
  const config = getConfig();
  const groq = new Groq({ apiKey: config.GROQ_API_KEY });
  const completion = await groq.chat.completions.create({
    model: config.GROQ_MODEL,
    messages: [{ role: "user", content: `${EXTRACT_PROMPT}\n\nMensaje del usuario:\n${message}` }],
    temperature: 0,
    max_tokens: 1600,
  });
  const raw = completion.choices[0]?.message?.content ?? "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];

  const parsed = parseFactsJson(match[0]);
  if (parsed.length) return parsed;
  return parseFactsLoose(raw);
}

function parseFactsJson(chunk: string): ExtractedFact[] {
  const candidates = [chunk, chunk.replace(/\]{2,}\s*$/, "]"), chunk.replace(/\]+\s*$/, "")];
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as { facts?: { k?: unknown; v?: unknown }[] };
      const facts = (obj.facts ?? [])
        .filter((f): f is { k: string; v: string } => typeof f?.k === "string" && typeof f?.v === "string" && f.v.trim().length > 0)
        .map((f) => ({ k: f.k, v: f.v }));
      if (facts.length) return facts;
    } catch {
      // siguiente candidato
    }
  }
  return [];
}

function parseFactsLoose(raw: string): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  const re = /"k"\s*:\s*"([^"]{1,60})"\s*,\s*"v"\s*:\s*"([^"]{1,300})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push({ k: m[1], v: m[2] });
  }
  return out;
}

export async function rememberFromMessage(message: string): Promise<void> {
  const text = message.trim();
  if (text.length < 25) return;
  if (text.startsWith("/") || /^(si|sí|no|ok|confirmar|cancelar)$/i.test(text)) return;
  try {
    const facts = await extractFacts(text);
    for (const f of facts.slice(0, 5)) {
      rememberFact(f.k, f.v);
    }
  } catch (err) {
    log("warn", `Auto-guardado de datos fallo: ${String(err).slice(0, 120)}`);
  }
}


export async function askAgent(prompt: string): Promise<string> {
  const config = getConfig();
  const groq = new Groq({ apiKey: config.GROQ_API_KEY });

  const messages = [
    { role: "system" as const, content: buildSystemPrompt() },
    ...getContext().map((t) => ({ role: t.role as "user" | "assistant", content: t.content })),
    { role: "user" as const, content: prompt },
  ];

  try {
    const completion = await groq.chat.completions.create({
      model: config.GROQ_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 2048,
    });
    const answer = completion.choices[0]?.message?.content ?? "(sin respuesta)";
    addTurn("assistant", answer);
    return answer;
  } catch (err) {
    log("error", `Groq fallo: ${String(err)}`);
    return `Error del motor LLM: ${String(err).slice(0, 300)}`;
  }
}
