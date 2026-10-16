import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "viernes-finance-"));
process.chdir(tmp);

const finance = await import("../src/finance/finance.js");

const ingreso = finance.parsearMovimientoTexto("ingreso rappi 45000 viaje");
const egreso = finance.parsearMovimientoTexto("egreso gasolina 20000");
if (!ingreso || !egreso) throw new Error("No se pudo interpretar la prueba");

const idIngreso = finance.guardarMovimiento({ ...ingreso, nota: "prueba local", origen: "prueba-local" });
const idEgreso = finance.guardarMovimiento({ ...egreso, nota: "prueba local", origen: "prueba-local" });

console.log(`Movimientos de prueba: #${idIngreso}, #${idEgreso}`);
console.log(`\n${finance.borrarMovimiento("elimina el movimiento 2")}`);
console.log(`\n${finance.borrarMovimiento("borra el último registro")}`);
console.log(`\n${finance.resumenDia()}`);
console.log(`\n${finance.ultimosMovimientos(5)}`);
console.log(`\n${finance.crearMeta("meta crear rappi 60000 diario")}`);
console.log(`\n${finance.exportarParaPowerBI()}`);
console.log(`\nBase temporal: ${path.join(tmp, "memory", "viernes.db")}`);
