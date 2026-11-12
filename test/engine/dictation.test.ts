import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioInput, Recording } from "../../src/engine/audio";
import { Dictation } from "../../src/engine/dictation";

const WAV = Buffer.from("RIFFfake");

function harness(opts: { start?: () => Promise<Recording>; transcript?: string | Error } = {}) {
  const calls: string[] = [];
  const recording: Recording = {
    stop: async () => {
      calls.push("stop");
      return { audio: WAV, format: "wav" };
    },
    cancel: async () => {
      calls.push("cancel");
    },
  };
  let input: AudioInput | undefined = {
    name: "local",
    start:
      opts.start ??
      (async () => {
        calls.push("start");
        return recording;
      }),
  };
  const transcribed: Array<{ audio: Buffer; format: string }> = [];
  const statuses: Array<string | undefined> = [];
  const notes: Array<{ message: string; type?: string }> = [];
  const pasted: string[] = [];
  const service: any = {
    transcribeAudio: async (a: Buffer, format: string, _opts: { signal?: AbortSignal }) => {
      transcribed.push({ audio: a, format });
      const t = opts.transcript ?? "  hello there \n";
      if (t instanceof Error) throw t;
      return t;
    },
  };
  let d: Dictation;
  const make = (deps: Partial<ConstructorParameters<typeof Dictation>[0]> = {}) => {
    d = new Dictation({
      input: () => {
        if (!input) throw new Error("the bridge audio route cannot record");
        return input;
      },
      transcribe: (audio, format, signal) => service.transcribeAudio(audio, format, { signal }),
      onChange: () => statuses.push(d.indicator()),
      ...deps,
    });
    return d;
  };
  const ctx = {
    notify: (message: string, type?: string) => notes.push({ message, type }),
    paste: (t: string) => pasted.push(t),
  };
  return {
    service,
    ctx,
    calls,
    statuses,
    notes,
    pasted,
    transcribed,
    make,
    input: () => input as AudioInput,
    dropInput: () => {
      input = undefined;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("Dictation toggle", () => {
  it("first toggle records with a REC indicator; second transcribes and pastes the trimmed text", async () => {
    const h = harness();
    const d = h.make();
    await d.toggle(h.ctx);
    expect(d.state).toBe("recording");
    expect(h.statuses.at(-1)).toMatch(/REC/);
    await d.toggle(h.ctx);
    expect(h.pasted).toEqual(["hello there"]);
    expect(h.transcribed).toEqual([{ audio: WAV, format: "wav" }]);
    expect(h.statuses.at(-1)).toBeUndefined();
    expect(h.notes).toEqual([]);
    expect(d.state).toBe("idle");
  });

  it("sends the transcript to the output command when one is configured, not to the editor", async () => {
    const h = harness();
    const got: string[] = [];
    const d = h.make({ outputConfigured: () => true, output: async (t) => void got.push(t) });
    await d.toggle(h.ctx);
    await d.toggle(h.ctx);
    expect(got).toEqual(["hello there"]);
    expect(h.pasted).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it("falls back to the editor and warns when the output command fails, so the text is never lost", async () => {
    const h = harness();
    const d = h.make({
      outputConfigured: () => true,
      output: async () => Promise.reject(new Error("command not found")),
    });
    await d.toggle(h.ctx);
    await d.toggle(h.ctx);
    expect(h.pasted).toEqual(["hello there"]);
    expect(h.notes).toEqual([{ message: expect.stringContaining("command not found"), type: "warning" }]);
  });

  it("pastes to the editor when a command is set but no command is configured right now", async () => {
    const h = harness();
    const d = h.make({ outputConfigured: () => false, output: async () => undefined });
    await d.toggle(h.ctx);
    await d.toggle(h.ctx);
    expect(h.pasted).toEqual(["hello there"]);
  });

  it("shows a transcribing indicator while the transcript is pending", async () => {
    const h = harness();
    const seen: Array<string | undefined> = [];
    h.service.transcribeAudio = async () => {
      seen.push(h.statuses.at(-1));
      return "x";
    };
    const d = h.make();
    await d.toggle(h.ctx);
    await d.toggle(h.ctx);
    expect(seen[0]).toMatch(/transcrib/i);
  });

  it.each([["no microphone", () => Promise.reject(new Error("no microphone"))]])(
    "a start failure (%s) is an error, leaves no indicator, and inserts nothing",
    async (_n, start) => {
      const h = harness({ start });
      const d = h.make();
      await d.toggle(h.ctx);
      expect(h.notes).toEqual([{ message: expect.stringContaining("no microphone"), type: "error" }]);
      expect(h.statuses.at(-1)).toBeUndefined();
      expect(h.pasted).toEqual([]);
      expect(d.state).toBe("idle");
      await d.toggle(h.ctx); // can try again
      expect(h.notes.length).toBe(2);
    },
  );

  it("an unselectable microphone route is an error", async () => {
    const h = harness();
    h.dropInput();
    const d = h.make();
    await d.toggle(h.ctx);
    expect(h.notes[0]).toMatchObject({ type: "error", message: expect.stringMatching(/cannot record/) });
  });

  it("a recorder failure on stop is an error and inserts nothing", async () => {
    const h = harness();
    const d = h.make();
    await d.toggle(h.ctx);
    const rec = await h.input().start();
    rec.stop = async () => {
      throw new Error("the recording is empty");
    };
    (d as any).recording = rec;
    await d.toggle(h.ctx);
    expect(h.notes).toEqual([{ message: expect.stringContaining("empty"), type: "error" }]);
    expect(h.pasted).toEqual([]);
    expect(h.statuses.at(-1)).toBeUndefined();
  });

  it("a transcription error is an error and inserts nothing", async () => {
    const h = harness({ transcript: new Error("Transcription failed: HTTP 500") });
    const d = h.make();
    await d.toggle(h.ctx);
    await d.toggle(h.ctx);
    expect(h.notes).toEqual([{ message: expect.stringContaining("HTTP 500"), type: "error" }]);
    expect(h.pasted).toEqual([]);
    expect(h.statuses.at(-1)).toBeUndefined();
  });

  it("an empty transcript is an error and inserts nothing", async () => {
    const h = harness({ transcript: "  \n " });
    const d = h.make();
    await d.toggle(h.ctx);
    await d.toggle(h.ctx);
    expect(h.notes[0]).toMatchObject({ type: "error" });
    expect(h.pasted).toEqual([]);
    expect(h.statuses.at(-1)).toBeUndefined();
  });

  it("stops by itself at the time limit and transcribes as if toggled", async () => {
    vi.useFakeTimers();
    const h = harness();
    const d = h.make();
    await d.toggle(h.ctx);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(d.state).toBe("recording");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.pasted).toEqual(["hello there"]);
    expect(d.state).toBe("idle");
    expect(h.statuses.at(-1)).toBeUndefined();
  });

  it("the indicator shows the elapsed time", async () => {
    vi.useFakeTimers();
    const h = harness();
    const d = h.make();
    await d.toggle(h.ctx);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.statuses.at(-1)).toBe("● REC 0:03");
    await d.toggle(h.ctx);
  });

  it("cancel discards the recording without transcribing", async () => {
    const h = harness();
    const d = h.make();
    await d.toggle(h.ctx);
    await d.cancel();
    expect(h.calls).toEqual(["start", "cancel"]);
    expect(h.transcribed).toEqual([]);
    expect(h.statuses.at(-1)).toBeUndefined();
    expect(d.state).toBe("idle");
  });

  it("cancel while the recorder is still starting discards the recording once it exists", async () => {
    let release!: (r: Recording) => void;
    const cancelled = vi.fn(async () => {});
    const h = harness({
      start: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    const d = h.make();
    const starting = d.toggle(h.ctx);
    await d.cancel();
    release({ stop: async () => ({ audio: WAV, format: "wav" }), cancel: cancelled });
    await starting;
    expect(cancelled).toHaveBeenCalled();
    expect(d.state).toBe("idle");
    expect(h.statuses.at(-1)).toBeUndefined();
  });

  it("a toggle while starting never starts a second recording; it stops the first", async () => {
    const starts = vi.fn();
    let release!: (r: Recording) => void;
    const h = harness({
      start: () => {
        starts();
        return new Promise((r) => {
          release = r;
        });
      },
    });
    const d = h.make();
    const first = d.toggle(h.ctx);
    await d.toggle(h.ctx);
    release({ stop: async () => ({ audio: WAV, format: "wav" }), cancel: async () => {} });
    await first;
    expect(starts).toHaveBeenCalledTimes(1);
    expect(d.state).toBe("idle");
    expect(h.pasted).toEqual(["hello there"]);
  });
});

describe("Dictation edge cases", () => {
  it("a second toggle while the recorder is starting stops the recording once it has started", async () => {
    let release!: (r: Recording) => void;
    const calls: string[] = [];
    const h = harness({ start: () => new Promise((r) => (release = r)) });
    const d = h.make();
    const first = d.toggle(h.ctx);
    await d.toggle(h.ctx);
    await d.toggle(h.ctx); // more presses still mean stop
    expect(h.transcribed).toEqual([]);
    release({
      stop: async () => {
        calls.push("stop");
        return { audio: WAV, format: "wav" };
      },
      cancel: async () => {
        calls.push("cancel");
      },
    });
    await first;
    expect(calls).toEqual(["stop"]);
    expect(h.pasted).toEqual(["hello there"]);
    expect(d.state).toBe("idle");
    expect(h.statuses.at(-1)).toBeUndefined();
  });

  it("a recording that ends by itself is reported at once, inserts nothing, and returns to idle", async () => {
    let end!: (reason: string) => void;
    const cancelled = vi.fn(async () => {});
    const stop = vi.fn(async () => ({ audio: WAV, format: "wav" as const }));
    const h = harness({
      start: async () => ({ stop, cancel: cancelled, ended: new Promise<string>((r) => (end = r)) }),
    });
    const d = h.make();
    await d.toggle(h.ctx);
    end("pw-record stopped unexpectedly: stream error");
    await vi.waitFor(() => expect(d.state).toBe("idle"));
    expect(h.notes).toEqual([{ message: expect.stringContaining("stream error"), type: "error" }]);
    expect(h.statuses.at(-1)).toBeUndefined();
    expect(h.pasted).toEqual([]);
    expect(h.transcribed).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalled();
  });

  it("the time limit does not fire after a recording ended by itself", async () => {
    vi.useFakeTimers();
    let end!: (reason: string) => void;
    const h = harness({
      start: async () => ({
        stop: async () => ({ audio: WAV, format: "wav" as const }),
        cancel: async () => {},
        ended: new Promise<string>((r) => (end = r)),
      }),
    });
    const d = h.make();
    await d.toggle(h.ctx);
    end("died");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10);
    expect(h.notes.length).toBe(1);
    expect(h.transcribed).toEqual([]);
  });

  it("shutdown during transcription aborts the request and inserts nothing", async () => {
    const h = harness();
    let signal: AbortSignal | undefined;
    h.service.transcribeAudio = (_a: Buffer, _f: string, opts: { signal?: AbortSignal }) => {
      signal = opts.signal;
      return new Promise<string>((resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("Transcription failed: aborted")));
        void resolve;
      });
    };
    const d = h.make();
    await d.toggle(h.ctx);
    const finishing = d.toggle(h.ctx);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await d.cancel();
    await finishing;
    expect(signal?.aborted).toBe(true);
    expect(h.pasted).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(d.state).toBe("idle");
    expect(h.statuses.at(-1)).toBeUndefined();
  });

  it("shutdown during transcription inserts nothing even if the transcript still arrives", async () => {
    const h = harness();
    let arrive!: (t: string) => void;
    h.service.transcribeAudio = () => new Promise<string>((r) => (arrive = r));
    const d = h.make();
    await d.toggle(h.ctx);
    const finishing = d.toggle(h.ctx);
    await vi.waitFor(() => expect(arrive).toBeDefined());
    await d.cancel();
    arrive("late words");
    await finishing;
    expect(h.pasted).toEqual([]);
  });

  it("does not double the failure prefix", async () => {
    const h = harness({ transcript: new Error("Transcription failed: HTTP 500") });
    const d = h.make();
    await d.toggle(h.ctx);
    await d.toggle(h.ctx);
    expect(h.notes[0]?.message).toBe("Transcription failed: HTTP 500");
    const h2 = harness({ start: () => Promise.reject(new Error("Dictation could not start: busy")) });
    await h2.make().toggle(h2.ctx);
    expect(h2.notes[0]?.message).toBe("Dictation could not start: busy");
    const h3 = harness({ transcript: new Error("no network") });
    const d3 = h3.make();
    await d3.toggle(h3.ctx);
    await d3.toggle(h3.ctx);
    expect(h3.notes[0]?.message).toBe("Dictation failed: no network");
  });
});
