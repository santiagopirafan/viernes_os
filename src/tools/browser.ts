import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { registerTool } from "./registry.js";
import { log } from "../core/logger.js";
import { getCvPdfPath } from "./cv.js";
import { recordApplication } from "../jobs/applications.js";
import { upsertCuenta } from "../memory/sqlite.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROFILE_DIR = path.join(ROOT, "data", "browser-profile");

const LOGIN_URLS: Record<string, string> = {
  linkedin: "https://www.linkedin.com/login",
  computrabajo: "https://co.computrabajo.com/",
  elempleo: "https://www.elempleo.com/",
  magneto: "https://www.magneto365.com/",
};

const PORTALES = [
  { slug: "linkedin", nombre: "LinkedIn", host: "linkedin.com" },
  { slug: "computrabajo", nombre: "Computrabajo", host: "computrabajo.com" },
  { slug: "elempleo", nombre: "El Empleo", host: "elempleo.com" },
  { slug: "magneto", nombre: "Magneto", host: "magneto365.com" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RE_APLICAR = /postularme|postular|aplicar|apply|solicitar/i;
const RE_ENVIAR = /^(enviar|confirmar|finalizar|enviar postulaci[oó]n|postularme|aplicar|apply)$/i;
const RE_LOGIN_URL = /(login|iniciar-sesion|iniciar_sesion|signin|\/auth\/|account\/login)/i;
const RE_LOGIN_TXT =
  /(continúa con tu correo|continua con tu correo|ingresa y aplica|inicia sesión|iniciar sesión|continúa con google|continua con google|¿olvidaste tu contraseña\?|formato de e-mail incorrecto|ingresa con tu correo|tu próximo trabajo está aquí|recuperar contraseña)/i;
const RE_EXITO =
  /(te aplicaste correctamente|aplicaste correctamente|aplicaste a esta oferta|postulaci[oó]n (enviada|exitosa|recibida)|gracias por tu postulaci|ya postulaste|ya aplicaste|hemos adjuntado tu hoja de vida|tu postulaci[oó]n fue|mis postulaciones)/i;

function portalDe(url: string): { slug: string; nombre: string } {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const p = PORTALES.find((x) => host.endsWith(x.host));
  return { slug: p?.slug ?? "otro", nombre: (p?.nombre ?? host) || "desconocido" };
}

let ctxPromise: Promise<BrowserContext> | null = null;

function getCtx(): Promise<BrowserContext> {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      let lastErr: unknown = null;
      for (const channel of ["msedge", "chrome"]) {
        try {
          const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
            channel,
            headless: false,
            viewport: null,
            args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
          });
          log("info", `Navegador abierto con perfil persistente (${channel})`);
          return ctx;
        } catch (err) {
          lastErr = err;
        }
      }
      ctxPromise = null;
      throw new Error(`No pude abrir el navegador: ${String(lastErr).slice(0, 200)}`);
    })();
    ctxPromise.catch(() => {
      ctxPromise = null;
    });
  }
  return ctxPromise;
}

async function activePage(ctx: BrowserContext): Promise<Page> {
  const pages = ctx.pages();
  const live = pages.find((p) => !p.url().startsWith("about:blank"));
  if (live) return live;
  if (pages.length > 0) return pages[0];
  return ctx.newPage();
}

