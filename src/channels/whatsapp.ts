import crypto from "node:crypto";
import { FastifyInstance } from "fastify";
import { handleMessage } from "../core/engine.js";
import { log } from "../core/logger.js";
import { getConfig } from "../core/config.js";
import { extractPdfText, saveCv } from "../tools/cv.js";
import { proponerMovimientoDesdeCaptura } from "../finance/finance.js";
import { guardarAudio, guardarTranscripcion, transcribirAudio, ultimaTranscripcion } from "../tools/voz.js";

function allowedIds(): string[] {
  const raw = getConfig().WHATSAPP_ALLOWED_IDS ?? "";
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function verifySignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sendWhatsAppText(to: string, text: string): Promise<void> {
  const { WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID } = getConfig();
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    log("warn", `WhatsApp no configurado (ACCESS_TOKEN/PHONE_NUMBER_ID). Respuesta solo en logs: ${text.slice(0, 120)}`);
    return;
  }
  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text.slice(0, 4000) },
    }),
  });
  if (!res.ok) {
    log("error", `WhatsApp API error ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  }
}

async function downloadWhatsAppMedia(mediaId: string): Promise<Buffer | null> {
  const { WHATSAPP_ACCESS_TOKEN } = getConfig();
  if (!WHATSAPP_ACCESS_TOKEN) return null;
  const auth = { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` };
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: auth });
  if (!metaRes.ok) {
    log("error", `WhatsApp media metadata ${metaRes.status}: ${await metaRes.text().then((t) => t.slice(0, 200))}`);
    return null;
  }
  const meta = (await metaRes.json()) as { url?: string };
  if (!meta.url) return null;
  const fileRes = await fetch(meta.url, { headers: auth });
  if (!fileRes.ok) {
    log("error", `WhatsApp media download ${fileRes.status}`);
    return null;
  }
  return Buffer.from(await fileRes.arrayBuffer());
}

export async function registerWhatsAppRoutes(app: FastifyInstance): Promise<void> {
  app.get("/webhook/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const mode = q["hub.mode"];
    const token = q["hub.verify_token"];
    const challenge = q["hub.challenge"];
    const expected = getConfig().WHATSAPP_VERIFY_TOKEN;

    if (mode === "subscribe" && expected && token === expected && challenge) {
      reply.type("text/plain").send(challenge);
      return;
    }
    reply.code(403).send({ error: "verificación fallida" });
  });

  app.post("/webhook/whatsapp", async (req, reply) => {
    const raw = req.body as unknown as Buffer;
    const appSecret = getConfig().WHATSAPP_APP_SECRET;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    if (appSecret && !verifySignature(raw, signature, appSecret)) {
      reply.code(401).send({ error: "firma HMAC inválida" });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      reply.code(400).send({ error: "JSON inválido" });
      return;
    }

    // Meta espera 200 rápido; el proceso del mensaje continúa en segundo plano.
    reply.code(200).send({ received: true });

    const data = body as {
      entry?: {
        changes?: {
          value: {
            messages?: {
              from: string;
              id: string;
              type?: string;
              text?: { body: string };
              audio?: { id: string; mime_type?: string; voice?: boolean };
              image?: { id: string; mime_type?: string };
              caption?: string;
              document?: { id: string; mime_type?: string; filename?: string };
            }[];
          };
        }[];
      }[];
    };

    for (const entry of data.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value.messages ?? []) {
          const from = message.from;
          const text = message.text?.body ?? "";
          const doc = message.document;
          const image = message.image;
          const audio = message.audio;
          const pista = message.caption ?? "";

          if (!text && !doc && !image && !audio) continue;

          if (!allowedIds().includes(from)) {
            log("warn", `Webhook WhatsApp: remitente no autorizado ${from} (ignorado)`);
            continue;
          }

          if (audio && !text && !doc && !image) {
            log("info", `WhatsApp [${from}]: nota de voz (${audio.mime_type ?? "audio"})`);
            handleIncomingAudio(from, audio.id, audio.mime_type ?? "audio/ogg").catch((err) =>
              log("error", `WhatsApp audio fallo: ${String(err).slice(0, 200)}`)
            );
            continue;
          }

          if (text.trim().toLowerCase() === "/voz ver") {
            const ultima = ultimaTranscripcion(`whatsapp:${from}`);
            await sendWhatsAppText(
              from,
              ultima ? `Última transcripción:\n${ultima.slice(0, 3500)}` : "Aún no tengo ninguna transcripción de voz."
            );
            continue;
          }

          if (image && !text && !doc) {
            log("info", `WhatsApp [${from}]: imagen ${image.mime_type ?? "imagen"}`);
            handleIncomingImage(from, image.id, pista).catch((err) =>
              log("error", `WhatsApp imagen fallo: ${String(err).slice(0, 200)}`)
            );
            continue;
          }

          if (!text && doc) {
            const filename = doc.filename ?? "documento";
            log("info", `WhatsApp [${from}]: documento ${filename} (${doc.mime_type ?? "???"})`);
            handleIncomingDocument(from, filename, doc.mime_type ?? "", doc.id).catch((err) =>
              log("error", `WhatsApp documento fallo: ${String(err).slice(0, 200)}`)
            );
            continue;
          }

          log("info", `WhatsApp [${from}]: ${text.slice(0, 80)}`);
          handleMessage(text, "whatsapp")
            .then((response) => sendWhatsAppText(from, response))
            .catch((err) => log("error", `WhatsApp handler fallo: ${String(err).slice(0, 200)}`));
        }
      }
    }
  });
}

