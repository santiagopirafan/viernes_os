import { routeIntent, handleFastCommand } from "./router.js";
import { authenticate } from "../gateway/auth.js";
import { RateLimiter } from "../gateway/ratelimit.js";
import { getConfig } from "./config.js";
import { events } from "./events.js";
import { log } from "./logger.js";
import { askAgent, extractFacts, rememberFromMessage } from "./agent.js";
import { rememberFact, forgetFact, factsList } from "../memory/facts.js";
import { addTurn } from "../memory/context.js";
import { classify } from "./rules.js";
import { runTool, findTool } from "../tools/registry.js";
import "../tools/fs.read.js";
import "../tools/cv.js";
import "../tools/browser.js";
import "../tools/jobSearch.js";
import "../tools/finanzas.js";
import { startExecution, stepExecution, endExecution } from "./executionLog.js";
import { confirmarBorradorPendiente, guardarMovimiento, hayBorradorPendiente, parsearMovimientoTexto, borrarMovimiento, resumenDia } from "../finance/finance.js";
import { publicarEnGoogleSheets } from "../finance/googleSheets.js";
import { clasificarIntencion } from "./intent.js";
import { JOB_DEFAULT_TERMS, searchVacancies, getLastVacancies, probeVacancy, type Vacancy } from "../tools/jobSearch.js";
import { hasApplied } from "../jobs/applications.js";

let rateLimiter: RateLimiter | null = null;

interface OfferQueue {
  vacantes: Vacancy[];
  index: number;
  terminos: string;
  at: number;
}

let offerQueue: OfferQueue | null = null;
const QUEUE_TTL_MS = 30 * 60_000;

function queueExpired(): boolean {
  return offerQueue !== null && Date.now() - offerQueue.at > QUEUE_TTL_MS;
}

function closeQueue(): void {
  offerQueue = null;
}

function ofertasFiltradas(vacs: Vacancy[]): Vacancy[] {
  return vacs.filter((v) => (v.score ?? 0) >= 50);
}

function ofertaMsg(q: OfferQueue): string {
  const v = q.vacantes[q.index];
  const marca = hasApplied(v.link) ? " [ya postulada]" : "";
  return [
    `Oferta ${q.index + 1}/${q.vacantes.length}${marca} - Score ${v.score}/100`,
    `Titulo: ${v.titulo}`,
    `Empresa: ${v.empresa} | Portal: ${v.portal}`,
    `Por que encaja: ${v.razon ?? ""}`,
    `URL: ${v.link}`,
    "",
    "'siguiente' = la otra | 'postular' = ficha de esta | 'postular 3' = salta a la 3 | 'listo' = terminar",
  ].join("\n");
}

async function buscarYEntregar(terminos: string, channelId: string): Promise<string> {
  startExecution("buscar_vacantes", terminos);
  const todas = await searchVacancies(terminos);
  stepExecution(`Portales consultados, vacantes obtenidas: ${todas.length}`);
  const top = ofertasFiltradas(todas);
  endExecution("ok", `vacantes >=50: ${top.length}`);
  if (!top.length) {
    return todas.length
      ? `Encontre ${todas.length} vacantes pero ninguna supero score 50 contra tu CV. Prueba con otros terminos (ej: 'buscar: soporte tecnico').`
      : "No se encontraron vacantes para esos terminos.";
  }
  offerQueue = { vacantes: top, index: 0, terminos, at: Date.now() };
  const ya = top.filter((v) => hasApplied(v.link)).length;
  const intro = `Encontre ${top.length} vacantes con score >= 50${ya ? ` (${ya} ya las postulaste antes)` : ""}. Te mando una por una:\n\n`;
  return intro + ofertaMsg(offerQueue);
}

