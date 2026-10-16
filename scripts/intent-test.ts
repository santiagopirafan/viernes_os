import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "viernes-intent-"));

const { getConfig } = await import("../src/core/config.js");
getConfig();
process.chdir(tmp);

const { clasificarIntencion } = await import("../src/core/intent.js");
const { handleMessage } = await import("../src/core/engine.js");

for (const frase of [
  "registra que me gasté 8000 en desayuno",
  "quiero que elimines el último gasto",
  "cómo voy hoy",
  "busca trabajo de conductor",
  "cuéntame un chiste",
]) {
  console.log(`\n> ${frase}`);
  console.log(await handleMessage(frase, "cli"));
}
void clasificarIntencion;
