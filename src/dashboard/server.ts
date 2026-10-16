import Fastify, { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { events } from "../core/events.js";
import { log } from "../core/logger.js";
import { registerWhatsAppRoutes } from "../channels/whatsapp.js";

interface WsClient {
  send: (data: string) => void;
}

const clients = new Set<WsClient>();
const stats = { messages: 0, toolExecutions: 0, blocked: 0, logs: 0 };

events.onEvent("*", (event) => {
  if (event.type === "message:in" || event.type === "message:out") stats.messages++;
  if (event.type === "tool:executed") stats.toolExecutions++;
  if (event.type === "tool:blocked" || event.type === "risk:blocked") stats.blocked++;
  if (event.type === "log") stats.logs++;

  const payload = JSON.stringify(event);
  for (const client of clients) {
    try {
      client.send(payload);
    } catch {
      clients.delete(client);
    }
  }
});

const HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Viernes · Command Center</title>
<style>
  body { background:#0d1117; color:#c9d1d9; font-family:ui-monospace,Consolas,monospace; margin:0; padding:16px; }
  h1 { font-size:16px; margin:0 0 12px; color:#58a6ff; }
  .pill { display:inline-block; padding:2px 10px; border-radius:12px; font-size:12px; margin-left:8px; background:#238636; color:#fff; }
  .pill.yellow { background:#9e6a03; } .pill.red { background:#da3633; }
  #events { border:1px solid #30363d; border-radius:6px; height:60vh; overflow:auto; padding:10px; font-size:12px; white-space:pre-wrap; }
  .green{color:#3fb950;} .yellow{color:#d29922;} .red{color:#f85149;} .blue{color:#58a6ff;} .muted{color:#8b949e;}
  #counters { margin:10px 0; font-size:12px; }
</style>
</head>
<body>
<h1>Viernes · Command Center <span id="pill" class="pill">🟢 verde</span></h1>
<div id="counters" class="muted"></div>
<div id="events"></div>
<script>
  const el = document.getElementById('events');
  const pill = document.getElementById('pill');
  const counters = document.getElementById('counters');
  const token = new URLSearchParams(location.search).get('token');
  const qs = token ? '?token=' + encodeURIComponent(token) : '';
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws' + qs);
  ws.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    const time = new Date(e.ts).toLocaleTimeString();
    let line, cls = 'blue';
    if (e.type === 'log') { cls = e.level === 'error' ? 'red' : e.level === 'warn' ? 'yellow' : 'blue'; line = '[' + time + '] [' + e.level + '] ' + e.message; }
    else if (e.type === 'message:in') { cls = 'blue'; line = '[' + time + '] > ' + e.content; }
    else if (e.type === 'message:out') { cls = 'green'; line = '[' + time + '] < ' + String(e.content).slice(0, 200); }
    else if (e.type === 'tool:executed') { cls = 'green'; line = '[' + time + '] tool ' + e.tool + ' (' + e.risk + ')'; }
    else if (e.type === 'tool:blocked') { cls = 'red'; line = '[' + time + '] BLOQUEADA tool ' + e.tool + ': ' + (e.detail || ''); }
    else if (e.type === 'risk:blocked') { cls = 'red'; line = '[' + time + '] BLOQUEO: ' + e.reason; pill.className = 'pill red'; pill.textContent = '🔴 bloqueo'; }
    else { cls = 'blue'; line = '[' + time + '] ' + JSON.stringify(e); }
    el.innerHTML += '<span class="' + cls + '">' + line.replace(/</g,'&lt;') + '</span>\\n';
    el.scrollTop = el.scrollHeight;
  };
  ws.onclose = () => { pill.className = 'pill yellow'; pill.textContent = '🟡 desconectado'; };
  async function poll() {
    try {
      const r = await fetch('/api/status' + qs);
      const s = await r.json();
      counters.textContent = 'mensajes: ' + s.counts.messages + ' · tools: ' + s.counts.toolExecutions + ' · bloqueos: ' + s.counts.blocked + ' · logs: ' + s.counts.logs;
    } catch {}
  }
  setInterval(poll, 2000); poll();
</script>
</body>
</html>`;

async function buildApp(token?: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(HTML);
  });

  app.get("/api/status", async () => ({
    status: "ok",
    channel: "cli",
    counts: stats,
    timestamp: Date.now(),
  }));

  app.get<{ Querystring: { token?: string } }>("/ws", { websocket: true }, (socket, req) => {
    if (token && req.query.token !== token) {
      socket.close(4401, "no autorizado");
      return;
    }
    const client: WsClient = { send: (d) => socket.send(d) };
    clients.add(client);
    socket.on("close", () => clients.delete(client));
  });

  // Webhook de WhatsApp (parser de body crudo aislado en un plugin)
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body)
    );
    await registerWhatsAppRoutes(scope);
  });

  return app;
}

export async function startDashboard(port: number, token?: string): Promise<void> {
  const app = await buildApp(token);
  const runtimePort = Number(process.env.PORT ?? port);
  const host = process.env.HOST ?? "127.0.0.1";
  try {
    await app.listen({ port: runtimePort, host });
    log("info", `Dashboard Command Center en http://${host}:${runtimePort}`);
    if (token) {
      log("info", "Dashboard protegido por DASHBOARD_TOKEN (añade ?token=<valor> a la URL)");
    }
  } catch (err) {
    log("warn", `No se pudo iniciar el dashboard: ${String(err).slice(0, 200)}`);
  }
}
