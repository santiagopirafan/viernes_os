import crypto from "node:crypto";
import fs from "node:fs";
import { getConfig } from "../core/config.js";
import { endExecution, startExecution, stepExecution } from "../core/executionLog.js";
import { log } from "../core/logger.js";
import { listMetasFinancieras, listMovimientosFinancieros } from "../memory/sqlite.js";

const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";

function base64url(datos: Buffer | string): string {
  const b = typeof datos === "string" ? Buffer.from(datos) : datos;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function leerCuentaServicio(): { email: string; key: string } | null {
  const valor = getConfig().GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!valor) return null;
  const esContenido = valor.trim().startsWith("{");
  if (!esContenido && !fs.existsSync(valor)) {
    throw new Error(`No encuentro el JSON de Google en: ${valor}.`);
  }
  const json = JSON.parse(esContenido ? valor : fs.readFileSync(valor, "utf8")) as {
    client_email?: string;
    private_key?: string;
  };
  if (!json.client_email || !json.private_key) throw new Error("El JSON de Google no tiene client_email/private_key.");
  return { email: json.client_email, key: json.private_key };
}

async function tokenConRefresh(): Promise<string | null> {
  const cfg = getConfig();
  if (!cfg.GOOGLE_OAUTH_CLIENT_ID || !cfg.GOOGLE_OAUTH_CLIENT_SECRET || !cfg.GOOGLE_OAUTH_REFRESH_TOKEN) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: cfg.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: cfg.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`No pude refrescar el token de Google (${res.status}).`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Google no devolvió token de acceso.");
  return data.access_token;
}

async function tokenAcceso(email: string, key: string): Promise<string> {
  const ahora = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: email,
      scope: SCOPES,
      aud: "https://oauth2.googleapis.com/token",
      iat: ahora,
      exp: ahora + 3600,
    })
  );
  const firma = base64url(crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${payload}.${firma}` }),
  });
  if (!res.ok) throw new Error(`No pude autenticar Google (${res.status}). Revisa la llave JSON.`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Google no devolvió token de acceso.");
  return data.access_token;
}

async function api(token: string, ruta: string, metodo = "GET", cuerpo?: unknown) {
  const res = await fetch(`https://sheets.googleapis.com/v4${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  if (!res.ok) throw new Error(`Google Sheets error ${res.status} en ${ruta}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

async function compartir(token: string, spreadsheetId: string, email: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "writer", type: "user", emailAddress: email }),
  });
  if (!res.ok) throw new Error(`No pude compartir la hoja (${res.status}).`);
}

async function asegurarHoja(token: string): Promise<{ id: string; url: string }> {
  const cfg = getConfig();
  const ESPERADAS = ["Movimientos", "Resumen", "EgresosCategoria", "Historial", "Metas", "Panel"];
  if (cfg.GOOGLE_SHEETS_ID) {
    const info = await api(token, `/spreadsheets/${cfg.GOOGLE_SHEETS_ID}?fields=spreadsheetId,spreadsheetUrl,sheets.properties.title`);
    const existentes = new Set((info.sheets as { properties: { title: string } }[]).map((h) => h.properties.title));
    const faltantes = ESPERADAS.filter((t) => !existentes.has(t));
    if (faltantes.length) {
      await api(token, `/spreadsheets/${cfg.GOOGLE_SHEETS_ID}:batchUpdate`, "POST", {
        requests: faltantes.map((title) => ({ addSheet: { properties: { title } } })),
      });
    }
    return { id: info.spreadsheetId, url: info.spreadsheetUrl };
  }
  if (!cfg.GOOGLE_SHARE_EMAIL) {
    throw new Error(
      "Define GOOGLE_SHEETS_ID (hoja existente compartida con la cuenta de servicio) o GOOGLE_SHARE_EMAIL (para compartir la hoja que voy a crear)."
    );
  }
  const creada = await api(token, "/spreadsheets", "POST", {
    properties: { title: cfg.GOOGLE_SHEETS_TITLE },
    sheets: ["Movimientos", "Resumen", "EgresosCategoria", "Historial", "Metas", "Panel"].map((title) => ({
      properties: { title },
    })),
  });
  await compartir(token, creada.spreadsheetId, cfg.GOOGLE_SHARE_EMAIL);
  return { id: creada.spreadsheetId, url: creada.spreadsheetUrl };
}

