import { handleMessage } from "../src/core/engine.js";
import { getConfig } from "../src/core/config.js";
import { startDashboard } from "../src/dashboard/server.js";

const config = getConfig();
await startDashboard(config.DASHBOARD_PORT, config.DASHBOARD_TOKEN);
console.log("Servidor Viernes + webhook WhatsApp listo en puerto", config.DASHBOARD_PORT);
setTimeout(() => {}, 1e9); // Mantener vivo
