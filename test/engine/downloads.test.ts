import { describe, expect, it, vi } from "vitest";
import { Downloads } from "../../src/engine/downloads";
import type { Download, DownloadProgress, DownloadResult } from "../../src/engine/local-models";

/** An in-memory stand-in for LocalModels.download: each model's progress and end are driven by the test. */
function fakeLocal() {
  const running = new Map<
    string,
    { emit: (p: DownloadProgress) => void; finish: (r: DownloadResult) => void; cancel: ReturnType<typeof vi.fn> }
  >();
  const local = {
    download(id: string, opts: { onProgress?: (p: DownloadProgress) => void } = {}): Download {
      let resolve!: (r: DownloadResult) => void;
      const result = new Promise<DownloadResult>((res) => {
        resolve = res;
      });
      const cancel = vi.fn(() => resolve({ status: "stopped", done: 0, total: 100 }));
      running.set(id, { emit: (p) => opts.onProgress?.(p), finish: resolve, cancel });
      return { result, cancel };
    },
  };
  return { local, running };
}

describe("Downloads", () => {
  it("runs downloads of different models at once: one unpacking does not block another, and both complete", async () => {
    const { local, running } = fakeLocal();
    const choose = vi.fn((direction: string, id: string) => `${direction}: ${id}`);
    const downloads = new Downloads(
      () => local,
      (d, id) => choose(d, id),
    );
    const changes: string[] = [];
    downloads.listen((c) => changes.push(c.end ? `${c.id}:${c.end.status}` : c.id));

    const a = downloads.start({ id: "model-a", size: 100 }, "transcription");
    // Starting the same model again is a no-op returning the same promise.
    expect(downloads.start({ id: "model-a", size: 100 })).toBe(a);
    running.get("model-a")!.emit({ phase: "unpacking" });
    expect(downloads.get("model-a")?.progress).toEqual({ phase: "unpacking" });

    // A second model starts and progresses while the first is unpacking.
    const b = downloads.start({ id: "model-b", size: 200 }, "speech");
    running.get("model-b")!.emit({ phase: "progress", done: 50, total: 200 });
    expect(downloads.active.size).toBe(2);
    expect(downloads.get("model-b")?.progress).toEqual({ phase: "progress", done: 50, total: 200 });
    expect(downloads.get("model-a")?.progress).toEqual({ phase: "unpacking" });

    // Each end is reported per model, and the other keeps running.
    running.get("model-b")!.finish({ status: "done", path: "/cache/model-b" });
    await expect(b).resolves.toMatchObject({ status: "done", id: "model-b", direction: "speech" });
    expect(downloads.get("model-b")).toBeUndefined();
    expect(downloads.get("model-a")?.progress).toEqual({ phase: "unpacking" });
    expect(downloads.ends.get("model-b")).toMatchObject({ status: "done", id: "model-b" });

    running.get("model-a")!.finish({ status: "done", path: "/cache/model-a" });
    await expect(a).resolves.toMatchObject({ status: "done", id: "model-a", direction: "transcription" });
    expect(downloads.active.size).toBe(0);
    expect(downloads.ends.get("model-a")).toMatchObject({ status: "done", id: "model-a" });
    expect(downloads.last).toMatchObject({ status: "done", id: "model-a" });
    expect(choose).toHaveBeenCalledWith("speech", "model-b");
    expect(choose).toHaveBeenCalledWith("transcription", "model-a");
    expect(changes).toContain("model-a:done");
    expect(changes).toContain("model-b:done");
  });

  it("stop(id) stops only that model", async () => {
    const { local, running } = fakeLocal();
    const downloads = new Downloads(
      () => local,
      () => "",
    );
    const a = downloads.start({ id: "model-a", size: 100 });
    const b = downloads.start({ id: "model-b", size: 100 });
    downloads.stop("model-a");
    await expect(a).resolves.toEqual({ status: "stopped", id: "model-a" });
    expect(running.get("model-b")!.cancel).not.toHaveBeenCalled();
    running.get("model-b")!.finish({ status: "done", path: "/cache/model-b" });
    await expect(b).resolves.toMatchObject({ status: "done", id: "model-b" });
  });
});
