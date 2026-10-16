import { runTool } from "../src/tools/registry.js";
import "../src/tools/browser.js";

const out = (t: string, r: string) => console.log(`\n=== ${t} ===\n${r}`);

out("sesion", await runTool("browser", "sesion", "cli"));
out("estado", await runTool("browser", "estado", "cli"));
out("postular sin CV?", await runTool("browser", "postular", "cli"));
out("cerrar", await runTool("browser", "cerrar", "cli"));
