import * as cheerio from "cheerio";
import Groq from "groq-sdk";
import { getCandidateProfile } from "./cv.js";
import { registerTool } from "./registry.js";
import { hasApplied } from "../jobs/applications.js";
import { getConfig } from "../core/config.js";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-419,es;q=0.9,en;q=0.8",
};

const config = getConfig();
const groq = new Groq({ apiKey: config.GROQ_API_KEY });

async function evaluateCompatibility(titulo: string, detalle: string): Promise<{score: number, aplica: boolean, razon: string}> {
  const descripcionCorto = (detalle || "").slice(0, 1200);
  const prompt = `
Evalúa la afinidad técnica entre el perfil del candidato y la oferta laboral.

PERFIL DEL CANDIDATO:
${getCandidateProfile()}

OFERTA LABORAL:
Puesto: ${titulo}
Descripción: ${descripcionCorto}

CRITERIOS DE PUNTUACIÓN:
- Asigna score >= 75 si encaja con los conocimientos y roles del candidato.
- Asigna score < 60 si exige experiencia Senior/Semi-Senior (+2 años en desarrollo) o tecnologías ajenas al perfil.

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura:
{"score": 85, "aplica": true, "razon": "Explicación breve de máximo 15 palabras"}
`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "openai/gpt-oss-20b",
        temperature: 0.1,
        max_tokens: 1400,
      });
      const contenido = (completion.choices[0]?.message?.content || "").trim();
      const match = contenido.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {}
      }
      try {
        return JSON.parse(contenido);
      } catch {}
    } catch (err) {
      // retry
    }
  }
  return { score: 0, aplica: false, razon: "Error al procesar la respuesta" };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url: string): Promise<cheerio.CheerioAPI | null> {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const text = await res.text();
    return cheerio.load(text);
  } catch {
    return null;
  }
}

type Vacancy = {
  titulo: string;
  empresa: string;
  link: string;
  detalle: string;
  portal: string;
  score?: number;
  razon?: string;
};

export type { Vacancy };

let lastVacancies: Vacancy[] = [];

export function getLastVacancies(): Vacancy[] {
  return lastVacancies;
}

async function fetchDetailText(url: string): Promise<string> {
  const html = await fetchHtml(url);
  if (!html) return "";
  const $ = html;
  const selectors = [
    $("p.mbB").first(),
    $("div.fs16").first(),
    $("div.box_detail").first(),
  ];
  for (const sel of selectors) {
    const text = sel.text().trim();
    if (text) {
      return text;
    }
  }
  return "";
}

async function getComputrabajo(term: string): Promise<Vacancy[]> {
  const slug = term.replace(/\s+/g, "-").toLowerCase();
  const url = `https://co.computrabajo.com/trabajo-de-${slug}-en-bogota-dc`;
  const html = await fetchHtml(url);
  if (!html) return [];
  const $ = html;
  const items: Vacancy[] = [];
  $("article.box_offer").slice(0, 4).each((_, el) => {
    const a = $(el).find("a.js-o-link").first();
    if (!a.length) return;
    const titulo = a.text().trim();
    const href = a.attr("href") || "";
    const link = href.startsWith("http") ? href : `https://co.computrabajo.com${href}`;
    const empresa = $(el).find("p.fs16.text-ellipsis").first().text().trim() || "Confidencial";
    items.push({ titulo, empresa, link, detalle: "" /* fetched later */, portal: "Computrabajo" });
  });
  for (const item of items) {
    item.detalle = await fetchDetailText(item.link);
    await sleep(500);
  }
  return items;
}

async function getElEmpleo(term: string): Promise<Vacancy[]> {
  const slug = term.replace(/\s+/g, "-").toLowerCase();
  const url = `https://www.elempleo.com/co/ofertas-empleo/colombia/trabajo-${slug}`;
  const html = await fetchHtml(url);
  if (!html) return [];
  const $ = html;
  const items: Vacancy[] = [];
  const selectors = ["div.result-item", "div.item-result", "div.col-xs-12.js-offer", ".result-item", ".item-result", ".js-offer"];
  const elements: any[] = [];
  for (const s of selectors) {
    const found = $(s).slice(0, 4).toArray();
    if (found.length) { elements.push(...found); break; }
  }
  for (const el of elements.slice(0, 4)) {
    const $el = $(el);
    const aTag = $el.find("h2 a, h3 a").first()[0] || $el.find("a.js-view-offer, a.text-ellipsis").first()[0] || null;
    if (!aTag) continue;
    const $a = $(aTag);
    const titulo = $a.text().trim();
    if (!titulo || titulo.toLowerCase() === "ver oferta" || titulo.toLowerCase() === "postularme") continue;
    const href = $a.attr("href") || "";
    const link = href.startsWith("http") ? href : `https://www.elempleo.com${href}`;
    const empresa = $el.find(".info-company-name").first().text().trim() || "Confidencial";
    items.push({ titulo, empresa, link, detalle: "", portal: "El Empleo" });
  }
  for (const item of items) {
    try {
      const res = await fetch(item.link, { headers: HEADERS });
      const textHtml = await res.text();
      const $ = cheerio.load(textHtml);
      const container = $(".description-block, .offer-description, .js-description, .js-container-job-offer-description").first();
      const lines = container.text().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      item.detalle = lines.join("\n");
    } catch {}
    await sleep(500);
  }
  return items;
}