async function escribirPestanas(token: string, id: string, datos: { rango: string; valores: (string | number | boolean)[][] }[]): Promise<void> {
  await api(token, `/spreadsheets/${id}/values:batchClear`, "POST", { ranges: datos.map((d) => d.rango) });
  await api(token, `/spreadsheets/${id}/values:batchUpdate`, "POST", {
    valueInputOption: "USER_ENTERED",
    data: datos.map((d) => ({ range: d.rango, values: d.valores })),
  });
}

const VERDE = { red: 0.13, green: 0.42, blue: 0.23 };
const BLANCO = { red: 1, green: 1, blue: 1 };
const GRIS = { red: 0.94, green: 0.96, blue: 0.94 };
const ROJO = { red: 0.75, green: 0.2, blue: 0.2 };

function rango(hoja: number, f0: number, f1: number, c0: number, c1: number) {
  return { sheetId: hoja, startRowIndex: f0, endRowIndex: f1, startColumnIndex: c0, endColumnIndex: c1 };
}

function encabezado(hoja: number, columnas: number) {
  return {
    repeatCell: {
      range: rango(hoja, 0, 1, 0, columnas),
      cell: {
        userEnteredFormat: {
          backgroundColor: VERDE,
          textFormat: { bold: true, foregroundColor: BLANCO, fontSize: 11 },
          horizontalAlignment: "CENTER",
        },
      },
      fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
    },
  };
}

