import { startDashboard } from "../src/dashboard/server.js";
import { events } from "../src/core/events.js";

async function main() {
  await startDashboard(3911);
  events.publish({ type: "log", level: "info", message: "prueba dashboard", ts: Date.now() });
  const api = await fetch("http://127.0.0.1:3911/api/status");
  console.log("api:", await api.json());
  const html = await (await fetch("http://127.0.0.1:3911/")).text();
  console.log("html bytes:", html.length);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
