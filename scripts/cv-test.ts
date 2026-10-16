import fs from "node:fs";
import { extractPdfText, saveCv } from "../src/tools/cv.js";

const ruta = process.argv[2];
if (!ruta) {
  console.log("Uso: npx tsx scripts/cv-test.ts <ruta.pdf>");
  process.exit(1);
}
const buf = fs.readFileSync(ruta);
const texto = await extractPdfText(new Uint8Array(buf));
console.log("caracteres:", texto.length);
console.log("---- primeras 400 lineas de chars ----");
console.log(texto.slice(0, 400));
if (process.argv.includes("--save")) {
  saveCv(texto, { nombre: ruta.split(/[\\/]/).pop() ?? "cv.pdf", fuente: "cli" });
  console.log("guardado en data/cv.txt");
}
