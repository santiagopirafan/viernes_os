import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";
import {
  borrarMovimientoFinanciero,
  borrarTodosMovimientosFinancieros,
  existeMovimientoDuplicado,
  insertMovimientoFinanciero,
  listMetasFinancieras,
  listMovimientosFinancieros,
  resumenFinancieroPorFecha,
  resumenFinancieroPorPlataforma,
  ultimoMovimientoFinanciero,
  upsertMetaFinanciera,
  upsertPresupuestoFinanciero,
} from "../memory/sqlite.js";
import { endExecution, startExecution, stepExecution } from "../core/executionLog.js";
import { log } from "../core/logger.js";
import { publicarEnGoogleSheets } from "./googleSheets.js";

export function sincronizarGoogleSheets(fecha: string): void {
  void publicarEnGoogleSheets(fecha)
    .then(() => stepExecution("Google Sheets sincronizado en tiempo real"))
    .catch((err) => log("warn", `Sincronización con Google Sheets falló: ${String(err).slice(0, 200)}`));
}

const ROOT = path.resolve(process.cwd());
const FINANCE_DIR = path.join(ROOT, "data", "finance");
const EVIDENCE_DIR = path.join(FINANCE_DIR, "evidencias");
const EXPORT_DIR = path.join(FINANCE_DIR, "exports");

export const PLATAFORMAS = ["rappi", "didi", "uber", "otra"] as const;
export const CATEGORIAS_INGRESO = ["viaje", "propina", "bono", "transferencia", "otro"] as const;
export const CATEGORIAS_EGRESO = ["gasolina", "datos", "comida", "mantenimiento", "comision", "otro"] as const;

const ENTIDADES: [string, string][] = [
  ["bancolombia", "Bancolombia"],
  ["banco de bogota", "Banco de Bogotá"],
  ["davivienda", "Davivienda"],
  ["daviplata", "DaviPlata"],
  ["bbva", "BBVA"],
  ["banco de occidente", "Banco de Occidente"],
  ["banco popular", "Banco Popular"],
  ["banco av villas", "AV Villas"],
  ["av villas", "AV Villas"],
  ["itau", "Itaú"],
  ["scotiabank", "Scotiabank"],
  ["colpatria", "Scotiabank Colpatria"],
  ["falabella", "Banco Falabella"],
  ["pichincha", "Banco Pichincha"],
  ["caja social", "Banco Caja Social"],
  ["banco agrario", "Banco Agrario"],
  ["santander", "Santander"],
  ["lulo", "Lulo Bank"],
  ["nu bank", "Nu"],
  ["nequi", "Nequi"],
  ["llave", "Llave"],
  ["ahorro a la mano", "Ahorro a la Mano"],
  ["movii", "Movii"],
  ["dale", "Dale"],
];

function entidadesMencionadas(texto: string): string[] {
  const t = ` ${normalizarTexto(texto)} `;
  const halladas: string[] = [];
  for (const [clave, nombre] of ENTIDADES) {
    if (t.includes(` ${clave} `) && !halladas.includes(nombre)) halladas.push(nombre);
  }
  return halladas;
}

function entidadTras(texto: string, marcadores: string[]): string | null {
  const t = normalizarTexto(texto);
  for (const m of marcadores) {
    const re = new RegExp(`${m}\\s*:?\\s*([a-z ]{3,40})`);
    const match = re.exec(t);
    if (match) {
      const candidatas = ENTIDADES.filter(([clave]) => match[1].includes(clave))
        .map(([clave, nombre]) => ({ nombre, pos: match[1].indexOf(clave), len: clave.length }))
        .sort((a, b) => a.pos - b.pos || b.len - a.len);
      if (candidatas.length) return candidatas[0].nombre;
    }
  }
  return null;
}

export interface TransferenciaDetectada {
  valorCop: number | null;
  origen: string;
  destino: string;
  tipo: "ingreso" | "egreso";
}

function valorConSignoPeso(texto: string): number | null {
  const re = /\$[\s]*(\d[\d.,]*)/g;
  let mejor: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const digitos = m[1].replace(/[.,]/g, "");
    if (digitos.length < 3 || digitos.length > 12) continue;
    if (/^3\d{9}$/.test(digitos)) continue; // parece teléfono, no valor
    const valor = Number(digitos);
    if (Number.isFinite(valor) && valor > 0 && (mejor === null || valor > mejor)) mejor = valor;
  }
  return mejor;
}

