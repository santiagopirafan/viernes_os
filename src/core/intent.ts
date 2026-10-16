import Groq from "groq-sdk";
import { getConfig } from "./config.js";
import { log } from "./logger.js";

export type Intencion =
  | { accion: "finanzas_agregar"; texto: string }
  | { accion: "finanzas_borrar"; objetivo: string }
  | { accion: "finanzas_resumen"; fecha?: string }
  | { accion: "finanzas_publicar" }
  | { accion: "empleo_buscar"; terminos: string }
  | { accion: "conversar" };

const ACCIONES = [
  "finanzas_agregar",
  "finanzas_borrar",
  "finanzas_resumen",
  "finanzas_publicar",
  "empleo_buscar",
  "conversar",
];

const SISTEMA = `Eres un clasificador de intenciones para un asistente personal. Dado el mensaje del usuario, responde SOLO con un JSON válido, sin explicaciones.

Acciones posibles:
- finanzas_agregar: el usuario quiere registrar un ingreso o gasto. Parámetros: {"texto": "<mensaje original>"}.
- finanzas_borrar: quiere eliminar movimientos o limpiar la tabla. Parámetros: {"objetivo": "<mensaje original>"}.
- finanzas_resumen: quiere ver balance, resumen del día o sus movimientos. Parámetros: {} o {"fecha": "YYYY-MM-DD"}.
- finanzas_publicar: quiere actualizar/subir la hoja de cálculo o el panel. Parámetros: {}.
- empleo_buscar: quiere buscar ofertas de trabajo. Parámetros: {"terminos": "<qué buscar>"}.
- conversar: saludos, preguntas generales o cualquier otra cosa.

Ejemplos:
"registra que me gasté 8000 en desayuno" -> {"accion":"finanzas_agregar","texto":"registra que me gasté 8000 en desayuno"}
"quiero que elimines el último gasto" -> {"accion":"finanzas_borrar","objetivo":"quiero que elimines el último gasto"}
"limpia toda la tabla" -> {"accion":"finanzas_borrar","objetivo":"limpia toda la tabla"}
"cómo voy hoy" -> {"accion":"finanzas_resumen"}
"actualiza la hoja" -> {"accion":"finanzas_publicar"}
"busca trabajo de conductor" -> {"accion":"empleo_buscar","terminos":"conductor"}`;

export async function clasificarIntencion(mensaje: string): Promise<Intencion> {
  try {
    const config = getConfig();
    const groq = new Groq({ apiKey: config.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: config.GROQ_MODEL,
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: mensaje.slice(0, 500) },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    const raw = (completion.choices[0]?.message?.content ?? "").trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { accion: "conversar" };
    const obj = JSON.parse(match[0]) as { accion?: string; texto?: string; objetivo?: string; fecha?: string; terminos?: string };
    if (!obj.accion || !ACCIONES.includes(obj.accion)) return { accion: "conversar" };
    switch (obj.accion) {
      case "finanzas_agregar":
        return { accion: "finanzas_agregar", texto: obj.texto ?? mensaje };
      case "finanzas_borrar":
        return { accion: "finanzas_borrar", objetivo: obj.objetivo ?? mensaje };
      case "finanzas_resumen":
        return { accion: "finanzas_resumen", fecha: obj.fecha };
      case "finanzas_publicar":
        return { accion: "finanzas_publicar" };
      case "empleo_buscar":
        return { accion: "empleo_buscar", terminos: obj.terminos ?? mensaje };
      default:
        return { accion: "conversar" };
    }
  } catch (err) {
    log("warn", `Clasificación de intención falló: ${String(err).slice(0, 120)}`);
    return { accion: "conversar" };
  }
}
