import { RiskLevel, events } from "../core/events.js";
import { evaluateRisk } from "../core/rules.js";
import { log } from "../core/logger.js";

export type ToolHandler = (input: string) => Promise<string> | string;

export interface Tool {
  name: string;
  description: string;
  risk: RiskLevel;
  channels: string[]; // allowlist de canales permitidos
  handler: ToolHandler;
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool);
}

export function findTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function listTools(channel?: string): Tool[] {
  const all = Array.from(registry.values());
  if (!channel) return all;
  return all.filter((t) => t.channels.includes(channel));
}

export async function runTool(
  name: string,
  input: string,
  channel: string
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) {
    log("error", `Herramienta desconocida: ${name}`);
    return `Error: la herramienta '${name}' no existe. Usa /tools para ver las disponibles.`;
  }

  if (!tool.channels.includes(channel)) {
    events.publish({
      type: "tool:blocked",
      tool: name,
      risk: tool.risk,
      detail: `canal '${channel}' no autorizado`,
      ts: Date.now(),
      channel,
    });
    log("warn", `Tool '${name}' bloqueada en canal '${channel}'`);
    return `Error: la herramienta '${name}' no está permitida en el canal '${channel}'.`;
  }

  const riskCheck = evaluateRisk({ tool: name, risk: tool.risk, channel });
  if (!riskCheck.allowed) {
    events.publish({
      type: "tool:blocked",
      tool: name,
      risk: tool.risk,
      detail: "nivel rojo",
      ts: Date.now(),
      channel,
    });
    return `BLOQUEADO: ${riskCheck.reason}`;
  }

  events.publish({
    type: "tool:executed",
    tool: name,
    risk: tool.risk,
    ts: Date.now(),
    channel,
  });

  try {
    return await tool.handler(input);
  } catch (err) {
    log("error", `Fallo en tool ${name}: ${String(err)}`);
    return `Error ejecutando '${name}': ${String(err)}`;
  }
}
