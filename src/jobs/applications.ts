import {
  insertApplication,
  findApplicationByUrl,
  listApplications,
  countApplications,
  deleteApplication,
} from "../memory/sqlite.js";

export interface Aplicacion {
  url: string;
  portal: string;
  titulo: string;
  empresa: string;
  estado: "enviada" | "pendiente" | "fallida";
  score: number;
  nota: string;
  ts: number;
}

export function recordApplication(a: {
  url: string;
  portal: string;
  titulo: string;
  empresa?: string;
  estado: "enviada" | "pendiente" | "fallida";
  score?: number;
  nota?: string;
}): string {
  insertApplication({
    url: a.url,
    portal: a.portal,
    titulo: a.titulo,
    empresa: a.empresa ?? "",
    estado: a.estado,
    score: a.score ?? 0,
    nota: a.nota ?? "",
  });
  return `Postulacion registrada: ${a.titulo} [${a.estado}]`;
}

export function hasApplied(url: string): Aplicacion | undefined {
  return findApplicationByUrl(url) as Aplicacion | undefined;
}

export function listAplicaciones(limit = 30): Aplicacion[] {
  return listApplications(limit) as Aplicacion[];
}

export function removeAplicacion(url: string): string {
  return deleteApplication(url)
    ? `Borre el registro de postulacion: ${url}`
    : "No tenia registrada esa URL.";
}

export function confirmAplicacion(url: string): string {
  const previa = findApplicationByUrl(url);
  if (!previa) return "No tengo registrada esa URL. Pasame la vacante exacta.";
  insertApplication({ ...previa, estado: "enviada", nota: `${previa.nota}; confirmada por el operador` });
  return `Postulacion marcada como ENVIADA: ${previa.titulo}`;
}

export function empleoResumen(): string {
  const todos = listAplicaciones(10);
  const conteo = countApplications();
  if (!conteo.length && !todos.length) {
    return "Todavia no he postulado a nada.\nUsa: 'buscar: qa junior' y luego 'postular 1' para empezar.";
  }
  const total = conteo.reduce((acc, c) => acc + c.n, 0);
  const linea = conteo.map((c) => `${c.n} ${c.estado}`).join(" | ");
  let msg = `Postulaciones: ${total} en total (${linea})\n\n`;
  for (const a of todos) {
    const fecha = new Date(a.ts).toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit" });
    msg += `• ${fecha} ${a.titulo} (${a.portal}) [${a.estado}]\n  ${a.url}\n`;
  }
  msg += "\nPara olvidar una: /empleo borrar <url>";
  return msg;
}
