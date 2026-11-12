import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApiKey } from "../../src/engine/credentials";

// Adapted from pi-openrouter-multimodal test/unit/resolveApiKey.test.ts: the models.json fallback now
// lives in the agent directory, which is passed in, and an empty OPENROUTER_API_KEY counts as unset.
describe("resolveApiKey", () => {
  let dir: string;
  const registry = (key?: string) => ({
    getApiKeyForProvider: vi.fn(async (p: string) => (p === "openrouter" ? key : undefined)),
  });
  const modelsJson = (data: unknown) => writeFileSync(join(dir, "models.json"), JSON.stringify(data));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-speech-cred-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prefers OPENROUTER_API_KEY", async () => {
    modelsJson({ providers: { openrouter: { apiKey: "sk-file" } } });
    const key = await resolveApiKey(registry("sk-registry"), { OPENROUTER_API_KEY: "sk-env" }, dir);
    expect(key).toBe("sk-env");
  });

  it("treats an empty OPENROUTER_API_KEY as unset and asks Pi's credentials for openrouter", async () => {
    const reg = registry("sk-registry");
    expect(await resolveApiKey(reg, { OPENROUTER_API_KEY: "" }, dir)).toBe("sk-registry");
    expect(reg.getApiKeyForProvider).toHaveBeenCalledWith("openrouter");
  });

  it("falls back to providers.openrouter.apiKey in the agent directory's models.json", async () => {
    modelsJson({ providers: { openrouter: { apiKey: "sk-file" } } });
    expect(await resolveApiKey(registry(undefined), {}, dir)).toBe("sk-file");
  });

  it("survives a registry that throws", async () => {
    modelsJson({ providers: { openrouter: { apiKey: "sk-file" } } });
    const reg = {
      getApiKeyForProvider: async () => {
        throw new Error("boom");
      },
    };
    expect(await resolveApiKey(reg, {}, dir)).toBe("sk-file");
  });

  it("returns undefined without models.json, without an openrouter section, or with an empty key", async () => {
    expect(await resolveApiKey(registry(undefined), {}, dir)).toBeUndefined();
    modelsJson({ providers: { anthropic: { apiKey: "sk-anthro" } } });
    expect(await resolveApiKey(registry(undefined), {}, dir)).toBeUndefined();
    modelsJson({ providers: { openrouter: { apiKey: "" } } });
    expect(await resolveApiKey(registry(undefined), {}, dir)).toBeUndefined();
    writeFileSync(join(dir, "models.json"), "{not json");
    expect(await resolveApiKey(registry(undefined), {}, dir)).toBeUndefined();
  });
});
