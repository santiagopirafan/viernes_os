import { RiskLevel, events } from "./events.js";

export function classify(intent: string): RiskLevel {
  const text = intent.toLowerCase();

  const redKeywords = [
    "borra", "borrar", "elimina", "eliminar", "delete", "rmdir",
    " rm ", " rm\n", "rm -", "destroy", "destruye", "eliminas",
    "publica", "publicar en redes", "borra el archivo",
  ];
  if (redKeywords.some((k) => text.includes(k))) return "red";

  const yellowKeywords = [
    "postul", "envi", "send", "public", "modificar", "modifica",
    "modificar", "crear archivo", "escribir archivo", "api", "coste",
    "descargar y pagar", "muta",
  ];
  if (yellowKeywords.some((k) => text.includes(k))) return "yellow";

  return "green";
}

export interface ActionRequest {
  tool: string;
  risk: RiskLevel;
  channel: string;
}

export function evaluateRisk(request: ActionRequest): { allowed: boolean; reason?: string } {
  if (request.risk === "red") {
    events.publish({
      type: "risk:blocked",
      reason: `${request.tool} clasificada como nivel Rojo`,
      ts: Date.now(),
      channel: request.channel,
    });
    return {
      allowed: false,
      reason: "Nivel de riesgo Rojo: bloqueada según OPERATING_AGREEMENT.md",
    };
  }

  return { allowed: true };
}

export function requiresConfirmation(risk: RiskLevel): boolean {
  return risk === "yellow";
}
