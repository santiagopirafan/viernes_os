import { getConfig } from "../core/config.js";
import { endExecution, startExecution, stepExecution } from "../core/executionLog.js";
import { log } from "../core/logger.js";
import {
  listMetasFinancieras,
  listMovimientosFinancieros,
  resumenFinancieroPorPlataforma,
} from "../memory/sqlite.js";

interface Columna {
  name: string;
  dataType: "String" | "Int64" | "Double" | "Boolean" | "DateTime";
}

function configPowerBI() {
  const c = getConfig();
  const faltantes = [
    ["POWERBI_TENANT_ID", c.POWERBI_TENANT_ID],
    ["POWERBI_CLIENT_ID", c.POWERBI_CLIENT_ID],
    ["POWERBI_CLIENT_SECRET", c.POWERBI_CLIENT_SECRET],
    ["POWERBI_WORKSPACE_ID", c.POWERBI_WORKSPACE_ID],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (faltantes.length) {
    throw new Error(
      `Falta configurar Power BI en .env: ${faltantes.join(", ")}. ` +
        "Crea un App registration en Entra ID, un workspace en Power BI Service y copia esos IDs."
    );
  }
  return {
    tenant: c.POWERBI_TENANT_ID as string,
    clientId: c.POWERBI_CLIENT_ID as string,
    secret: c.POWERBI_CLIENT_SECRET as string,
    workspace: c.POWERBI_WORKSPACE_ID as string,
    dataset: c.POWERBI_DATASET_NAME,
  };
}

async function tokenAcceso(cfg: ReturnType<typeof configPowerBI>): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.secret,
    scope: "https://analysis.windows.net/powerbi/api/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`No pude autenticar Power BI (${res.status}). Revisa tenant/client/secret.`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Power BI no devolvió token de acceso.");
  return data.access_token;
}

const TABLAS: { name: string; columns: Columna[] }[] = [
  {
    name: "movimientos",
    columns: [
      { name: "id", dataType: "Int64" },
      { name: "fecha", dataType: "String" },
      { name: "tipo", dataType: "String" },
      { name: "plataforma", dataType: "String" },
      { name: "categoria", dataType: "String" },
      { name: "valor_cop", dataType: "Int64" },
      { name: "nota", dataType: "String" },
      { name: "origen", dataType: "String" },
      { name: "estado", dataType: "String" },
      { name: "ts", dataType: "Int64" },
    ],
  },
  {
    name: "resumen_diario",
    columns: [
      { name: "fecha", dataType: "String" },
      { name: "plataforma", dataType: "String" },
      { name: "total_ingresos_cop", dataType: "Int64" },
    ],
  },
  {
    name: "metas",
    columns: [
      { name: "id", dataType: "Int64" },
      { name: "nombre", dataType: "String" },
      { name: "plataforma", dataType: "String" },
      { name: "valor_meta_cop", dataType: "Int64" },
      { name: "periodo", dataType: "String" },
      { name: "fecha_inicio", dataType: "String" },
      { name: "fecha_fin", dataType: "String" },
      { name: "activa", dataType: "Boolean" },
    ],
  },
];

async function buscarDataset(token: string, workspace: string, nombre: string): Promise<string | null> {
  const res = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${workspace}/datasets`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`No pude leer datasets de Power BI (${res.status}). Revisa workspace y permisos.`);
  const data = (await res.json()) as { value?: { id: string; name: string }[] };
  return data.value?.find((d) => d.name === nombre)?.id ?? null;
}

async function crearDataset(token: string, workspace: string, nombre: string): Promise<string> {
  const res = await fetch(`https://api.powerbi.com/v1.0/myorg/groups/${workspace}/datasets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: nombre, defaultMode: "Push", tables: TABLAS }),
  });
  if (!res.ok) throw new Error(`No pude crear el dataset (${res.status}). Revisa permisos Dataset.ReadWrite.All.`);
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function reemplazarFilas(
  token: string,
  workspace: string,
  datasetId: string,
  tabla: string,
  filas: Record<string, unknown>[]
): Promise<void> {
  const base = `https://api.powerbi.com/v1.0/myorg/groups/${workspace}/datasets/${datasetId}/tables/${tabla}/rows`;
  const del = await fetch(base, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!del.ok) throw new Error(`No pude limpiar la tabla ${tabla} (${del.status}).`);
  if (!filas.length) return;
  for (let i = 0; i < filas.length; i += 500) {
    const lote = filas.slice(i, i + 500);
    const res = await fetch(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ rows: lote }),
    });
    if (!res.ok) throw new Error(`No pude publicar filas en ${tabla} (${res.status}).`);
  }
}

export async function publicarEnPowerBI(fecha = new Date().toISOString().slice(0, 10)): Promise<string> {
  startExecution("finanzas_publicar_powerbi", fecha);
  const cfg = configPowerBI();
  const token = await obtenerTokenSinExponer(cfg);
  stepExecution("Autenticado en Power BI");
  let datasetId = await buscarDataset(token, cfg.workspace, cfg.dataset);
  if (!datasetId) {
    datasetId = await crearDataset(token, cfg.workspace, cfg.dataset);
    stepExecution(`Dataset creado: ${cfg.dataset}`);
  } else {
    stepExecution(`Dataset existente: ${cfg.dataset}`);
  }
  const movimientos = listMovimientosFinancieros(1000)
    .filter((m) => m.estado === "confirmado")
    .map((m) => ({
      id: m.id,
      fecha: m.fecha,
      tipo: m.tipo,
      plataforma: m.plataforma,
      categoria: m.categoria,
      valor_cop: m.valor_cop,
      nota: m.nota.slice(0, 400),
      origen: m.origen,
      estado: m.estado,
      ts: m.ts,
    }));
  const resumen = resumenFinancieroPorPlataforma(fecha).map((p) => ({
    fecha,
    plataforma: p.plataforma,
    total_ingresos_cop: p.total,
  }));
  const metas = listMetasFinancieras().map((meta) => ({
    id: meta.id,
    nombre: meta.nombre,
    plataforma: meta.plataforma,
    valor_meta_cop: meta.valor_meta_cop,
    periodo: meta.periodo,
    fecha_inicio: meta.fecha_inicio,
    fecha_fin: meta.fecha_fin,
    activa: meta.activa === 1,
  }));
  await reemplazarFilas(token, cfg.workspace, datasetId, "movimientos", movimientos);
  await reemplazarFilas(token, cfg.workspace, datasetId, "resumen_diario", resumen);
  await reemplazarFilas(token, cfg.workspace, datasetId, "metas", metas);
  endExecution("ok", `${movimientos.length} movimientos publicados`);
  log("info", `Power BI actualizado: ${cfg.dataset} (${movimientos.length} movimientos)`);
  return [
    "Power BI actualizado.",
    `Workspace: ${cfg.workspace}`,
    `Dataset: ${cfg.dataset}`,
    `Movimientos: ${movimientos.length} | Resumen: ${resumen.length} | Metas: ${metas.length}`,
    "Abre Power BI Service y crea tu informe con las tablas movimientos, resumen_diario y metas.",
  ].join("\n");
}

async function obtenerTokenSinExponer(cfg: ReturnType<typeof configPowerBI>): Promise<string> {
  return tokenAcceso(cfg);
}
