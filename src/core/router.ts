import { getContext, clearContext } from "../memory/context.js";
import { listTools } from "../tools/registry.js";
import { syncNotes, searchNotes, listNotes } from "../memory/indexer.js";
import { factsList } from "../memory/facts.js";
import { empleoResumen, removeAplicacion, confirmAplicacion } from "../jobs/applications.js";
import { listCuentas } from "../memory/sqlite.js";
import {
  borrarMovimiento,
  cancelarBorradorPendiente,
  crearMeta,
  crearPresupuesto,
  exportarParaPowerBI,
  guardarMovimiento,
  parsearMovimientoTexto,
  resumenDia,
  ultimosMovimientos,
} from "../finance/finance.js";
import { publicarEnGoogleSheets } from "../finance/googleSheets.js";

export type Route =
  | { kind: "fast"; command: string }
  | { kind: "agent"; prompt: string };

export function routeIntent(input: string): Route {
  const text = input.trim();
  if (text.startsWith("/")) {
    return { kind: "fast", command: text.slice(1).trim().toLowerCase() };
  }
  return { kind: "agent", prompt: text };
}

export async function handleFastCommand(command: string, channelId: string): Promise<string> {
  switch (command) {
    case "status":
      return `Viernes operativo | Canal: ${channelId} | Herramientas: ${listTools(channelId).length} | Turnos en contexto: ${getContext().length}`;
    case "tools": {
      const tools = listTools(channelId);
      return (
        "Herramientas disponibles:\n" +
        tools.map((t) => `- ${t.name} (${t.risk}): ${t.description}`).join("\n")
      );
    }
    case "memory clear":
      clearContext();
      return "Contexto de conversacion limpiado. Tus datos guardados (hechos y CV) siguen intactos.";
    case "memory":
      return factsList();
    case "reload":
      return "Identidad recargada: IDENTITY.md / USER.md / OPERATING_AGREEMENT.md se leerán de nuevo en la próxima interacción.";
    case "empleo":
      return empleoResumen();
    case "finanzas":
      return `${resumenDia()}\n\nUsa: /finanzas agregar "ingreso rappi 45000 viaje" | /finanzas hoy | /finanzas ultimos | /finanzas exportar | /finanzas publicar`;
    case "voz ver":
      return "El comando /voz ver solo está disponible en WhatsApp, donde guardo tu última transcripción.";
    case "cuentas": {
      const cuentas = listCuentas();
      return cuentas.length
        ? "Cuentas:\n" + cuentas.map((c) => `- ${c.nombre}: ${c.activa ? "activa" : "sin sesion"} (${c.notas})`).join("\n")
        : "Sin cuentas registradas. Ejecuta 'browser sesion' para poblar el estado.";
    }
    case "help":
      return "Comandos: /status, /tools, /memory, /memory guardar clave: valor, /memory borrar clave, /memory clear, /empleo, /finanzas, /reload, /help, /notes.\n"
        + "Para usar una herramienta: 'usa fs.read C:/ruta/del/archivo'.\n"
        + "Para buscar empleo: 'buscar: qa junior' (te mando una oferta por una: 'siguiente', 'postular', 'listo').\n"
        + "Para postularte: 'postular 2' y despues responde 'si' con la ficha a la vista.\n"
        + "Para que recuerde algo: 'recuerda que mi salario minimo es 1800000'.";
    case "notes sync": {
      const n = syncNotes();
      return `Indexadas ${n} notas desde notes/.`;
    }
    case "notes": {
      const items = listNotes();
      return items.length > 0
        ? "Notas indexadas:\n" + items.map((i) => `- ${i.title}`).join("\n")
        : "Sin notas. Agrega archivos .md a notes/ y corre /notes sync.";
    }
    default: {
      if (command.startsWith("finanzas ")) {
        const resto = command.slice("finanzas ".length).trim();
        if (resto === "hoy") return resumenDia();
        if (resto === "ultimos") return ultimosMovimientos();
        if (resto === "exportar") return exportarParaPowerBI();
        if (resto === "publicar") {
          try {
            return await publicarEnGoogleSheets();
          } catch (err) {
            return `No pude publicar en Google Sheets: ${String(err).replace(/^Error:\s*/, "").slice(0, 500)}`;
          }
        }
        if (resto === "cancelar") return cancelarBorradorPendiente(channelId);
        if (resto.startsWith("borrar ")) return borrarMovimiento(resto);
        if (resto.startsWith("meta")) return crearMeta(resto);
        if (resto.startsWith("presupuesto")) return crearPresupuesto(resto);
        if (resto.startsWith("agregar ")) {
          const borrador = parsearMovimientoTexto(resto.slice("agregar ".length));
          if (!borrador) return 'Formato: /finanzas agregar "ingreso rappi 45000 viaje"';
          const id = guardarMovimiento({ ...borrador, origen: "texto" });
          return `Movimiento guardado #${id}.`;
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(resto)) return resumenDia(resto);
        return "Comando financiero desconocido. Usa /finanzas.";
      }
      if (command.startsWith("empleo ")) {
        const resto = command.slice("empleo ".length).trim();
        if (/^confirmar\s+/i.test(resto)) {
          return confirmAplicacion(resto.replace(/^confirmar\s+/i, "").trim());
        }
        const url = resto.replace(/^borrar\s+/i, "");
        return removeAplicacion(url);
      }
      if (command.startsWith("notes ")) {
        const query = command.slice("notes ".length).trim();
        const results = searchNotes(query);
        return results.length > 0
          ? results.map((r) => `- ${r.title}: ${r.snippet}`).join("\n")
          : `Sin resultados para '${query}'.`;
      }
      return `Comando desconocido: /${command}. Usa /help.`;
    }
  }
}
