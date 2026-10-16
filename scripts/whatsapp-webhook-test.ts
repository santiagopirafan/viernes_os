import crypto from "node:crypto";
import Fastify from "fastify";

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "placeholder";
process.env.WHATSAPP_VERIFY_TOKEN = "verify123";
process.env.WHATSAPP_APP_SECRET = "secret456";
process.env.WHATSAPP_ALLOWED_IDS = "573001234567";

async function main() {
  const { registerWhatsAppRoutes } = await import("../src/channels/whatsapp.js");
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  await registerWhatsAppRoutes(app);
  await app.listen({ port: 3913, host: "127.0.0.1" });

  // 1. Handshake de verificación de Meta
  const verify = await fetch("http://127.0.0.1:3913/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify123&hub.challenge=CHALLENGE");
  console.log("GET verify:", verify.status, await verify.text());

  // 2. Webhook con firma inválida
  const badBody = JSON.stringify({ entry: [] });
  const bad = await fetch("http://127.0.0.1:3913/webhook/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
    body: badBody,
  });
  console.log("POST firma inválida:", bad.status);

  // 3. Webhook con firma válida y remitente permitido
  const payload = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from: "573001234567", id: "w1", text: { body: "/status" } }],
            },
          },
        ],
      },
    ],
  });
  const signature = "sha256=" + crypto.createHmac("sha256", "secret456").update(Buffer.from(payload)).digest("hex");
  const ok = await fetch("http://127.0.0.1:3913/webhook/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body: payload,
  });
  console.log("POST válido:", ok.status, await ok.text());

  // 4. Webhook con un PDF adjunto (documento)
  const docPayload = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: "573001234567",
                  id: "w2",
                  document: { id: "MEDIA_ID_123", mime_type: "application/pdf", filename: "cv.pdf" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const docSignature = "sha256=" + crypto.createHmac("sha256", "secret456").update(Buffer.from(docPayload)).digest("hex");
  const doc = await fetch("http://127.0.0.1:3913/webhook/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": docSignature },
    body: docPayload,
  });
  console.log("POST documento PDF:", doc.status, await doc.text());

  await new Promise((r) => setTimeout(r, 2000));
  process.exit(0);
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
