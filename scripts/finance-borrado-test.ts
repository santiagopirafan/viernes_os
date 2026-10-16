import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "viernes-borrado-"));
process.chdir(tmp);

const finance = await import("../src/finance/finance.js");

const a = finance.parsearMovimientoTexto("ingreso rappi 40000 viaje");
const b = finance.parsearMovimientoTexto("egreso comida 12000");
if (!a || !b) throw new Error("parse fallo");
finance.guardarMovimiento({ ...a, nota: "prueba", origen: "prueba" });
finance.guardarMovimiento({ ...b, nota: "prueba", origen: "prueba" });
console.log("1:", finance.borrarMovimiento("quiero que elimines el último gasto"));
console.log("2:", finance.borrarMovimiento("limpia toda la tabla"));
console.log("3:", finance.borrarMovimiento("borra el movimiento 99"));
console.log("4:", JSON.stringify(finance.borrarMovimiento("borra esa foto")));