function fichaPostulacion(v: Vacancy): string {
  const ya = hasApplied(v.link);
  return [
    "POSTULACION PENDIENTE DE CONFIRMACION",
    "",
    `Titulo: ${v.titulo}`,
    `Empresa: ${v.empresa || "(no visible)"}`,
    `Portal: ${v.portal}`,
    v.score !== undefined
      ? `Score: ${v.score}/100 - ${v.razon ?? ""}`
      : "Score: sin evaluar (URL fuera de tu ultima busqueda)",
    `URL: ${v.link}`,
    ya ? "AVISO: ya postulaste a esta oferta antes." : "",
    "",
    "Hare: abrir la vacante en tu navegador -> clic en Postular -> adjuntar tu CV -> Enviar.",
    "",
    "Responde 'si' para postular o cualquier otra cosa para cancelar.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function resolverVacante(arg: string): Promise<{ vac: Vacancy } | { error: string }> {
  const guardadas = getLastVacancies();
  const fuente: Vacancy[] = offerQueue
    ? offerQueue.vacantes
    : guardadas.filter((v) => (v.score ?? 0) >= 50);
  const pool = fuente.length ? fuente : guardadas;
  const SIN_BUSQUEDA = "No tengo vacantes guardadas. Haz una busqueda primero: 'buscar: qa junior'.";

  if (!arg) {
    if (!pool.length) return { error: SIN_BUSQUEDA };
    const i = offerQueue ? offerQueue.index : 0;
    return { vac: pool[i] };
  }

  if (/^\d+$/.test(arg)) {
    if (!pool.length) return { error: SIN_BUSQUEDA };
    const n = Number(arg);
    if (n < 1 || n > pool.length) {
      return { error: `Solo hay ${pool.length} ofertas en tu ultima busqueda. Escribe un numero de 1 a ${pool.length}.` };
    }
    return { vac: pool[n - 1] };
  }

  const url = arg.replace(/[)\s,]+$/, "");
  const enLista = pool.find((v) => v.link === url || v.link.split("?")[0] === url);
  if (enLista) return { vac: enLista };

  const probe = await probeVacancy(url);
  return { vac: { titulo: probe.titulo, empresa: probe.empresa, portal: probe.portal, link: url, detalle: "" } };
}

function getRateLimiter(): RateLimiter {
  if (rateLimiter === null) {
    const c = getConfig();
    rateLimiter = new RateLimiter(c.CLI_RATE_LIMIT, c.rateLimitWindowMs);
  }
  return rateLimiter;
}

type PendingConfirm =
  | { kind: "tool"; name: string; input: string }
  | { kind: "prompt"; prompt: string };

let pendingConfirm: PendingConfirm | null = null;
let lastJobSearchAt = 0;

const CRITERIA_HINT = /(junior|juniors|semisenior|semi-senior|salario|sueldo|ubicaci|remoto|presencial|bogot|tiempo completo|media jornada|jornada|full ?time)/;

const JOB_KEYWORD = /(empleos?|trabajos?|vacantes?|postulaciones?|postulate|postular|ofertas? laborales?)/;
const SEARCH_VERB = /(busca|busca[rn]?|búscame|buscame|empieza|empeza|inicia|revisa|consulta|encuentra|necesito|quiero|dame|mu[eé]strame|ver|revisar)/;
const APPLY_VERB = /(postula[rn]?|aplica[rn]?|envi[ae]r?|manda[rn]?|inscrib|reg[íi]strate)/;

export type JobIntent = { terms: string; wantsApply: boolean };

export function matchJobSearch(text: string): JobIntent | null {
  const t = text.toLowerCase().trim();
  if (!JOB_KEYWORD.test(t)) return null;
  const wantsApply = APPLY_VERB.test(t);
  if (!SEARCH_VERB.test(t) && !wantsApply) return null;
  const terms = /(?:empleos?|trabajos?|vacantes?|postulaciones?|postulate|postular|ofertas? laborales?)(?:\s+(?:de|para|en|sobre|del))\s+(.+)$/.exec(t);
  const clean = terms && terms[1] ? terms[1].replace(/\s+(en|de|para)\s+bogota.*$/, "").trim() : JOB_DEFAULT_TERMS;
  return { terms: clean, wantsApply };
}


