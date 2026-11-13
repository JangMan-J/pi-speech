import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GUIDELINE_PREFIX } from "../../src/engine/read-aloud";
import { piModels, registerPi, summarizeWith } from "../../src/pi/adapter";
import { fakeOpenRouter, makeEngine } from "../engine/fixtures";

afterEach(() => vi.unstubAllGlobals());

/** A stand-in for Pi's extension API that records what the extension registers. */
function fakePi() {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, Array<(e: any, ctx: any) => unknown>>();
  let active = ["read", "speech_synthesize", "speech_transcribe"];
  const pi: any = {
    registerCommand: (name: string, o: any) => commands.set(name, o),
    registerTool: (o: any) => tools.set(o.name, o),
    registerShortcut: (k: string, o: any) => shortcuts.set(k, o),
    on: (e: string, fn: any) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
    getActiveTools: () => active,
    setActiveTools: (t: string[]) => {
      active = t;
    },
    sendUserMessage: vi.fn(),
  };
  const notes: Array<{ message: string; type?: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const ctx: any = {
    mode: "rpc",
    hasUI: true,
    cwd: "/",
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: {
      notify: (message: string, type?: string) => notes.push({ message, type }),
      setStatus: (k: string, t?: string) => statuses.push([k, t]),
      select: async () => undefined,
      input: async () => undefined,
      pasteToEditor: vi.fn(),
    },
  };
  const emit = async (e: string, event: any = {}) => {
    const results: unknown[] = [];
    for (const fn of handlers.get(e) ?? []) results.push(await fn(event, ctx));
    return results;
  };
  return { pi, ctx, commands, tools, shortcuts, emit, notes, statuses, active: () => active };
}

describe("the Pi adapter", () => {
  it("registers one command, two tools, and dictation/speak shortcuts", () => {
    const f = fakePi();
    registerPi(f.pi, makeEngine().engine);
    expect([...f.commands.keys()]).toEqual(["speech"]);
    expect([...f.tools.keys()].sort()).toEqual(["speech_synthesize", "speech_transcribe"]);
    expect([...f.shortcuts.keys()]).toEqual(["alt+z", "alt+s"]);
  });

  it("/speech <text> speaks without starting a turn and shows the single status", async () => {
    const requests = fakeOpenRouter();
    const f = fakePi();
    registerPi(f.pi, makeEngine().engine);
    await f.emit("session_start");
    await f.commands.get("speech").handler("hello there", f.ctx);
    expect(requests.at(-1)?.body.input).toBe("hello there");
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(f.statuses.at(-1)).toEqual(["pi-speech", "▶ speaking"]);
    expect(new Set(f.statuses.map(([k]) => k))).toEqual(new Set(["pi-speech"]));
  });

  it("--type inserts literal text into the editor without speaking or submitting it", async () => {
    const requests = fakeOpenRouter();
    const f = fakePi();
    registerPi(f.pi, makeEngine().engine);
    await f.emit("session_start");
    const before = requests.length;
    await f.commands.get("speech").handler("--type hello   --not-an-action", f.ctx);
    expect(f.ctx.ui.pasteToEditor).toHaveBeenCalledWith("hello   --not-an-action");
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(requests.length).toBe(before);
  });

  it("--transcribe inserts a file transcript with a one-off language and never submits it", async () => {
    const requests = fakeOpenRouter("transcribed from a file");
    const f = fakePi();
    const { engine, work } = makeEngine();
    const audio = join(work, "note.wav");
    writeFileSync(audio, "RIFFfake");
    registerPi(f.pi, engine);
    await f.emit("session_start");
    await f.commands.get("speech").handler(`--transcribe ${audio} pt`, f.ctx);
    expect(f.ctx.ui.pasteToEditor).toHaveBeenCalledWith("transcribed from a file");
    expect(requests.at(-1)?.body).toMatchObject({ model: "openai/whisper-large-v3-turbo", language: "pt" });
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("shows command errors as errors", async () => {
    fakeOpenRouter();
    const f = fakePi();
    registerPi(f.pi, makeEngine().engine);
    await f.emit("session_start");
    await f.commands.get("speech").handler("--frobnicate", f.ctx);
    expect(f.notes.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("--stop") });
  });

  it("tools off removes both tools from the active set and on restores them", async () => {
    fakeOpenRouter();
    const f = fakePi();
    registerPi(f.pi, makeEngine().engine);
    await f.emit("session_start");
    await f.commands.get("speech").handler("--set tools off", f.ctx);
    expect(f.active()).toEqual(["read"]);
    await f.commands.get("speech").handler("--set tools on", f.ctx);
    expect(f.active().sort()).toEqual(["read", "speech_synthesize", "speech_transcribe"]);
  });

  it("completes actions and their values", () => {
    const f = fakePi();
    registerPi(f.pi, makeEngine().engine);
    const complete = f.commands.get("speech").getArgumentCompletions;
    expect(complete("--re").map((c: any) => c.value)).toEqual(["--replay", "--read-aloud"]);
    expect(complete("--bridge a").map((c: any) => c.value)).toEqual(["--bridge auto"]);
    expect(complete("--t").map((c: any) => c.value)).toEqual(["--type", "--transcribe"]);
    expect(complete("hello")).toBeNull();
  });

  it("read-aloud Summary: a guideline asks for the marked summary; message_end removes it; it is read", async () => {
    const requests = fakeOpenRouter();
    const f = fakePi();
    const { engine } = makeEngine();
    registerPi(f.pi, engine);
    await f.emit("session_start");
    await f.commands.get("speech").handler("--read-aloud summary", f.ctx);
    const promptGuidelines = ["Use read to examine files.", `${GUIDELINE_PREFIX} an old one`];
    await f.emit("before_agent_start", { systemPromptOptions: { promptGuidelines } });
    expect(promptGuidelines).toHaveLength(2);
    expect(promptGuidelines[0]).toBe("Use read to examine files.");
    expect(promptGuidelines[1]).toMatch(/^pi-speech read-aloud: end every final reply .*<spoken_summary>/);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "The long answer.\n\n<spoken_summary>In short: yes.</spoken_summary>" }],
    };
    const [r] = (await f.emit("message_end", { message })) as Array<{ message: typeof message }>;
    expect(r.message.content).toEqual([{ type: "text", text: "The long answer." }]);
    expect(await f.emit("message_end", { message: { role: "user", content: "hi" } })).toEqual([undefined]);
    const before = requests.length;
    await f.emit("agent_end", { messages: [r.message] });
    await vi.waitFor(() => expect(requests.length).toBe(before + 1));
    expect(requests.at(-1)?.body.input).toBe("In short: yes.");
    // Off: the guideline goes.
    await f.commands.get("speech").handler("--read-aloud off", f.ctx);
    await f.emit("before_agent_start", { systemPromptOptions: { promptGuidelines } });
    expect(promptGuidelines).toEqual(["Use read to examine files."]);
  });

  it("asks another Pi model for a summary with one request, and lists the user's Pi models", async () => {
    const complete = vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: "Short." }] }));
    const model = { provider: "anthropic", id: "claude-haiku" };
    const registry = {
      find: (p: string, id: string) => (p === "anthropic" && id === "claude-haiku" ? model : undefined),
      complete,
      getAvailable: () => [model, { provider: "openai", id: "gpt-mini" }],
    };
    const ctx: any = { modelRegistry: registry, scopedModels: [] };
    expect(await summarizeWith(ctx, "anthropic/claude-haiku", "Summarize this")).toBe("Short.");
    expect(complete).toHaveBeenCalledTimes(1);
    expect((complete.mock.calls[0] as any[])[1].messages[0]).toMatchObject({ role: "user", content: "Summarize this" });
    await expect(summarizeWith(ctx, "nobody/none", "x")).rejects.toThrow(/not one of your Pi models/);
    complete.mockResolvedValueOnce({ stopReason: "error", content: [], errorMessage: "rate limited" } as never);
    await expect(summarizeWith(ctx, "anthropic/claude-haiku", "x")).rejects.toThrow("rate limited");
    expect(piModels(ctx)).toEqual(["anthropic/claude-haiku", "openai/gpt-mini"]);
    expect(piModels({ ...ctx, scopedModels: [{ model }] })).toEqual(["anthropic/claude-haiku"]);
  });

  it("the synthesize tool names the saved files and whether it plays", async () => {
    fakeOpenRouter();
    const f = fakePi();
    registerPi(f.pi, makeEngine().engine);
    await f.emit("session_start");
    const r = await f.tools
      .get("speech_synthesize")
      .execute("id", { text: "hi", play: false }, undefined, undefined, f.ctx);
    expect(r.content[0].text).toMatch(/Saved: .*\.wav/);
    expect(r.content[0].text).toMatch(/Not played: play was false/);
  });
});
