import { handleMessage } from "../src/core/engine.js";

const out = (t: string, r: string) => console.log(`\n=== ${t} ===\n${r}`);

out("buscar", await handleMessage("buscar: qa junior", "cli"));
out("siguiente", await handleMessage("siguiente", "cli"));
out("postular 2 (debe dar FICHA, no ejecutar)", await handleMessage("postular 2", "cli"));
out("mensaje normal (debe cancelar la ficha)", await handleMessage("hola Viernes", "cli"));
out("postular 99 (numero invalido)", await handleMessage("postular 99", "cli"));
out("listo", await handleMessage("listo", "cli"));
out("postular sin busqueda previa", await handleMessage("postular 1", "cli"));
out("/empleo", await handleMessage("/empleo", "cli"));
out("/help", await handleMessage("/help", "cli"));