export async function handleMessage(input: string, channelId: string): Promise<string> {
  const auth = authenticate(channelId);
  if (!auth) {
    return "Acceso denegado: canal no autorizado.";
  }

  if (!getRateLimiter().allow()) {
    log("warn", `Rate limit superado en canal ${channelId}`);
    return "Límite de mensajes excedido. Espera un momento antes de enviar otro.";
  }

  const text = input.trim();
  events.publish({ type: "message:in", content: text, ts: Date.now(), channel: channelId });
  addTurn("user", text, channelId);

  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hello|hi|que tal|qué tal|cómo estás|como estas)\s*[!.?]*$/i.test(text)) {
    const bienvenida = [
      "Hola, soy Viernes. Te ayudo con finanzas y empleo.",
      "",
      "Finanzas (Rappi/Didi/Uber):",
      "- ingreso rappi 45000 viaje",
      "- egreso gasolina 20000",
      "- /finanzas hoy, /finanzas ultimos, /finanzas exportar, /finanzas publicar",
      "- Envíame una captura y la guardo de una vez; si algo queda mal dime 'elimina el movimiento N'.",
      "- También acepto notas de voz: las transcribo y ejecuto tu pedido.",
      "",
      "Empleo:",
      "- buscar: qa junior",
      "- siguiente, postular 1, 'si' para confirmar.",
      "",
      "Dime qué quieres hacer: registrar, ver balance o buscar ofertas.",
    ].join("\n");
    events.publish({ type: "message:out", content: bienvenida, ts: Date.now(), channel: channelId });
    return bienvenida;
  }

  const memCmd = /^\/memory\s+(guardar|set|borrar|del|olvidar)\s+(.+)$/i.exec(text);
  if (memCmd) {
    const action = memCmd[1].toLowerCase();
    const rest = memCmd[2];
    let response: string;
    if (action === "guardar" || action === "set") {
      const split = rest.split(/[:=]/);
      response = split.length > 1 ? rememberFact(split[0], split.slice(1).join(":")) : "Formato: /memory guardar clave: valor";
    } else {
      response = forgetFact(rest.split(/[:=]/)[0]);
    }
    events.publish({ type: "message:out", content: response, ts: Date.now(), channel: channelId });
    return response;
  }

  const recuerdaCmd = /^(?:recuerda(?: que)?|acuerdate(?: de)?|guarda que|remember[:,]?)\s+(.+)$/i.exec(text);
  if (recuerdaCmd) {
    const payload = recuerdaCmd[1];
    try {
      const extracted = await extractFacts(payload);
      if (extracted.length) {
        const guardados = extracted.map((f) => rememberFact(f.k, f.v));
        const response = "Guardado, no lo vuelvo a preguntar:\n" + guardados.map((g) => `- ${g}`).join("\n");
        events.publish({ type: "message:out", content: response, ts: Date.now(), channel: channelId });
        return response;
      }
    } catch (err) {
      log("warn", `Extraccion de 'recuerda' fallo: ${String(err).slice(0, 120)}`);
    }
    const response = rememberFact("nota", payload);
    events.publish({ type: "message:out", content: response, ts: Date.now(), channel: channelId });
    return response;
  }

  const esCola = /^(?:usa\s+browser\s+)?postular(\s|$)|^(siguiente|sigue|otra|otro|listo|terminar|termina|salir|cambiar|no|ya)$/i.test(text);
  if (!esCola) void rememberFromMessage(text);

  const route = routeIntent(text);
  if (route.kind === "fast") {
    const response = await handleFastCommand(route.command, channelId);
    events.publish({ type: "message:out", content: response, ts: Date.now(), channel: channelId });
    return response;
  }

  const esPostular = /^(?:usa\s+browser\s+)?postular(\s|$)/i.test(text);

  if (pendingConfirm !== null && !esPostular) {
    const lower = text.toLowerCase();
    if (lower === "si" || lower === "confirmar" || lower === "yes") {
      const pending = pendingConfirm;
      pendingConfirm = null;
      if (pending.kind === "tool") {
        stepExecution(`Confirmacion recibida: ${pending.name} ${pending.input}`);
        const out = await runTool(pending.name, pending.input, channelId);
        endExecution("ok", out.includes("fallida") ? "postulacion fallida" : "postulacion registrada");
        const cola = offerQueue
          ? `\n\nSigues en la revision: 'siguiente' para la otra oferta o 'listo' para terminar.`
          : "";
        const final = out + cola;
        events.publish({ type: "message:out", content: final, ts: Date.now(), channel: channelId });
        return final;
      }
      const out = await askAgent(pending.prompt);
      events.publish({ type: "message:out", content: out, ts: Date.now(), channel: channelId });
      return out;
    }
    pendingConfirm = null;
    const msg = "Acción cancelada por el operador.";
    events.publish({ type: "message:out", content: msg, ts: Date.now(), channel: channelId });
    return msg;
  }

  if (/^(si|sí|confirmar|yes)$/i.test(text)) {
    if (hayBorradorPendiente(channelId)) {
      const out = confirmarBorradorPendiente(channelId);
      events.publish({ type: "message:out", content: out, ts: Date.now(), channel: channelId });
      return out;
    }
    const msg = "No tengo ninguna postulacion pendiente de confirmacion.";
    events.publish({ type: "message:out", content: msg, ts: Date.now(), channel: channelId });
    return msg;
  }

  const prompt = route.prompt;

  if (/^finanzas(\s|$)/i.test(prompt)) {
    const out = await handleFastCommand(prompt.toLowerCase(), channelId);
    events.publish({ type: "message:out", content: out, ts: Date.now(), channel: channelId });
    return out;
  }

  const borradorFinanciero = parsearMovimientoTexto(prompt);
  if (borradorFinanciero) {
    const id = guardarMovimiento({ ...borradorFinanciero, origen: channelId });
    const out = `Movimiento financiero guardado #${id}.`;
    events.publish({ type: "message:out", content: out, ts: Date.now(), channel: channelId });
    return out;
  }

  if (/(elimin|borr|suprim|limpi|vaciar)/i.test(prompt)) {
    const out = borrarMovimiento(prompt);
    if (out) {
      events.publish({ type: "message:out", content: out, ts: Date.now(), channel: channelId });
      return out;
    }
  }

  if (queueExpired()) closeQueue();

  const accionCola =
    /^(siguiente|sigue|otra|otro|no|listo|ya|terminar|termina|salir|cambiar)$/i.exec(prompt);
  if (offerQueue && accionCola) {
    const acc = accionCola[1].toLowerCase();
    const terminar = ["listo", "terminar", "termina", "salir", "ya", "cambiar"].includes(acc);
    if (terminar) {
      const n = offerQueue.vacantes.length;
      closeQueue();
      const msg = `Revision terminada. Revisaste ${n} ofertas de la ultima busqueda. Usa '/empleo' para ver tus postulaciones.`;
      events.publish({ type: "message:out", content: msg, ts: Date.now(), channel: channelId });
      return msg;
    }
    if (offerQueue.index + 1 >= offerQueue.vacantes.length) {
      const msg = `Ya viste las ${offerQueue.vacantes.length} ofertas de esta busqueda. Escribe 'postular N' para postularte a alguna, 'listo' para terminar o 'buscar: ...' para otra ronda.`;
      offerQueue.at = Date.now();
      events.publish({ type: "message:out", content: msg, ts: Date.now(), channel: channelId });
      return msg;
    }
    offerQueue.index += 1;
    offerQueue.at = Date.now();
    const msg = ofertaMsg(offerQueue);
    events.publish({ type: "message:out", content: msg, ts: Date.now(), channel: channelId });
    return msg;
  }

  const postularCmd = /^(?:usa\s+browser\s+)?postular(?:\s+(.+))?$/i.exec(prompt);
  if (postularCmd) {
    const arg = (postularCmd[1] ?? "").trim();
    const res = await resolverVacante(arg);
    if ("error" in res) {
      events.publish({ type: "message:out", content: res.error, ts: Date.now(), channel: channelId });
      return res.error;
    }
    pendingConfirm = null;
    startExecution("postulacion_directa", res.vac.link);
    stepExecution(`Vacante: ${res.vac.titulo} | Portal: ${res.vac.portal} | Score: ${res.vac.score ?? "N/A"}`);
    const out = await runTool("browser", `postular ${res.vac.link}`, channelId);
    endExecution("ok", out.includes("fallida") ? "postulacion fallida" : "postulacion ejecutada");
    const cola = offerQueue
      ? `\n\nSigues en la revision: 'siguiente' para la otra oferta o 'listo' para terminar.`
      : "";
    const final = out + cola;
    events.publish({ type: "message:out", content: final, ts: Date.now(), channel: channelId });
    return final;
  }

  const colaHuerfana = /^(siguiente|sigue|otra|otro|listo|terminar|termina|salir|cambiar)$/i.exec(prompt);
  if (colaHuerfana) {
    const msg = "No estoy revisando ofertas ahora. Haz una busqueda primero: 'buscar: qa junior'.";
    events.publish({ type: "message:out", content: msg, ts: Date.now(), channel: channelId });
    return msg;
  }

  if (offerQueue) closeQueue();

  const toolCmd = /^usa\s+([a-z._]+)\s+(.+)$/i.exec(prompt);
  if (toolCmd) {
    const name = toolCmd[1].toLowerCase();
    const toolInput = toolCmd[2];
    const tool = findTool(name);
    if (!tool) {
      return `Error: la herramienta '${name}' no existe. Usa /tools para ver las disponibles.`;
    }
    if (tool.risk === "red") {
      events.publish({ type: "risk:blocked", reason: `Ejecución de ${name} (nivel Rojo)`, ts: Date.now(), channel: channelId });
      log("warn", `Acción Rojo bloqueada: ${name}`);
      return `BLOQUEADO: la herramienta '${name}' es nivel Rojo según OPERATING_AGREEMENT.md.`;
    }
    if (tool.risk === "yellow") {
      pendingConfirm = { kind: "tool", name, input: toolInput };
      return `Nivel Amarillo: requiere confirmación. Escribe 'si' para ejecutar '${name}' o cualquier otra cosa para cancelar.`;
    }
    const out = await runTool(name, toolInput, channelId);
    events.publish({ type: "message:out", content: out, ts: Date.now(), channel: channelId });
    return out;
  }

  const buscarCmd = /^(?:buscar:|busca:|ofertas de)\s+(.+)$/i.exec(prompt);
  if (buscarCmd) {
    const out = await buscarYEntregar(buscarCmd[1], channelId);
    events.publish({ type: "message:out", content: out, ts: Date.now(), channel: channelId });
    return out;
  }

  const jobIntent = matchJobSearch(prompt);
  if (jobIntent) {
    lastJobSearchAt = Date.now();
    rememberFact("criterios_busqueda", jobIntent.terms);
    const out = await buscarYEntregar(jobIntent.terms, channelId);
    events.publish({ type: "message:out", content: out, ts: Date.now(), channel: channelId });
    return out;
  }

  const isCriteriaFollowUp =
    lastJobSearchAt > 0 &&
    Date.now() - lastJobSearchAt < 10 * 60_000 &&
    CRITERIA_HINT.test(prompt.toLowerCase());
  if (isCriteriaFollowUp) {
    lastJobSearchAt = Date.now();
    rememberFact("criterios_busqueda", prompt);
    const out = await buscarYEntregar(JOB_DEFAULT_TERMS, channelId);
    const final = `Criterios registrados: "${prompt}".\n\n${out}`;
    events.publish({ type: "message:out", content: final, ts: Date.now(), channel: channelId });
    return final;
  }

  const intencion = await clasificarIntencion(prompt);
  if (intencion.accion !== "conversar") {
    let salida: string | null = null;
    if (intencion.accion === "finanzas_agregar") {
      const b = parsearMovimientoTexto(intencion.texto);
      salida = b
        ? `Movimiento financiero guardado #${guardarMovimiento({ ...b, origen: channelId })}.`
        : "No encontré un valor en tu mensaje. Dime el monto, ejemplo: 'gasté 8000 en desayuno'.";
    } else if (intencion.accion === "finanzas_borrar") {
      salida = borrarMovimiento(intencion.objetivo) || null;
    } else if (intencion.accion === "finanzas_resumen") {
      salida = resumenDia(intencion.fecha);
    } else if (intencion.accion === "finanzas_publicar") {
      try {
        salida = await publicarEnGoogleSheets();
      } catch (err) {
        salida = `No pude publicar en Google Sheets: ${String(err).replace(/^Error:\s*/, "").slice(0, 300)}`;
      }
    } else if (intencion.accion === "empleo_buscar") {
      lastJobSearchAt = Date.now();
      rememberFact("criterios_busqueda", intencion.terminos);
      salida = await buscarYEntregar(intencion.terminos, channelId);
    }
    if (salida !== null) {
      events.publish({ type: "message:out", content: salida, ts: Date.now(), channel: channelId });
      return salida;
    }
  }

  const risk = classify(prompt);
  if (risk === "red") {
    events.publish({ type: "risk:blocked", reason: "Prompt clasificado como nivel Rojo", ts: Date.now(), channel: channelId });
    log("warn", `Prompt bloqueado (Rojo): ${prompt.slice(0, 60)}`);
    return "BLOQUEADO por nivel de riesgo Rojo (ej. borrado, publicación externa, secretos en texto plano).";
  }
  if (risk === "yellow") {
    pendingConfirm = { kind: "prompt", prompt };
    return "Este pedido se clasifica como nivel Amarillo (modifica datos o usa APIs externas). ¿Confirmas? Escribe 'si' o cualquier otra cosa para cancelar.";
  }

  const answer = await askAgent(prompt);
  events.publish({ type: "message:out", content: answer, ts: Date.now(), channel: channelId });
  return answer;
}