async function handleIncomingAudio(from: string, mediaId: string, mime: string): Promise<void> {
  const buffer = await downloadWhatsAppMedia(mediaId);
  if (!buffer) {
    await sendWhatsAppText(from, "No pude descargar la nota de voz. Reenvíala, por favor.");
    return;
  }
  const evidencia = guardarAudio(buffer, mime);
  const transcrito = await transcribirAudio(buffer, mime);
  if (!transcrito) {
    await sendWhatsAppText(from, "Escuché el audio, pero no entendí nada. Repítelo, por favor.");
    return;
  }
  log("info", `Voz [${from}]: ${transcrito.slice(0, 120)} (${evidencia})`);
  guardarTranscripcion(`whatsapp:${from}`, transcrito);
  const respuesta = await handleMessage(transcrito, "whatsapp");
  await sendWhatsAppText(from, respuesta);
}

async function handleIncomingImage(from: string, mediaId: string, pista: string): Promise<void> {
  const buffer = await downloadWhatsAppMedia(mediaId);
  if (!buffer) {
    await sendWhatsAppText(from, "No pude descargar la captura. Reenvíala, por favor.");
    return;
  }
  const propuesta = await proponerMovimientoDesdeCaptura("whatsapp", buffer, pista);
  log("info", `Captura financiera recibida de ${from}`);
  await sendWhatsAppText(from, propuesta);
}

async function handleIncomingDocument(from: string, filename: string, mime: string, mediaId: string): Promise<void> {
  const isPdf = mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    await sendWhatsAppText(from, `Solo se procesar PDF por ahora (recibi ${filename}).`);
    return;
  }
  const buffer = await downloadWhatsAppMedia(mediaId);
  if (!buffer) {
    await sendWhatsAppText(from, "No pude descargar el archivo. Reenvialo, porfa.");
    return;
  }
  const texto = await extractPdfText(new Uint8Array(buffer));
  if (texto.length < 50) {
    await sendWhatsAppText(from, "El PDF no tiene texto extraible (parece escaneado o foto). Envia un CV con texto.");
    return;
  }
  saveCv(texto, { nombre: filename, fuente: "whatsapp", pdf: buffer });
  log("info", `CV guardado desde WhatsApp: ${filename} (${texto.length} chars)`);
  await sendWhatsAppText(
    from,
    `CV recibido: ${filename}\n${texto.length} caracteres cargados. Ya lo uso para puntuar las vacantes.\n\nPrimeras lineas:\n${texto.slice(0, 400)}`
  );
}
