import { upsertFact, listFacts, deleteFact } from "./sqlite.js";
import { log } from "../core/logger.js";

const MAX_FACTS = 60;

export function rememberFact(key: string, value: string): string {
  const k = key.trim().toLowerCase().replace(/\s+/g, "_");
  const v = value.trim();
  if (!k || !v) return "Clave o valor vacio.";
  const existing = listFacts();
  if (!existing.some((f) => f.key === k) && existing.length >= MAX_FACTS) {
    return `Memoria llena (${MAX_FACTS} hechos). Borra alguno con /memory borrar <clave>.`;
  }
  const current = existing.find((f) => f.key === k);
  if (current && current.value === v) return `Ya lo tenia: ${k} = ${v}`;
  upsertFact(k, v);
  log("info", `Fact guardado: ${k} = ${v.slice(0, 80)}`);
  return `Guardado. ${k} = ${v}`;
}

export function forgetFact(key: string): string {
  return deleteFact(key) ? `Borre el dato '${key}'.` : `No tengo el dato '${key}'.`;
}

export function factsList(): string {
  const facts = listFacts();
  if (!facts.length) return "Sin datos guardados aun. Ej: 'recuerda que mi salario minimo es 1800000'.";
  return "Lo que ya se de ti:\n" + facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
}

export function factsBlock(): string {
  const facts = listFacts();
  if (!facts.length) return "";
  return [
    "DATOS QUE YA SABES DEL USUARIO (NO los vuelvas a preguntar ni a pedir de nuevo):",
    ...facts.map((f) => `- ${f.key}: ${f.value}`),
  ].join("\n");
}
