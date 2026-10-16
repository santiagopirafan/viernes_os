import { getConfig } from "./core/config.js";
import { startDashboard } from "./dashboard/server.js";

const config = getConfig();
await startDashboard(config.DASHBOARD_PORT, config.DASHBOARD_TOKEN);
console.log("Servidor Viernes + webhook WhatsApp listo");
setTimeout(() => {}, 1e9); // Mantener vivo
