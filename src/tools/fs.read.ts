import fs from "node:fs";
import path from "node:path";
import { registerTool } from "./registry.js";

registerTool({
  name: "fs.read",
  description: "Lee el contenido de un archivo local (herramienta nivel Verde).",
  risk: "green",
  channels: ["cli"],
  handler: (input: string) => {
    const filePath = path.resolve(input.trim());
    if (!fs.existsSync(filePath)) return `No existe: ${filePath}`;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return `No es un archivo: ${filePath}`;
    return fs.readFileSync(filePath, "utf8").slice(0, 4000);
  },
});
