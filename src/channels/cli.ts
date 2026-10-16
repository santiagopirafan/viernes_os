import readline from "node:readline";
import { handleMessage } from "../core/engine.js";
import { log } from "../core/logger.js";
import { getConfig } from "../core/config.js";
import { startDashboard } from "../dashboard/server.js";

const config = getConfig();
void startDashboard(config.DASHBOARD_PORT, config.DASHBOARD_TOKEN);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "Viernes> ",
});

console.log("Viernes OS - CLI. Escribe /help para ver comandos. Ctrl+C o Ctrl+D para salir.");
rl.prompt();

rl.on("line", (line) => {
  void (async () => {
    try {
      const response = await handleMessage(line, "cli");
      console.log(response);
    } catch (err) {
      log("error", `Error en CLI: ${String(err)}`);
      console.error(`Error: ${String(err)}`);
    }
    rl.prompt();
  })();
});

rl.on("close", () => {
  console.log("\nSaliendo de Viernes.");
  process.exit(0);
});
