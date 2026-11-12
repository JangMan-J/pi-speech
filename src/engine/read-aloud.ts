/**
 * Assistant read-aloud: when on, the final reply of each run is spoken as readable text through the player.
 * It starts off in every session.
 */

import { errorMessage } from "./env";
import { REPLACED } from "./player";
import { cutForSpeech, finalAssistantText, speakable } from "./readable";
import type { Speech } from "./speech";
import { ReadingFailed, readingFailedMessage } from "./stream";

export type Notify = (message: string, level: "info" | "warning" | "error") => void;

export class ReadAloud {
  enabled = false;

  constructor(
    private readonly speech: Pick<Speech, "say">,
    private readonly notify: Notify,
  ) {}

  /** A run ended with these messages: speak its final reply when read-aloud is on. */
  async onRunEnd(messages: readonly unknown[]): Promise<void> {
    if (!this.enabled) return;
    const text = speakable(finalAssistantText(messages));
    if (!text) return;
    const { text: spoken, cut } = cutForSpeech(text);
    if (cut) {
      this.notify(`Read-aloud: the reply is long, so only its first ${spoken.length} characters are spoken`, "info");
    }
    try {
      const r = await this.speech.say(spoken);
      if (!r.stopped && !r.player && r.notPlayed !== REPLACED) {
        this.notify(`Read-aloud could not play the reply: ${r.notPlayed ?? "unknown reason"}`, "error");
      }
    } catch (err) {
      if (err instanceof ReadingFailed) this.notify(readingFailedMessage("Read-aloud", "reply", err.reason), "error");
      else this.notify(`Read-aloud failed: ${errorMessage(err)}`, "error");
    }
  }
}
