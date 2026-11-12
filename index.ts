/**
 * pi-speech: speech for Pi through OpenRouter and the xAI login in Pi.
 * Speech code derived from pi-openrouter-multimodal (MIT); see LICENSE and README.md.
 *
 * The engine (src/engine/) is Pi-independent; src/pi/adapter.ts maps Pi onto it.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Engine } from "./src/engine/engine";
import { registerPi } from "./src/pi/adapter";

export default function (pi: ExtensionAPI) {
  registerPi(pi, new Engine({ agentDir: getAgentDir(), env: process.env, home: homedir() }));
}
