import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { platformOf, shQuote, sshConfigHosts } from "../../src/engine/remote";

describe("the Remote machine over SSH: helpers", () => {
  it("lists the Hosts of ~/.ssh/config that name one machine, once each, in order", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-speech-home-"));
    expect(sshConfigHosts(home)).toEqual([]);
    mkdirSync(join(home, ".ssh"));
    writeFileSync(
      join(home, ".ssh", "config"),
      "Host spider\n  HostName 100.64.0.9\n\nhost build lab spider\nHost *.lan !bad\n  # Host commented\nHost gpu?\n",
    );
    expect(sshConfigHosts(home)).toEqual(["spider", "build", "lab"]);
  });

  it("names a machine's system as the package does, or not at all", () => {
    expect(platformOf("Linux x86_64")).toBe("linux-x64");
    expect(platformOf("Linux aarch64\n")).toBe("linux-arm64");
    expect(platformOf("Darwin arm64")).toBe("darwin-arm64");
    expect(platformOf("Darwin x86_64")).toBe("darwin-x64");
    expect(platformOf("FreeBSD amd64")).toBeUndefined();
    expect(platformOf("")).toBeUndefined();
  });

  it("quotes a word so that sh reads it as one, whatever is in it", () => {
    expect(shQuote("plain")).toBe("'plain'");
    expect(shQuote("it's $HOME; `x`")).toBe(`'it'\\''s $HOME; \`x\`'`);
  });
});
