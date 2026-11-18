import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planRemoteReceiver, platformOf, readReceiverService, shQuote, sshConfigHosts } from "../../src/engine/remote";

describe("the Remote machine over SSH: helpers", () => {
  it("lists the Hosts of ~/.ssh/config that name one machine, once each, in order", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-speech-home-"));
    try {
      expect(sshConfigHosts(home)).toEqual([]);
      mkdirSync(join(home, ".ssh"));
      writeFileSync(
        join(home, ".ssh", "config"),
        "Host spider\n  HostName 100.64.0.9\n\nhost build lab spider\nHost *.lan !bad\n  # Host commented\nHost gpu?\n",
      );
      expect(sshConfigHosts(home)).toEqual(["spider", "build", "lab"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

  it("recognizes the effective user receiver service, including a custom listen address", () => {
    const path = "/home/listener/.local/bin/pi-speech-receiver";
    const service = [
      "Id=pi-speech-receiver.service",
      "LoadState=loaded",
      "Type=simple",
      "User=",
      "ActiveState=active",
      "MainPID=42",
      `ExecStart={ path=${path} ; argv[]=${path} serve --listen 127.0.0.1:47300 --token-file /home/listener/token ; ignore_errors=no ; pid=42 ; status=0/0 }`,
    ].join("\n");
    expect(readReceiverService(service, path)).toMatchObject({ exists: true, active: true, pid: 42 });
    expect(readReceiverService("Id=pi-speech-receiver.service\nLoadState=not-found", path)).toMatchObject({
      exists: false,
    });
    expect(() => readReceiverService(service.replace(" serve --listen", " ssh --listen"), path)).toThrow(/refusing/);
    expect(() => readReceiverService(service.replaceAll(path, "/usr/bin/pi-speech-receiver"), path)).toThrow(
      /refusing/,
    );
    expect(() => readReceiverService(`${service}\nExecStop=/usr/bin/sleep`, path)).toThrow(/refusing/);
    expect(() => readReceiverService(service.replace("LoadState=loaded", "LoadState=masked"), path)).toThrow(
      /refusing/,
    );
    expect(() =>
      readReceiverService(service.replace("Id=pi-speech-receiver.service", "Id=other.service"), path),
    ).toThrow(/cannot identify/);
  });

  it("decides when a remote receiver must be installed or updated", () => {
    expect(planRemoteReceiver({ hasPath: false, canLease: false, hasBinary: true })).toEqual({
      action: "install",
      reason: "missing",
    });
    expect(planRemoteReceiver({ hasPath: true, canLease: false, hasBinary: true })).toEqual({
      action: "install",
      reason: "too-old",
    });
    expect(planRemoteReceiver({ hasPath: true, canLease: true, expectedVersion: "0.2.5", hasBinary: true })).toEqual({
      action: "update",
      reason: "outdated",
      confirm: true,
    });
    expect(
      planRemoteReceiver({
        hasPath: true,
        canLease: true,
        remoteVersion: "0.3.0",
        expectedVersion: "0.2.5",
        hasBinary: true,
      }),
    ).toEqual({ action: "update", reason: "outdated", confirm: true });
    expect(
      planRemoteReceiver({
        hasPath: true,
        canLease: true,
        remoteVersion: "0.2.5",
        expectedVersion: "0.2.5",
        hasBinary: true,
      }),
    ).toEqual({ action: "none" });
    expect(
      planRemoteReceiver({
        hasPath: true,
        canLease: true,
        remoteVersion: "0.2.5",
        expectedVersion: "0.2.5",
        hasBinary: true,
        forceUpdate: true,
      }),
    ).toEqual({ action: "update", reason: "forced", confirm: false });
    expect(
      planRemoteReceiver({
        hasPath: true,
        canLease: true,
        remoteVersion: "0.2.4",
        expectedVersion: "0.2.5",
        hasBinary: false,
      }),
    ).toEqual({ action: "none" });
  });
});