export function analizarTransferencia(texto: string): TransferenciaDetectada {
  const t = normalizarTexto(texto);
  const valorCop = valorConSignoPeso(texto) ?? valorPorEtiqueta(texto);
  const mencionadas = entidadesMencionadas(texto);
  if (/inicio[\s\S]{0,60}transacciones[\s\S]{0,60}explorar[\s\S]{0,60}tramites/.test(t) && !mencionadas.length) {
    mencionadas.push("Bancolombia");
  }
  const origen =
    entidadTras(texto, ["\\bde\\b", "origen", "desde", "banco origen", "enviado por"]) ?? mencionadas[0] ?? "desconocido";
  const destino =
    entidadTras(texto, ["\\bpara\\b", "destino", "\\bhacia\\b", "destinatario", "cuenta destino", "recibido en"]) ??
    [...mencionadas].reverse().find((e) => e !== origen) ??
    (mencionadas[0] && mencionadas[0] !== origen ? mencionadas[0] : "desconocido");
  const tipo: "ingreso" | "egreso" = /enviast|transferiste|pagaste|pago realizado|retiro/.test(t) ? "egreso" : "ingreso";
  return { valorCop, origen, destino, tipo };
}

export interface BorradorMovimiento {
  fecha: string;
  tipo: "ingreso" | "egreso";
  plataforma: string;
  categoria: string;
  valorCop: number;
  nota: string;
  origen: string;
  evidencia: string;
  confianza: "alta" | "media" | "baja";
}

const borradoresPorCanal = new Map<string, BorradorMovimiento>();

function hoyISO(fecha = new Date()): string {
  return fecha.toISOString().slice(0, 10);
}

