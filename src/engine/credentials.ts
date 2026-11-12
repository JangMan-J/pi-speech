import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The part of Pi's model registry used to look up stored credentials. */
export interface KeyRegistry {
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

/**
 * OpenRouter API key: OPENROUTER_API_KEY (empty counts as unset), else Pi's credentials for provider
 * `openrouter`, else `providers.openrouter.apiKey` in `<agentDir>/models.json`. Undefined when none.
 */
export async function resolveApiKey(
  registry: KeyRegistry | undefined,
  env: Record<string, string | undefined>,
  agentDir: string,
): Promise<string | undefined> {
  const envKey = env.OPENROUTER_API_KEY;
  if (envKey) return envKey;

  try {
    const key = await registry?.getApiKeyForProvider("openrouter");
    if (key) return key;
  } catch {
    /* no stored credential */
  }

  try {
    const config = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
      providers?: { openrouter?: { apiKey?: unknown } };
    };
    const key = config.providers?.openrouter?.apiKey;
    if (typeof key === "string" && key.length > 0) return key;
  } catch {
    /* missing or unreadable models.json */
  }
  return undefined;
}

/**
 * The xAI token: what Pi's credentials hold for provider `xai` (the refreshed login token, or a stored key).
 * Nothing else is read for xAI. Undefined when Pi has no xAI credential.
 */
export async function resolveXaiToken(registry: KeyRegistry | undefined): Promise<string | undefined> {
  try {
    const token = await registry?.getApiKeyForProvider("xai");
    return token || undefined;
  } catch {
    return undefined;
  }
}
