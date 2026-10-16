import { handleMessage } from "../src/core/engine.js";

async function main() {
  console.log(await handleMessage("buscar: qa junior", "cli"));
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