export function formatoCOP(valor: number): string {
  return `$${Math.round(valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

function normalizarTexto(valor: string): string {
  return valor
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function plataformaDesdeTexto(texto: string): string {
  const t = normalizarTexto(texto);
  if (t.includes("rappi")) return "rappi";
  if (t.includes("didi")) return "didi";
  if (t.includes("uber")) return "uber";
  return "otra";
}

function categoriaDesdeTexto(texto: string, tipo: "ingreso" | "egreso"): string {
  const t = normalizarTexto(texto);
  if (tipo === "ingreso") {
    if (t.includes("transferencia") || t.includes("comprobante") || t.includes("consignacion") || t.includes("abono")) return "transferencia";
    if (t.includes("propina")) return "propina";
    if (t.includes("bono") || t.includes("incentivo")) return "bono";
    if (t.includes("viaje") || t.includes("pedido") || t.includes("servicio") || t.includes("carrera")) return "viaje";
    return "otro";
  }
  if (t.includes("gasolina") || t.includes("combustible")) return "gasolina";
  if (t.includes("datos") || t.includes("internet") || t.includes("plan")) return "datos";
  if (t.includes("comida") || t.includes("desayuno") || t.includes("almuerzo") || t.includes("cena") || t.includes("comer")) return "comida";
  if (t.includes("mantenimiento") || t.includes("taller") || t.includes("repuesto") || t.includes("llanta")) return "mantenimiento";
  if (t.includes("comision")) return "comision";
  return "otro";
}

function valorDesdeTexto(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, " ").replace(/\s+/g, " ").trim();
  const candidatos = limpio.match(/\d[\d.,]*\d|\d/g) ?? [];
  let mejor: number | null = null;
  for (const candidato of candidatos) {
    const soloDigitos = candidato.replace(/[.,]/g, "");
    if (soloDigitos.length < 3) continue;
    const valor = Number(soloDigitos);
    if (Number.isFinite(valor) && valor > 0 && (mejor === null || valor > mejor)) mejor = valor;
  }
  return mejor;
}

export function parsearMovimientoTexto(input: string): BorradorMovimiento | null {
  const texto = input.trim();
  const normalizado = normalizarTexto(texto);
  const tipo = /\bingreso\b/.test(normalizado)
    ? "ingreso"
    : /\begreso\b|\bgasto\b|\bgaste\b/.test(normalizado)
      ? "egreso"
      : null;
  if (!tipo) return null;
  const valorCop = valorDesdeTexto(texto);
  if (valorCop === null) return null;
  const plataforma = plataformaDesdeTexto(texto);
  return {
    fecha: hoyISO(),
    tipo,
    plataforma,
    categoria: categoriaDesdeTexto(texto, tipo),
    valorCop,
    nota: texto.slice(0, 160),
    origen: "texto",
    evidencia: "",
    confianza: plataforma === "otra" ? "media" : "alta",
  };
}

export function guardarMovimiento(borrador: BorradorMovimiento, origen = borrador.origen): number {
  startExecution("finanzas_guardar", `${borrador.tipo} ${borrador.plataforma} ${borrador.valorCop}`);
  if (borrador.valorCop <= 0) {
    endExecution("error", "valor invalido");
    throw new Error("Valor inválido. Usa un valor mayor que cero en COP.");
  }
  if (borrador.evidencia && existeMovimientoDuplicado(borrador.fecha, borrador.plataforma, borrador.valorCop, borrador.evidencia)) {
    endExecution("error", "movimiento duplicado");
    throw new Error("Ese movimiento ya estaba registrado con la misma evidencia.");
  }
  const id = insertMovimientoFinanciero({
    fecha: borrador.fecha,
    tipo: borrador.tipo,
    plataforma: borrador.plataforma,
    categoria: borrador.categoria,
    valor_cop: Math.round(borrador.valorCop),
    nota: borrador.nota,
    origen,
    estado: "confirmado",
    evidencia: borrador.evidencia,
  });
  stepExecution(`Movimiento ${id} guardado en SQLite`);
  sincronizarGoogleSheets(borrador.fecha);
  endExecution("ok", `movimiento ${id}`);
  return id;
}

export function resumenDia(fecha = hoyISO()): string {
  const totales = resumenFinancieroPorFecha(fecha);
  const ingresos = totales.find((t) => t.tipo === "ingreso")?.total ?? 0;
  const egresos = totales.find((t) => t.tipo === "egreso")?.total ?? 0;
  const plataformas = resumenFinancieroPorPlataforma(fecha);
  const lineas = [
    `Finanzas ${fecha}`,
    `Ingresos: ${formatoCOP(ingresos)}`,
    `Egresos: ${formatoCOP(egresos)}`,
    `Balance: ${formatoCOP(ingresos - egresos)}`,
    "",
    "Por plataforma:",
    ...(plataformas.length ? plataformas.map((p) => `- ${p.plataforma}: ${formatoCOP(p.total)}`) : ["- sin ingresos registrados"]),
  ];
  return lineas.join("\n");
}

export function ultimosMovimientos(limit = 10): string {
  const items = listMovimientosFinancieros(limit);
  if (!items.length) return "Sin movimientos financieros registrados.";
  return items
    .map((m) => `- ${m.fecha} ${m.tipo} ${m.plataforma}/${m.categoria}: ${formatoCOP(m.valor_cop)} [${m.estado}]`)
    .join("\n");
}

export function crearMeta(input: string): string {
  const m = /meta\s+crear\s+([a-z]+)?\s*(\d[\d.,]*)/i.exec(input);
  if (!m) return "Formato: /finanzas meta crear rappi 60000 diario";
  const plataforma = (m[1] ?? "todas").toLowerCase();
  const valor = Number((m[2] ?? "").replace(/[.,]/g, ""));
  if (!Number.isFinite(valor) || valor <= 0) return "Meta inválida.";
  const fecha = hoyISO();
  const id = upsertMetaFinanciera({
    nombre: `Meta ${plataforma} ${fecha}`,
    plataforma,
    valorMetaCop: valor,
    periodo: "diario",
    fechaInicio: fecha,
    fechaFin: fecha,
  });
  sincronizarGoogleSheets(fecha);
  return `Meta creada #${id}: ${plataforma} ${formatoCOP(valor)} (${fecha}).`;
}

export function crearPresupuesto(input: string): string {
  const m = /presupuesto\s+([a-z]+)\s+(\d[\d.,]*)/i.exec(input);
  if (!m) return "Formato: /finanzas presupuesto gasolina 20000";
  const categoria = (m[1] ?? "").toLowerCase();
  const limite = Number((m[2] ?? "").replace(/[.,]/g, ""));
  if (!Number.isFinite(limite) || limite <= 0) return "Presupuesto inválido.";
  upsertPresupuestoFinanciero(categoria, limite, "diario");
  sincronizarGoogleSheets(hoyISO());
  return `Presupuesto diario creado: ${categoria} ${formatoCOP(limite)}.`;
}

