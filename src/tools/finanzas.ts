import { registerTool } from "./registry.js";
import {
  exportarParaPowerBI,
  guardarMovimiento,
  parsearMovimientoTexto,
  resumenDia,
  ultimosMovimientos,
} from "../finance/finance.js";
import { publicarEnGoogleSheets } from "../finance/googleSheets.js";

async function leerFinanzas(input: string): Promise<string> {
  const cmd = input.trim().toLowerCase();
  if (!cmd || cmd === "hoy") return resumenDia();
  if (cmd === "ultimos") return ultimosMovimientos();
  if (cmd === "exportar") return exportarParaPowerBI();
  if (cmd === "publicar") return publicarEnGoogleSheets();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cmd)) return resumenDia(cmd);
  return "Usa: usa finanzas-leer hoy | ultimos | exportar | publicar | YYYY-MM-DD";
}

function agregarFinanzas(input: string): string {
  const texto = input.trim().replace(/^agregar\s+/i, "");
  const borrador = parsearMovimientoTexto(texto);
  if (!borrador) return 'Formato: usa finanzas-agregar "ingreso rappi 45000 viaje"';
  const id = guardarMovimiento({ ...borrador, origen: "tool" });
  return `Movimiento financiero guardado #${id}.`;
}

registerTool({
  name: "finanzas-leer",
  description: "Lee resumen financiero, últimos movimientos, exporta CSV y publica el panel en Google Sheets.",
  risk: "green",
  channels: ["cli", "whatsapp"],
  handler: leerFinanzas,
});

registerTool({
  name: "finanzas-agregar",
  description: "Registra un ingreso o egreso en COP. Se ejecuta directo con la orden.",
  risk: "green",
  channels: ["cli", "whatsapp"],
  handler: agregarFinanzas,
});
