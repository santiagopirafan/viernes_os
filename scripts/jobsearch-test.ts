import { runTool } from "../src/tools/registry.js";
import "../src/tools/jobSearch.js";

const input = process.argv.slice(2).join(" ") || "qa junior";
console.log(`Buscando: ${input}`);
const out = await runTool("jobsearch", input, "cli");
console.log(out);