export function exportarParaPowerBI(fecha = hoyISO()): string {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const movimientos = listMovimientosFinancieros(1000);
  const csv = [
    "id,fecha,tipo,plataforma,categoria,valor_cop,nota,origen,estado,evidencia,ts",
    ...movimientos.map((m) =>
      [
        m.id,
        m.fecha,
        m.tipo,
        m.plataforma,
        m.categoria,
        m.valor_cop,
        `"${m.nota.replace(/"/g, "'")}"`,
        m.origen,
        m.estado,
        m.evidencia,
        m.ts,
      ].join(",")
    ),
  ].join("\n");
  const resumen = [
    "fecha,plataforma,total_ingresos_cop",
    ...resumenFinancieroPorPlataforma(fecha).map((p) => `${fecha},${p.plataforma},${p.total}`),
  ].join("\n");
  const metas = [
    "id,nombre,plataforma,valor_meta_cop,periodo,fecha_inicio,fecha_fin,activa",
    ...listMetasFinancieras().map((meta) =>
      [meta.id, meta.nombre, meta.plataforma, meta.valor_meta_cop, meta.periodo, meta.fecha_inicio, meta.fecha_fin, meta.activa].join(",")
    ),
  ].join("\n");
  const archivos = {
    movimientos: path.join(EXPORT_DIR, `finanzas-movimientos-${fecha}.csv`),
    resumen: path.join(EXPORT_DIR, `finanzas-resumen-${fecha}.csv`),
    metas: path.join(EXPORT_DIR, `finanzas-metas-${fecha}.csv`),
  };
  fs.writeFileSync(archivos.movimientos, csv, "utf8");
  fs.writeFileSync(archivos.resumen, resumen, "utf8");
  fs.writeFileSync(archivos.metas, metas, "utf8");
  log("info", `Exportación financiera lista: ${archivos.movimientos}`);
  return `Exportado para Power BI:\n- ${archivos.movimientos}\n- ${archivos.resumen}\n- ${archivos.metas}`;
}

