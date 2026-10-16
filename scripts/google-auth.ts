import http from "node:http";
import { getConfig } from "../src/core/config.js";

const PUERTO = 53682;
const REDIRECT = `http://127.0.0.1:${PUERTO}/`;
const SCOPE = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";

const cfg = getConfig();
if (!cfg.GOOGLE_OAUTH_CLIENT_ID || !cfg.GOOGLE_OAUTH_CLIENT_SECRET) {
  console.log("Primero pon en .env GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET (OAuth client ID tipo Desktop).");
  process.exit(1);
}

const url =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: cfg.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

console.log("1. Abre esta URL en tu navegador y autoriza:\n");
console.log(url);
console.log("\n2. Espero la respuesta en esta terminal...\n");

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url ?? "", REDIRECT).searchParams.get("code");
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Falta el código. Reintenta.");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Listo, puedes cerrar esta ventana y volver a la terminal.");
  server.close();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.GOOGLE_OAUTH_CLIENT_ID as string,
      client_secret: cfg.GOOGLE_OAUTH_CLIENT_SECRET as string,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  const data = (await r.json()) as { refresh_token?: string; error?: string };
  if (!r.ok || !data.refresh_token) {
    console.log("Falló el intercambio:", JSON.stringify(data).slice(0, 300));
    process.exit(1);
  }
  console.log("\nPega esto en tu .env:\n");
  console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${data.refresh_token}`);
});

server.listen(PUERTO, "127.0.0.1");
