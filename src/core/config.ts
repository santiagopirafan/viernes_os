import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY es obligatoria"),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  GROQ_TRANSCRIBE_MODEL: z.string().default("whisper-large-v3"),
  CLI_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3911),
  DASHBOARD_TOKEN: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ALLOWED_IDS: z.string().optional(),
  POWERBI_TENANT_ID: z.string().optional(),
  POWERBI_CLIENT_ID: z.string().optional(),
  POWERBI_CLIENT_SECRET: z.string().optional(),
  POWERBI_WORKSPACE_ID: z.string().optional(),
  POWERBI_DATASET_NAME: z.string().default("viernes-finanzas"),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_SHEETS_ID: z.string().optional(),
  GOOGLE_SHARE_EMAIL: z.string().optional(),
  GOOGLE_SHEETS_TITLE: z.string().default("Viernes Finanzas"),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof envSchema> & {
  rateLimitWindowMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(" | ");
    throw new Error(
      `Configuracion invalida -> ${issues}. Revisa .env (usa .env.example como guia).`
    );
  }
  return { ...parsed.data, rateLimitWindowMs: 60_000 };
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached === null) {
    cached = loadConfig();
  }
  return cached;
}