async function ocrImagen(buffer: Buffer): Promise<string> {
  startExecution("finanzas_ocr", `${buffer.length} bytes`);
  const mejorada = await sharp(buffer).resize({ width: 1600, withoutEnlargement: false }).grayscale().normalize().sharpen().toBuffer();
  const worker = await createWorker(["spa", "eng"]);
  await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  try {
    const resultado = await worker.recognize(mejorada);
    const texto = (resultado.data.text ?? "").trim();
    stepExecution(`OCR extrajo ${texto.length} caracteres`);
    endExecution(texto ? "ok" : "error", "ocr captura");
    return texto;
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

function valorPorEtiqueta(texto: string): number | null {
  const lineas = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const idx = lineas.findIndex((l) => /valor de la transferencia/i.test(l));
  if (idx === -1) return null;
  let mejor: number | null = null;
  for (const linea of lineas.slice(idx + 1, idx + 5)) {
    if (/costo/i.test(linea)) continue;
    for (const m of linea.matchAll(/(\d[\d.,]*)/g)) {
      const digitos = m[1].replace(/[.,]/g, "");
      if (digitos.length < 3 || digitos.length > 12) continue;
      if (/^3\d{9}$/.test(digitos)) continue;
      if (/^\d{7}$/.test(digitos)) continue;
      const valor = Number(digitos);
      if (Number.isFinite(valor) && valor > 0 && (mejor === null || valor > mejor)) mejor = valor;
    }
    if (mejor !== null) break;
  }
  return mejor;
}

export function guardarEvidencia(buffer: Buffer, nombre = "captura.png"): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const ruta = path.join(EVIDENCE_DIR, `${Date.now()}-${nombre.replace(/[^a-z0-9._-]+/gi, "-")}`);
  fs.writeFileSync(ruta, buffer);
  return ruta;
}

export async function proponerMovimientoDesdeCaptura(
  canal: string,
  buffer: Buffer,
  pista = ""
): Promise<string> {
  const evidencia = guardarEvidencia(buffer);
  stepExecution(`Evidencia guardada: ${evidencia}`);
  const texto = await ocrImagen(buffer);
  const combinado = `${pista}\n${texto}`;
  const transferencia = analizarTransferencia(combinado);
  const valorCop = transferencia.valorCop;
  const esTransferencia = /transferencia|comprobante|consignacion|abono|nequi|llave|daviplata|bancolombia|davivienda|bbva/i.test(combinado);
  if (valorCop === null) {
    borradoresPorCanal.delete(canal);
    return `Recibí la captura, pero no encontré un valor con signo $.\nEvidencia: ${evidencia}\nRespóndeme con el valor, ejemplo: "ingreso transferencia 50000".`;
  }
  const tipo = esTransferencia ? transferencia.tipo : "ingreso";
  const borrador: BorradorMovimiento = {
    fecha: hoyISO(),
    tipo,
    plataforma: "otra",
    categoria: esTransferencia ? "transferencia" : categoriaDesdeTexto(combinado, tipo),
    valorCop,
    nota: esTransferencia
      ? transferencia.origen !== "desconocido" || transferencia.destino !== "desconocido"
        ? `Transferencia ${transferencia.origen} → ${transferencia.destino} ${formatoCOP(valorCop)}`
        : `Transferencia ${formatoCOP(valorCop)} (origen/destino no detectados, ver evidencia)`
      : `Captura ${plataformaDesdeTexto(combinado)} ${formatoCOP(valorCop)}`,
    origen: "whatsapp_captura",
    evidencia,
    confianza: transferencia.origen !== "desconocido" && transferencia.destino !== "desconocido" ? "alta" : "media",
  };
  borradoresPorCanal.delete(canal);
  const id = guardarMovimiento(borrador);
  return [
    `Movimiento guardado #${id}: ${borrador.tipo} ${borrador.plataforma}/${borrador.categoria} ${formatoCOP(borrador.valorCop)}.`,
    "Hoja actualizada en tiempo real.",
    `Si algo quedó mal, dime "elimina el movimiento ${id}".`,
  ].join("\n");
}

export function hayBorradorPendiente(canal: string): boolean {
  return borradoresPorCanal.has(canal);
}

export function confirmarBorradorPendiente(canal: string): string {
  const borrador = borradoresPorCanal.get(canal);
  if (!borrador) return "No hay propuesta financiera pendiente.";
  const id = guardarMovimiento(borrador);
  borradoresPorCanal.delete(canal);
  return `Movimiento guardado #${id}: ${borrador.tipo} ${borrador.plataforma} ${formatoCOP(borrador.valorCop)}.`;
}

export function cancelarBorradorPendiente(canal: string): string {
  if (!borradoresPorCanal.delete(canal)) return "No había propuesta pendiente.";
  return "Propuesta financiera descartada.";
}

export function borrarMovimiento(input: string): string {
  const t = normalizarTexto(input);
  if (!/elimin|borr|suprim|limpi|vaciar/.test(t)) return "";
  const mencionaFinanza = /movimiento|gasto|ingreso|egreso|registro|finanza/.test(t);
  const esTotal = /tod|limpia|tabla|datos/.test(t);
  if (!mencionaFinanza && !esTotal) return "";
  if (esTotal && !/ultim|#\s*\d+|movimiento\s*#?\s*\d+/.test(t)) {
    startExecution("finanzas_borrar_todo", "");
    const n = borrarTodosMovimientosFinancieros();
    sincronizarGoogleSheets(hoyISO());
    endExecution("ok", `${n} movimientos eliminados`);
    return `Tabla limpia: eliminé ${n} movimiento(s) y actualicé la hoja.`;
  }
  let id: number | null = null;
  let fecha = hoyISO();
  const porId = t.match(/(?:movimiento|registro|gasto|ingreso)\s*#?\s*(\d+)/);
  if (porId) {
    id = Number(porId[1]);
  } else if (/ultim/.test(t)) {
    const ultimo = ultimoMovimientoFinanciero();
    if (!ultimo) return "No hay movimientos para borrar.";
    id = ultimo.id;
    fecha = ultimo.fecha;
  } else {
    return "Dime cuál borro: 'elimina el movimiento 3', 'borra el último gasto' o 'limpia todo'.";
  }
  startExecution("finanzas_borrar", `movimiento ${id}`);
  const ok = borrarMovimientoFinanciero(id);
  if (!ok) {
    endExecution("error", `movimiento ${id} no existe`);
    return `No encontré el movimiento #${id}.`;
  }
  sincronizarGoogleSheets(fecha);
  endExecution("ok", `movimiento ${id} eliminado`);
  return `Movimiento #${id} eliminado y hoja actualizada.`;
}
