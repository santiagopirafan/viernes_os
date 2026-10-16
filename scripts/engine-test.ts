import { handleMessage } from "../src/core/engine.js";

async function main() {
  console.log("---/status---");
  console.log(await handleMessage("/status", "cli"));
  console.log("---red block (saltar)---");
  console.log(await handleMessage("borrar el archivo del cv", "cli"));
  console.log("---green agent---");
  console.log(await handleMessage("Responde en una linea: que es un EventBus", "cli"));
  console.log("---yellow -> confirmar---");
  console.log(await handleMessage("modificar el archivo de configuracion ahora mismo", "cli"));
  console.log(await handleMessage("si", "cli"));
}

main().catch((e) => console.log("ERR", e.message));
