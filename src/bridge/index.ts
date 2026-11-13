/**
 * Playback bridge client: plays on, and records from, the user's playback machine through
 * pi-speech-receiver (protocol/bridge.md). Which route is used is decided in src/engine/routes.ts.
 */

export type { BridgeAudio, BridgeConfig, BridgeHealth, BridgeProbe } from "./client";
export { createBridgeAudio, createBridgeAudioFrom, displayUrl, loopbackBase, probeBridge } from "./client";
export { bridgeConfig, bridgeToken, bridgeUrl, DEFAULT_URL } from "./config";
