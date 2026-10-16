import { analizarTransferencia, exportarParaPowerBI, parsearMovimientoTexto, resumenDia } from "../src/finance/finance.js";

const pruebas = [
  "ingreso rappi 45000 viaje",
  "egreso gasolina 20000",
  "ingreso didi propina $12.500",
  "Quiero agregar un gasto que hice el día de hoy, el desayuno de $8,600 pesos.",
];

for (const prueba of pruebas) {
  console.log(`\nEntrada: ${prueba}`);
  console.log(parsearMovimientoTexto(prueba));
}

console.log(`\n${resumenDia()}`);
console.log(`\n${exportarParaPowerBI()}`);

const comprobantes = [
  "Transferencia exitosa Bancolombia Para: Nequi Valor $ 85.000 Tel 300 123 4567 Fecha 16/10/2026",
  "Comprobante Davivienda De: Davivienda Para: Llave Bancolombia $120.500 Referencia 3001234567",
  "Nequi Te enviaron $ 25.000 de Bancolombia",
];
for (const c of comprobantes) {
  console.log(`\nComprobante: ${c}`);
  console.log(analizarTransferencia(c));
}
