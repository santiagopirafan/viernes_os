import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MEMORY_DIR = path.join(process.cwd(), "memory");
fs.mkdirSync(MEMORY_DIR, { recursive: true });

const db = new DatabaseSync(path.join(MEMORY_DIR, "viernes.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    path TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS facts (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS aplicaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    portal TEXT NOT NULL,
    titulo TEXT NOT NULL,
    empresa TEXT DEFAULT '',
    estado TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    nota TEXT DEFAULT '',
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cuentas (
    portal TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    nombre TEXT NOT NULL,
    activa INTEGER DEFAULT 0,
    ultima_revision INTEGER DEFAULT 0,
    notas TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS finanzas_movimientos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    tipo TEXT NOT NULL,
    plataforma TEXT NOT NULL,
    categoria TEXT NOT NULL,
    valor_cop INTEGER NOT NULL,
    nota TEXT DEFAULT '',
    origen TEXT DEFAULT '',
    estado TEXT NOT NULL DEFAULT 'confirmado',
    evidencia TEXT DEFAULT '',
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS finanzas_metas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    plataforma TEXT NOT NULL DEFAULT 'todas',
    valor_meta_cop INTEGER NOT NULL,
    periodo TEXT NOT NULL DEFAULT 'diario',
    fecha_inicio TEXT NOT NULL,
    fecha_fin TEXT NOT NULL,
    activa INTEGER NOT NULL DEFAULT 1,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS finanzas_presupuestos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria TEXT NOT NULL,
    limite_cop INTEGER NOT NULL,
    periodo TEXT NOT NULL DEFAULT 'diario',
    activa INTEGER NOT NULL DEFAULT 1,
    ts INTEGER NOT NULL
  );
`);

export function appendMessage(channel: string, role: string, content: string): void {
  db
    .prepare("INSERT INTO messages (channel, role, content, ts) VALUES (?, ?, ?, ?)")
    .run(channel, role, content, Date.now());
}

export interface StoredMessage {
  role: string;
  content: string;
  ts: number;
}

export function listRecentMessages(channel: string, limit = 50): StoredMessage[] {
  const rows = db
    .prepare("SELECT role, content, ts FROM messages WHERE channel = ? ORDER BY id DESC LIMIT ?")
    .all(channel, limit) as unknown as StoredMessage[];
  return rows.reverse();
}

export function listRecentGlobal(limit = 30): StoredMessage[] {
  const rows = db
    .prepare("SELECT role, content, ts FROM messages ORDER BY id DESC LIMIT ?")
    .all(limit) as unknown as StoredMessage[];
  return rows.reverse();
}

export interface NoteRow {
  title: string;
  content: string;
}

export function upsertFact(key: string, value: string): void {
  db.prepare(
    `INSERT INTO facts (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key.trim().toLowerCase(), value.trim(), Date.now());
}

export function listFacts(): { key: string; value: string }[] {
  return db.prepare("SELECT key, value FROM facts ORDER BY updated_at DESC").all() as unknown as {
    key: string;
    value: string;
  }[];
}

export function deleteFact(key: string): boolean {
  const res = db.prepare("DELETE FROM facts WHERE key = ?").run(key.trim().toLowerCase());
  return Number(res.changes) > 0;
}

export function upsertNote(notePath: string, title: string, content: string): void {
  db
    .prepare(
      `INSERT INTO notes (path, title, content, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET title = excluded.title,
         content = excluded.content, updated_at = excluded.updated_at`
    )
    .run(notePath, title, content, Date.now());
}

export function listNotes(): { title: string; snippet: string }[] {
  const rows = db.prepare("SELECT title, content FROM notes ORDER BY title").all() as unknown as NoteRow[];
  return rows.map((r) => ({ title: r.title, snippet: r.content.slice(0, 200) }));
}

export function searchNotes(query: string, limit = 5): { title: string; snippet: string }[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const rows = db.prepare("SELECT title, content FROM notes").all() as unknown as NoteRow[];
  const scored = rows
    .map((r) => {
      const haystack = `${r.title} ${r.content}`.toLowerCase();
      const score = words.reduce((acc, w) => acc + haystack.split(w).length - 1, 0);
      return { ...r, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((r) => ({ title: r.title, snippet: r.content.slice(0, 200) }));
}

export interface ApplicationRow {
  url: string;
  portal: string;
  titulo: string;
  empresa: string;
  estado: string;
  score: number;
  nota: string;
  ts: number;
}

export function insertApplication(row: Omit<ApplicationRow, "ts"> & { ts?: number }): void {
  db.prepare(
    `INSERT INTO aplicaciones (url, portal, titulo, empresa, estado, score, nota, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       portal = excluded.portal, titulo = excluded.titulo, empresa = excluded.empresa,
       estado = excluded.estado, score = excluded.score, nota = excluded.nota, ts = excluded.ts`
  ).run(
    row.url,
    row.portal,
    row.titulo,
    row.empresa,
    row.estado,
    row.score,
    row.nota,
    row.ts ?? Date.now()
  );
}

export function findApplicationByUrl(url: string): ApplicationRow | undefined {
  const rows = db.prepare("SELECT * FROM aplicaciones WHERE url = ?").all(url) as unknown as ApplicationRow[];
  return rows[0];
}

export function listApplications(limit = 30): ApplicationRow[] {
  const rows = db
    .prepare("SELECT * FROM aplicaciones ORDER BY ts DESC LIMIT ?")
    .all(limit) as unknown as ApplicationRow[];
  return rows;
}

export interface CuentaRow {
  portal: string;
  slug: string;
  nombre: string;
  activa: number;
  ultima_revision: number;
  notas: string;
}

export function upsertCuenta(row: CuentaRow): void {
  db.prepare(
    `INSERT INTO cuentas (portal, slug, nombre, activa, ultima_revision, notas)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(portal) DO UPDATE SET slug=excluded.slug, nombre=excluded.nombre, activa=excluded.activa, ultima_revision=excluded.ultima_revision, notas=excluded.notas`
  ).run(row.portal, row.slug, row.nombre, row.activa, row.ultima_revision, row.notas);
}

export function listCuentas(): CuentaRow[] {
  return db.prepare("SELECT * FROM cuentas ORDER BY portal").all() as unknown as CuentaRow[];
}

export function countApplications(): { estado: string; n: number }[] {
  return db
    .prepare("SELECT estado, COUNT(*) AS n FROM aplicaciones GROUP BY estado")
    .all() as unknown as { estado: string; n: number }[];
}

export function deleteApplication(url: string): boolean {
  const res = db.prepare("DELETE FROM aplicaciones WHERE url = ?").run(url);
  return Number(res.changes) > 0;
}

export interface MovimientoFinancieroRow {
  id?: number;
  fecha: string;
  tipo: "ingreso" | "egreso";
  plataforma: string;
  categoria: string;
  valor_cop: number;
  nota: string;
  origen: string;
  estado: "pendiente" | "confirmado";
  evidencia: string;
  ts?: number;
}

export function insertMovimientoFinanciero(row: MovimientoFinancieroRow): number {
  const res = db
    .prepare(
      `INSERT INTO finanzas_movimientos (fecha, tipo, plataforma, categoria, valor_cop, nota, origen, estado, evidencia, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.fecha,
      row.tipo,
      row.plataforma,
      row.categoria,
      row.valor_cop,
      row.nota,
      row.origen,
      row.estado,
      row.evidencia,
      row.ts ?? Date.now()
    );
  return Number(res.lastInsertRowid);
}

export function listMovimientosFinancieros(limit = 50): (MovimientoFinancieroRow & { id: number; ts: number })[] {
  return db
    .prepare("SELECT * FROM finanzas_movimientos ORDER BY ts DESC LIMIT ?")
    .all(limit) as unknown as (MovimientoFinancieroRow & { id: number; ts: number })[];
}

export function resumenFinancieroPorFecha(fecha: string): { tipo: string; n: number; total: number }[] {
  return db
    .prepare(
      `SELECT tipo, COUNT(*) AS n, COALESCE(SUM(valor_cop), 0) AS total
       FROM finanzas_movimientos
       WHERE fecha = ? AND estado = 'confirmado'
       GROUP BY tipo`
    )
    .all(fecha) as unknown as { tipo: string; n: number; total: number }[];
}

export function resumenFinancieroPorPlataforma(fecha: string): { plataforma: string; total: number }[] {
  return db
    .prepare(
      `SELECT plataforma, COALESCE(SUM(valor_cop), 0) AS total
       FROM finanzas_movimientos
       WHERE fecha = ? AND tipo = 'ingreso' AND estado = 'confirmado'
       GROUP BY plataforma
       ORDER BY total DESC`
    )
    .all(fecha) as unknown as { plataforma: string; total: number }[];
}

export function existeMovimientoDuplicado(fecha: string, plataforma: string, valorCop: number, evidencia: string): boolean {
  const rows = db
    .prepare(
      `SELECT 1 FROM finanzas_movimientos
       WHERE fecha = ? AND plataforma = ? AND valor_cop = ? AND evidencia = ? AND estado = 'confirmado'
       LIMIT 1`
    )
    .all(fecha, plataforma, valorCop, evidencia) as unknown[];
  return rows.length > 0;
}

export function upsertMetaFinanciera(row: {
  nombre: string;
  plataforma: string;
  valorMetaCop: number;
  periodo: string;
  fechaInicio: string;
  fechaFin: string;
}): number {
  const res = db
    .prepare(
      `INSERT INTO finanzas_metas (nombre, plataforma, valor_meta_cop, periodo, fecha_inicio, fecha_fin, activa, ts)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(row.nombre, row.plataforma, row.valorMetaCop, row.periodo, row.fechaInicio, row.fechaFin, Date.now());
  return Number(res.lastInsertRowid);
}

export function listMetasFinancieras(): {
  id: number;
  nombre: string;
  plataforma: string;
  valor_meta_cop: number;
  periodo: string;
  fecha_inicio: string;
  fecha_fin: string;
  activa: number;
}[] {
  return db
    .prepare("SELECT * FROM finanzas_metas WHERE activa = 1 ORDER BY ts DESC")
    .all() as unknown as {
    id: number;
    nombre: string;
    plataforma: string;
    valor_meta_cop: number;
    periodo: string;
    fecha_inicio: string;
    fecha_fin: string;
    activa: number;
  }[];
}

export function upsertPresupuestoFinanciero(categoria: string, limiteCop: number, periodo = "diario"): void {
  db.prepare(
    `INSERT INTO finanzas_presupuestos (categoria, limite_cop, periodo, activa, ts)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(categoria, limiteCop, periodo, Date.now());
}

export function ultimoMovimientoFinanciero(): (MovimientoFinancieroRow & { id: number; ts: number }) | undefined {
  const rows = db
    .prepare("SELECT * FROM finanzas_movimientos ORDER BY id DESC LIMIT 1")
    .all() as unknown as (MovimientoFinancieroRow & { id: number; ts: number })[];
  return rows[0];
}

export function borrarMovimientoFinanciero(id: number): boolean {
  const res = db.prepare("DELETE FROM finanzas_movimientos WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

export function borrarTodosMovimientosFinancieros(): number {
  const res = db.prepare("DELETE FROM finanzas_movimientos").run();
  return Number(res.changes);
}
