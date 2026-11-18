import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type RedirectResult = { ok: true; via: "zellij" } | { ok: false; reason: string };
type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

/** Zellij's CLI does not reliably expose the focused pane ID on all versions. */
export function createRedirect({ env, exec = promisify(execFile) }: { env: NodeJS.ProcessEnv; exec?: Exec }) {
  const available = async (): Promise<RedirectResult> => {
    if (!env.ZELLIJ || !env.ZELLIJ_PANE_ID) return { ok: false, reason: "Redirect needs Zellij; typing into Pi" };
    try {
      const { stdout } = await exec("zellij", ["action", "list-clients"]);
      // Some versions include a focused pane in list-clients; otherwise Zellij chooses the focus.
      const focused = /focused\s+pane(?:\s+id)?\s*[:=]\s*(?:terminal_)?(\d+)/i.exec(stdout)?.[1];
      if (focused && focused === env.ZELLIJ_PANE_ID.replace(/^terminal_/, "")) {
        return { ok: false, reason: "Pi's pane is focused; typing into Pi" };
      }
      return { ok: true, via: "zellij" };
    } catch (err) {
      return { ok: false, reason: `Redirect unavailable: ${String(err)}; typing into Pi` };
    }
  };
  const deliver = async (text: string, opts: { submit?: boolean } = {}): Promise<RedirectResult> => {
    const ready = await available();
    if (!ready.ok) return ready;
    try {
      if (text) await exec("zellij", ["action", "write-chars", text]);
    } catch (err) {
      return { ok: false, reason: `Redirect failed: ${String(err)}; typing into Pi` };
    }
    if (opts.submit) {
      try {
        await exec("zellij", ["action", "write", "13"]);
      } catch (err) {
        // Text has already been delivered: do not duplicate it in Pi.
        return { ok: false, reason: `Redirect text delivered, but Enter failed: ${String(err)}` };
      }
    }
    return { ok: true, via: "zellij" };
  };
  return { available, deliver };
}
