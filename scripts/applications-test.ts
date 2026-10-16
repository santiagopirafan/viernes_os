import { recordApplication, hasApplied, listAplicaciones, removeAplicacion, empleoResumen } from "../src/jobs/applications.js";
import { getCvPdfPath } from "../src/tools/cv.js";

console.log("CV PDF ->", getCvPdfPath());

recordApplication({
  url: "https://co.computrabajo.com/trabajo-de-prueba",
  portal: "Computrabajo",
  titulo: "Vacante de prueba",
  empresa: "QA Tests S.A.",
  estado: "pendiente",
  score: 77,
  nota: "prueba automatizada",
});
console.log("duplicado (debe actualizar, no fallar):");
console.log(recordApplication({
  url: "https://co.computrabajo.com/trabajo-de-prueba",
  portal: "Computrabajo",
  titulo: "Vacante de prueba",
  estado: "enviada",
  nota: "actualizada",
}));

console.log("hasApplied ->", hasApplied("https://co.computrabajo.com/trabajo-de-prueba")?.estado);
console.log("hasApplied URL desconocida ->", hasApplied("https://ejemplo.com/x") ?? "undefined");
console.log("--- resumen ---");
console.log(empleoResumen());
console.log(removeAplicacion("https://co.computrabajo.com/trabajo-de-prueba"));
console.log("quedan:", listAplicaciones().length);