function formatoTabla(hoja: number, filas: number, columnas: number, monedas: number[]) {
  const req: unknown[] = [
    { updateSheetProperties: { properties: { sheetId: hoja, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
    encabezado(hoja, columnas),
    { autoResizeDimensions: { dimensions: { sheetId: hoja, dimension: "COLUMNS", startIndex: 0, endIndex: columnas } } },
  ];
  if (filas > 0) {
    req.push(
      { setBasicFilter: { filter: { range: rango(hoja, 0, 1 + filas, 0, columnas) } } },
      {
        addBanding: {
          bandedRange: {
            range: rango(hoja, 0, 1 + filas, 0, columnas),
            rowProperties: { headerColor: VERDE, firstBandColor: BLANCO, secondBandColor: GRIS },
          },
        },
      }
    );
  }
  for (const c of monedas) {
    req.push({
      repeatCell: {
        range: rango(hoja, 1, 1 + filas, c, c + 1),
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: '"$"#,##0' } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  }
  return req;
}

async function embellecerHoja(
  token: string,
  id: string,
  conteo: { movimientos: number; resumen: number; egresos: number; historial: number; metas: number; balancePositivo: boolean }
): Promise<void> {
  const info = await api(token, `/spreadsheets/${id}?fields=sheets.properties.title,sheets.properties.sheetId,sheets.charts.chartId`);
  const hojas = info.sheets as { properties: { title: string; sheetId: number }; charts?: { chartId: number }[] }[];
  const porTitulo = new Map(hojas.map((h) => [h.properties.title, h]));
  const panel = porTitulo.get("Panel");
  const resumen = porTitulo.get("Resumen");
  const egresos = porTitulo.get("EgresosCategoria");
  const historial = porTitulo.get("Historial");
  const movimientos = porTitulo.get("Movimientos");
  const metas = porTitulo.get("Metas");
  if (!panel || !resumen || !egresos || !historial || !movimientos || !metas) {
    throw new Error("La hoja no tiene las pestañas del panel financiero.");
  }
  const peticiones: unknown[] = [
    ...formatoTabla(movimientos.properties.sheetId, conteo.movimientos, 8, [4]),
    ...formatoTabla(resumen.properties.sheetId, conteo.resumen, 2, [1]),
    ...formatoTabla(egresos.properties.sheetId, conteo.egresos, 2, [1]),
    ...formatoTabla(historial.properties.sheetId, conteo.historial, 4, [1, 2, 3]),
    ...formatoTabla(metas.properties.sheetId, conteo.metas, 8, [3]),
    {
      repeatCell: {
        range: rango(panel.properties.sheetId, 0, 1, 0, 2),
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14, foregroundColor: VERDE } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
    {
      repeatCell: {
        range: rango(panel.properties.sheetId, 2, 7, 0, 1),
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } } },
        fields: "userEnteredFormat.textFormat",
      },
    },
    {
      repeatCell: {
        range: rango(panel.properties.sheetId, 2, 6, 1, 2),
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: '"$"#,##0' }, textFormat: { fontSize: 12 } } },
        fields: "userEnteredFormat(numberFormat,textFormat)",
      },
    },
    {
      repeatCell: {
        range: rango(panel.properties.sheetId, 6, 7, 1, 2),
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0%" }, textFormat: { fontSize: 12 } } },
        fields: "userEnteredFormat(numberFormat,textFormat)",
      },
    },
    {
      repeatCell: {
        range: rango(panel.properties.sheetId, 4, 5, 1, 2),
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true, fontSize: 13, foregroundColor: conteo.balancePositivo ? VERDE : ROJO },
          },
        },
        fields: "userEnteredFormat.textFormat",
      },
    },
  ];
  for (const c of panel.charts ?? []) peticiones.push({ deleteEmbeddedObject: { objectId: c.chartId } });
  const grafica = (titulo: string, tipo: string, hoja: number, filasDatos: number, columnas: [number, number][], fila: number) => ({
    addChart: {
      chart: {
        spec: {
          title: titulo,
          basicChart: {
            chartType: tipo,
            legendPosition: "BOTTOM_LEGEND",
            domains: [
              { domain: { sourceRange: { sources: [{ sheetId: hoja, startRowIndex: 1, endRowIndex: 1 + filasDatos, startColumnIndex: columnas[0][0], endColumnIndex: columnas[0][1] }] } } },
            ],
            series: columnas.slice(1).map(([a, b]) => ({
              series: { sourceRange: { sources: [{ sheetId: hoja, startRowIndex: 1, endRowIndex: 1 + filasDatos, startColumnIndex: a, endColumnIndex: b }] } },
            })),
            headerCount: 0,
          },
        },
        position: { overlayPosition: { anchorCell: { sheetId: panel.properties.sheetId, rowIndex: fila, columnIndex: 0 }, widthPixels: 640, heightPixels: 360 } },
      },
    },
  });
  if (conteo.resumen > 0) peticiones.push(grafica("Ingresos por plataforma", "COLUMN", resumen.properties.sheetId, conteo.resumen, [[0, 1], [1, 2]], 9));
  if (conteo.egresos > 0) peticiones.push(grafica("Egresos por categoría", "PIE", egresos.properties.sheetId, conteo.egresos, [[0, 1], [1, 2]], 30));
  if (conteo.historial > 0) peticiones.push(grafica("Balance diario", "LINE", historial.properties.sheetId, conteo.historial, [[0, 1], [1, 2], [2, 3], [3, 4]], 51));
  if (peticiones.length) await api(token, `/spreadsheets/${id}:batchUpdate`, "POST", { requests: peticiones });
}

