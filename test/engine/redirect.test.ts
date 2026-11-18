import { describe, expect, it, vi } from "vitest";
import { createRedirect } from "../../src/engine/redirect";

const env = { ZELLIJ: "0", ZELLIJ_PANE_ID: "12" };

describe("redirect", () => {
  it("writes text and Enter as arguments", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "focused pane: 4" });
    const redirect = createRedirect({ env, exec });
    expect(await redirect.deliver("hello; world", { submit: true })).toEqual({ ok: true, via: "zellij" });
    expect(exec).toHaveBeenCalledWith("zellij", ["action", "write-chars", "hello; world"]);
    expect(exec).toHaveBeenCalledWith("zellij", ["action", "write", "13"]);
  });
  it("falls back outside Zellij or when Pi is focused", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "focused pane: 12" });
    expect((await createRedirect({ env: {}, exec }).available()).ok).toBe(false);
    expect((await createRedirect({ env, exec }).deliver("hello")).ok).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("reports command errors", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("missing"));
    expect((await createRedirect({ env, exec }).deliver("hello")).ok).toBe(false);
  });
});