async function runBrowserTool(input: string): Promise<string> {
  const cmd = input.trim();
  const lower = cmd.toLowerCase();

  if (lower === "cerrar") {
    if (ctxPromise) {
      const ctx = await ctxPromise;
      await ctx.close();
    }
    ctxPromise = null;
    return "Navegador cerrado. La sesion guardada sigue en data/browser-profile.";
  }

  const ctx = await getCtx();

  if (lower === "estado") {
    const pages = ctx.pages();
    if (!pages.length) return "Navegador abierto sin pestanas. Usa: browser abrir <url>";
    const lineas = await Promise.all(
      pages.map(async (p) => `- ${p.url()} | ${(await p.title().catch(() => "")) || "(sin titulo)"}`)
    );
    return "Pestanas abiertas:\n" + lineas.join("\n");
  }

  if (lower.startsWith("login")) {
    const sitio = lower.split(/\s+/)[1] ?? "";
    const url = LOGIN_URLS[sitio];
    if (!url) {
      return "Portales disponibles: " + Object.keys(LOGIN_URLS).join(", ") + "\nEj: browser login linkedin";
    }
    const page = await activePage(ctx);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return `Abri ${sitio}. Inicia sesion en la ventana que se abrio en tu PC; la sesion queda guardada para siempre.\nCuando entres, escribe 'browser estado'.`;
  }

  if (lower.startsWith("abrir ")) {
    let url = cmd.slice(6).trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const page = await activePage(ctx);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title();
    return `Abierto: ${title || "(sin titulo)"}\n${page.url()}`;
  }

  if (lower.startsWith("click ")) {
    const texto = cmd.slice(6).trim();
    const page = await activePage(ctx);
    const locator = page.getByText(texto, { exact: false }).first();
    await locator.click({ timeout: 8000 });
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    return `Click en "${texto}". Ahora: ${page.url()}`;
  }

  if (lower.startsWith("escribir ")) {
    const resto = cmd.slice(9).trim();
    const [selector, ...valor] = resto.split("|");
    const page = await activePage(ctx);
    const locator = page.locator(selector.trim()).first();
    await locator.fill(valor.join("|").trim(), { timeout: 8000 });
    return `Escribi en ${selector.trim()}.`;
  }

  if (lower === "screenshot" || lower === "captura") {
    const page = await activePage(ctx);
  const file = path.join(ROOT, "data", "screenshots", `captura-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return `Captura guardada en ${file}`;
  }

  if (lower === "sesion" || lower === "sesiones") {
    const cookies = await ctx.cookies();
    const AUTH_RE = /(li_at|sessionid|session|sessid|jsession|asp\.net|_token|token|auth|sid$|^sid)/i;
      const lineas = PORTALES.map((p) => {
        const mias = cookies.filter(
          (c) => c.domain === p.host || c.domain === `.${p.host}` || c.domain.endsWith(`.${p.host}`)
        );
        const auth = mias.some((c) => AUTH_RE.test(c.name));
        upsertCuenta({ portal: p.nombre, slug: p.slug, nombre: p.nombre, activa: auth ? 1 : 0, ultima_revision: Date.now(), notas: auth ? `${mias.length} cookies` : "sin sesion activa" });
        if (!mias.length) return `- ${p.nombre}: SIN sesion -> escribe 'browser login ${p.slug}'`;
        if (auth) return `- ${p.nombre}: sesion ACTIVA (${mias.length} cookies)`;
        if (p.slug === "linkedin") return `- ${p.nombre}: solo cookies de navegacion -> SIN sesion -> 'browser login linkedin'`;
        return `- ${p.nombre}: cookies presentes pero sin marca de sesion (${mias.length})`;
      });
    return "Estado de sesiones en tu navegador:\n" + lineas.join("\n");
  }

  if (lower.startsWith("postular")) {
    const url = cmd.slice("postular".length).trim();
    if (!url) return "Pega la URL de la vacante. Ej: browser postular https://co.computrabajo.com/...";
    return ejecutarPostulacion(ctx, url);
  }

  return "Comandos de browser:\n- abrir <url>\n- login <linkedin|computrabajo|elempleo|magneto>\n- sesion\n- postular <url>\n- estado\n- click <texto visible>\n- escribir <selector> | <texto>\n- screenshot\n- cerrar";
}

async function clicVisible(scope: Page, re: RegExp): Promise<boolean> {
  const intentos = [
    scope.getByRole("button", { name: re }).first(),
    scope.getByRole("link", { name: re }).first(),
    scope.getByText(re, { exact: false }).first(),
  ];
  for (const loc of intentos) {
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        await loc.click({ timeout: 4000 });
        return true;
      }
    } catch {
      // sigue con el siguiente selector
    }
  }
  return false;
}

async function buscarEnFrames<T>(page: Page, fn: (scope: Page) => Promise<T | null>): Promise<T | null> {
  const scopes = [page, ...page.frames()] as unknown as Page[];
  for (const scope of scopes) {
    try {
      const r = await fn(scope);
      if (r) return r;
    } catch {
      // frame muerto
    }
  }
  return null;
}

async function adjuntarCV(page: Page, cvPath: string): Promise<boolean> {
  const hecho = await buscarEnFrames(page, async (scope) => {
    const inp = scope.locator('input[type="file"]').first();
    if ((await inp.count()) > 0) {
      await inp.setInputFiles(cvPath);
      return true;
    }
    return null;
  });
  return hecho === true;
}

async function tomarCaptura(page: Page): Promise<string> {
  const file = path.join(ROOT, "data", "screenshots", `captura-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
  return file;
}

async function ejecutarPostulacion(ctx: BrowserContext, url: string): Promise<string> {
  const cvPath = getCvPdfPath();
  if (!cvPath) {
    return "No tengo tu CV en PDF. Cargalo primero: 'usa cv C:/ruta/CV.pdf' o enviamelo por WhatsApp.";
  }

  const { slug, nombre: portal } = portalDe(url);
  const page = await activePage(ctx);

  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const cookies = await ctx.cookies();
  const mias = cookies.filter(
    (c) => c.domain === host || c.domain === `.${host}` || c.domain.endsWith(`.${host}`)
  );
  if (!mias.length) {
    return `No hay ninguna sesion de ${portal} en el navegador. No toque nada.\nEscribe 'browser login ${slug}' y entra una vez; despues la sesion queda guardada para siempre.`;
  }

  const antes = [...ctx.pages()];
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1500);

  const titulo = ((await page.title().catch(() => "")) || url).slice(0, 120);
  const clicAplicar = await clicVisible(page, RE_APLICAR);
  if (!clicAplicar) {
    const captura = await tomarCaptura(page);
    recordApplication({
      url,
      portal,
      titulo,
      estado: "fallida",
      nota: "No encontre el boton de postulacion (¿sesion caida o vacante cerrada?)",
    });
    return `No encontre el boton de postulacion en "${titulo}".\nPortal: ${portal}\nPosibles causas: no hay sesion ('browser sesion'), la vacante cerro o la pagina cambio.\nCaptura: ${captura}`;
  }

  await sleep(1800);
  const nuevas = ctx.pages().filter((p) => !antes.includes(p));
  const activo = nuevas.length ? nuevas[nuevas.length - 1] : page;

  const conCV = await adjuntarCV(activo, cvPath);
  const clicFinal = await buscarEnFrames(activo, async (scope) =>
    (await clicVisible(scope, RE_ENVIAR)) ? true : null
  );
  await sleep(2000);

  const veredicto = await evaluarVeredicto(activo);
  const estado = veredicto.estado;
  const notaParts = [
    clicFinal ? "pulsee el boton final" : "no encontre boton final",
    `CV adjunto: ${conCV ? "si" : "no"}`,
    veredicto.nota,
  ];
  const nota = notaParts.join("; ");

  recordApplication({ url, portal, titulo, estado, nota });
  const captura = await tomarCaptura(activo);
  const detalle = [
    `Postulacion ${estado.toUpperCase()} - ${portal}`,
    `Titulo: ${titulo}`,
    `Nota: ${nota}`,
    `Captura: ${captura}`,
    estado === "fallida" && veredicto.login
      ? `La pagina me llevo al login. Escribe 'browser login ${slug}', entra una vez y vuelve a intentar 'postular 1'.`
      :       estado === "pendiente"
        ? "\nNo pude verificar el envio. Mira la ventana del navegador; si ya entró, corrige con '/empleo confirmar <url>'."
        : offerHint(),
  ].join("\n");
  return detalle;
}

async function evaluarVeredicto(page: Page): Promise<{ estado: "enviada" | "pendiente" | "fallida"; nota: string; login: boolean }> {
  const url = page.url();
  const texto = (await page.textContent("body").catch(() => "")) || "";
  const enLogin = RE_LOGIN_URL.test(url) || RE_LOGIN_TXT.test(texto);
  if (enLogin) {
    return { estado: "fallida", nota: "la pagina pide iniciar sesion", login: true };
  }
  if (RE_EXITO.test(texto)) {
    return { estado: "enviada", nota: "la pagina confirmo la postulacion", login: false };
  }
  return {
    estado: "pendiente",
    nota: "no pude confirmar ni rechazar el envio en la pagina",
    login: false,
  };
}

function offerHint(): string {
  return "Si venias revisando ofertas: 'siguiente' para la otra o 'listo' para terminar. Con '/empleo' ves tu historial.";
}

registerTool({
  name: "browser",
  description: "Abre un navegador con tu sesion guardada (LinkedIn, Computrabajo, etc.) para poder postular.",
  risk: "yellow",
  channels: ["cli", "whatsapp"],
  handler: runBrowserTool,
});