async function getMagneto(term: string): Promise<Vacancy[]> {
  const query = encodeURIComponent(term);
  const url = `https://api.magneto365.com/api/v1/jobs/search?query=${query}&country=co&limit=4`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    const items = (data.data || data.jobs || []) as any[];
    const result: Vacancy[] = [];
    for (const item of items.slice(0, 4)) {
      const titulo = item.name || item.title || "Confidencial";
      const slug = item.slug || "";
      const link = slug ? `https://www.magneto365.com/co/empleos/${slug}` : "https://www.magneto365.com/co";
      const empresa = (item.company && item.company.name) || "Confidencial";
      result.push({ titulo, empresa, link, detalle: item.description || item.requirements || "", portal: "Magneto" });
    }
    return result;
  } catch {
    return [];
  }
}

async function getLinkedIn(term: string): Promise<Vacancy[]> {
  const query = encodeURIComponent(term);
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${query}&location=Bogota,%20Colombia&start=0`;
  const html = await fetchHtml(url);
  if (!html) return [];
  const $ = html;
  const items: Vacancy[] = [];
  $("li").slice(0, 4).each((_, el) => {
    const tituloTag = $(el).find("h3.base-search-card__title").first();
    if (!tituloTag.length) return;
    const titulo = tituloTag.text().trim();
    const linkTag = $(el).find("a.base-card__full-link").first();
    const href = linkTag.attr("href") || "";
    const link = href ? href.split("?")[0] : "";
    const empresa = $(el).find("h4.base-search-card__subtitle").first().text().trim() || "Confidencial";
    if (!link) return;
    items.push({ titulo, empresa, link, detalle: titulo, portal: "LinkedIn" });
  });
  return items;
}

async function evaluateVacancy(vacancy: Vacancy): Promise<Vacancy> {
  const evaluation = await evaluateCompatibility(vacancy.titulo, vacancy.detalle);
  vacancy.score = evaluation.score;
  vacancy.razon = `[${vacancy.portal}] ${evaluation.razon}`;
  return vacancy;
}

async function searchAll(term: string): Promise<Vacancy[]> {
  const results: Vacancy[] = [];
  const [ct,ee,mg,li] = await Promise.all([
    getComputrabajo(term),
    getElEmpleo(term),
    getMagneto(term),
    getLinkedIn(term),
  ]);
  results.push(...ct, ...ee, ...mg, ...li);
  for (const v of results) {
    try {
      await evaluateVacancy(v);
    } catch {}
  }
  return results;
}

export const JOB_DEFAULT_TERMS = "qa tester, call center, backoffice, soporte tecnico";

function isRealVacancyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "example.com" || host.endsWith(".example.com")) return false;
    return host in PORTAL_POR_HOST || Object.keys(PORTAL_POR_HOST).some((h) => host.endsWith(`.${h}`) || `www.${host}` in PORTAL_POR_HOST);
  } catch {
    return false;
  }
}

const PORTAL_POR_HOST: Record<string, string> = {
  "co.computrabajo.com": "Computrabajo",
  "computrabajo.com": "Computrabajo",
  "www.elempleo.com": "El Empleo",
  "elempleo.com": "El Empleo",
  "www.magneto365.com": "Magneto",
  "magneto365.com": "Magneto",
  "www.linkedin.com": "LinkedIn",
  "linkedin.com": "LinkedIn",
};

export async function probeVacancy(url: string): Promise<{ titulo: string; empresa: string; portal: string }> {
  let portal = "desconocido";
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
    portal = PORTAL_POR_HOST[`www.${host}`] ?? PORTAL_POR_HOST[host] ?? host;
  } catch {
    // URL invalida
  }
  const html = await fetchHtml(url);
  if (!html) return { titulo: "(no pude leer la pagina)", empresa: "", portal };
  const $ = html;
  const titulo = (
    $('meta[property="og:title"]').attr("content") ||
    $("h1").first().text() ||
    $("title").text() ||
    "(sin titulo)"
  ).trim();
  const empresa = ($('meta[name="author"]').attr("content") || $(".company-name, .fs16").first().text() || "").trim();
  return { titulo: titulo.slice(0, 140), empresa: empresa.slice(0, 80), portal };
}

function splitTerms(terms: string | string[]): string[] {
  const arr = Array.isArray(terms) ? terms : terms.split(",");
  const clean = arr.map((t) => t.trim()).filter(Boolean);
  return clean.length ? clean : JOB_DEFAULT_TERMS.split(",").map((t) => t.trim());
}

export async function searchVacancies(terminos: string | string[]): Promise<Vacancy[]> {
  const all: Vacancy[] = [];
  for (const term of splitTerms(terminos)) {
    try {
      all.push(...(await searchAll(term)));
      await sleep(1000);
    } catch {
      // portal no disponible
    }
  }
  all.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const real = all.filter((v) => isRealVacancyUrl(v.link));
  lastVacancies = real;
  return real;
}

function marcaYaPostulada(v: Vacancy): string {
  try {
    return hasApplied(v.link) ? " [ya postulada]" : "";
  } catch {
    return "";
  }
}

async function runJobSearchTool(input: string): Promise<string> {
  const all = await searchVacancies(input);
  if (!all.length) return "No se encontraron vacantes para esos terminos.";
  const scored = all.filter((v) => (v.score ?? 0) >= 50);
  const low = all.filter((v) => (v.score ?? 0) < 50);
  let msg = `Encontre ${all.length} vacantes, ${scored.length} con score >=50.\n\n`;
  for (const v of scored.slice(0, 10)) {
    msg += `- ${v.titulo} (${v.empresa})${marcaYaPostulada(v)}\n    ${v.link}\n    Score: ${v.score} - ${v.razon}\n\n`;
  }
  if (low.length) {
    msg += ` (${low.length} vacantes omitidas por score < 50)`;
  }
  return msg;
}

registerTool({
  name: "jobsearch",
  description: "Busca vacantes en Computrabajo, El Empleo, Magneto y LinkedIn y las evalúa contra tu perfil.",
  risk: "green",
  channels: ["cli", "whatsapp"],
  handler: runJobSearchTool,
});
