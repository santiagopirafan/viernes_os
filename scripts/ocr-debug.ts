import fs from "node:fs";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { analizarTransferencia } from "../src/finance/finance.js";

const buffer = fs.readFileSync(process.argv[2]);
const mejorada = await sharp(buffer).resize({ width: 1600, withoutEnlargement: false }).grayscale().normalize().sharpen().toBuffer();
const worker = await createWorker(["spa", "eng"]);
await worker.setParameters({ tessedit_pageseg_mode: "3" });
const { data } = await worker.recognize(mejorada);
await worker.terminate();
console.log("===== TEXTO OCR =====");
console.log(data.text);
console.log("===== ANALISIS =====");
console.log(analizarTransferencia(data.text));