export async function publicarEnGoogleSheets(fecha = new Date().toISOString().slice(0, 10)): Promise<string> {
  startExecution("finanzas_publicar_sheets", fecha);
  const cuenta = leerCuentaServicio();
  const tokenOAuth = cuenta ? null : await tokenConRefresh();
  if (!cuenta && !tokenOAuth) {
    throw new Error(
      "Falta auth de Google en .env. Opción A: GOOGLE_SERVICE_ACCOUNT_JSON. " +
        "Opción B: GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN."
    );
  }
  const token = tokenOAuth ?? (await tokenAcceso(cuenta!.email, cuenta!.key));
  stepExecution("Autenticado en Google");
  const hoja = await asegurarHoja(token);
  stepExecution(`Hoja lista: ${hoja.id}`);

  const items = listMovimientosFinancieros(2000).filter((m) => m.estado === "confirmado");
  const movimientos: (string | number)[][] = [
    ["fecha", "tipo", "plataforma", "categoria", "valor_cop", "nota", "origen", "estado"],
    ...items.map((m) => [m.fecha, m.tipo, m.plataforma, m.categoria, m.valor_cop, m.nota, m.origen, m.estado]),
  ];
  const porPlataforma = new Map<string, number>();
  const porCategoria = new Map<string, number>();
  for (const m of items.filter((m) => m.fecha === fecha)) {
    if (m.tipo === "ingreso") porPlataforma.set(m.plataforma, (porPlataforma.get(m.plataforma) ?? 0) + m.valor_cop);
    if (m.tipo === "egreso") porCategoria.set(m.categoria, (porCategoria.get(m.categoria) ?? 0) + m.valor_cop);
  }
  const resumen: (string | number)[][] = [
    ["plataforma", "total_ingresos_cop"],
    ...[...porPlataforma.entries()].map(([p, t]) => [p, t]),
  ];
  const egresos: (string | number)[][] = [
    ["categoria", "total_egresos_cop"],
    ...[...porCategoria.entries()].map(([c, t]) => [c, t]),
  ];
  const porDia = new Map<string, { ingresos: number; egresos: number }>();
  for (const m of items) {
    const d = porDia.get(m.fecha) ?? { ingresos: 0, egresos: 0 };
    if (m.tipo === "ingreso") d.ingresos += m.valor_cop;
    else d.egresos += m.valor_cop;
    porDia.set(m.fecha, d);
  }
  const historial: (string | number)[][] = [
    ["fecha", "ingresos", "egresos", "balance"],
    ...[...porDia.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(-30)
      .map(([f, d]) => [f, d.ingresos, d.egresos, d.ingresos - d.egresos]),
  ];
  const metas: (string | number | boolean)[][] = [
    ["id", "nombre", "plataforma", "valor_meta_cop", "periodo", "fecha_inicio", "fecha_fin", "activa"],
    ...listMetasFinancieras().map((m) => [m.id, m.nombre, m.plataforma, m.valor_meta_cop, m.periodo, m.fecha_inicio, m.fecha_fin, m.activa === 1]),
  ];

  const metasActivas = listMetasFinancieras().filter(
    (m) => m.periodo === "diario" && m.fecha_inicio <= fecha && fecha <= m.fecha_fin
  );
  const ingresosDia = [...porPlataforma.values()].reduce((a, b) => a + b, 0);
  const egresosDia = [...porCategoria.values()].reduce((a, b) => a + b, 0);
  const metaDia = metasActivas.reduce((a, m) => a + m.valor_meta_cop, 0);
  const panel: (string | number)[][] = [
    [`PANEL FINANCIERO — ${fecha}`],
    [],
    ["Ingresos del día", ingresosDia],
    ["Egresos del día", egresosDia],
    ["Balance del día", ingresosDia - egresosDia],
    ["Meta del día", metaDia],
    ["Avance de meta", metaDia > 0 ? Math.round((ingresosDia / metaDia) * 1000) / 1000 : 0],
  ];

  await escribirPestanas(token, hoja.id, [
    { rango: "Movimientos", valores: movimientos },
    { rango: "Resumen", valores: resumen },
    { rango: "EgresosCategoria", valores: egresos },
    { rango: "Historial", valores: historial },
    { rango: "Metas", valores: metas },
    { rango: "Panel", valores: panel },
  ]);
  stepExecution(`${items.length} movimientos escritos`);
  await embellecerHoja(token, hoja.id, {
    movimientos: items.length,
    resumen: resumen.length - 1,
    egresos: egresos.length - 1,
    historial: historial.length - 1,
    metas: metas.length - 1,
    balancePositivo: ingresosDia - egresosDia >= 0,
  });
  endExecution("ok", `${items.length} movimientos publicados`);
  log("info", `Google Sheets actualizado: ${hoja.url}`);
  return [
    "Google Sheets actualizado.",
    `Hoja: ${hoja.url}`,
    `Movimientos: ${items.length} | Plataformas: ${resumen.length - 1} | Días en historial: ${historial.length - 1}`,
    "Pestaña Panel: ingresos por plataforma, egresos por categoría y balance diario.",
  ].join("\n");
}
