/**
 * A searchable picker for long lists (models, voices) in Pi's terminal UI: type to filter (fuzzy), ↑↓ to
 * move, Enter to pick, Esc to go back. Derived from pi-openrouter-multimodal (MIT).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey } from "@earendil-works/pi-tui";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

export function fuzzyPicker(
  theme: Theme,
  title: string,
  values: string[],
  current: string | undefined,
  done: (value?: string) => void,
  maxVisible = 12,
) {
  const input = new Input();
  let matches = values;
  let selected = Math.max(0, current === undefined ? 0 : matches.indexOf(current));
  const refilter = () => {
    const q = input.getValue().trim();
    matches = q ? fuzzyFilter(values, q, (v) => v) : values;
    selected = 0;
  };
  return {
    render(width: number) {
      const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), matches.length - maxVisible));
      const rows = matches.slice(start, start + maxVisible).map((v, i) => {
        const on = start + i === selected;
        const text = `${on ? "→ " : "  "}${v}${v === current ? " ✓" : ""}`;
        return on ? theme.fg("accent", text) : text;
      });
      if (matches.length === 0) rows.push(theme.fg("dim", "  No matches"));
      return [
        theme.fg("accent", theme.bold(title)),
        ...input.render(width - 6).map((l, i) => (i === 0 ? theme.fg("dim", "Find: ") : "      ") + l),
        ...rows,
        theme.fg(
          "dim",
          `  ${matches.length ? selected + 1 : 0}/${matches.length}  ·  type to search  ·  ↑↓ move  ·  Enter pick  ·  Esc back`,
        ),
      ];
    },
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, Key.up)) selected = selected === 0 ? Math.max(0, matches.length - 1) : selected - 1;
      else if (matchesKey(data, Key.down)) selected = selected >= matches.length - 1 ? 0 : selected + 1;
      else if (matchesKey(data, Key.enter)) {
        if (matches.length) done(matches[selected]);
      } else if (matchesKey(data, Key.escape)) done(undefined);
      else {
        input.handleInput(data);
        refilter();
      }
    },
  };
}

/** Pick one of `values` in an overlay; undefined when the user goes back. */
export function pick(
  ctx: ExtensionContext,
  title: string,
  values: string[],
  current?: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _kb, done) => {
      const picker = fuzzyPicker(theme, title, values, current, done);
      return {
        render: (width: number) => picker.render(width),
        invalidate: () => picker.invalidate(),
        handleInput(data: string) {
          picker.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}
