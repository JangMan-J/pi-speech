/**
 * Playback bridge client: plays on, and records from, the user's playback machine through
 * pi-speech-receiver (protocol/bridge.md). Which route is used is decided in src/engine/routes.ts.
 */

export type {
  BridgeAudio,
  BridgeConfig,
  BridgeHealth,
  BridgeModels,
  BridgeProbe,
  BridgeVoice,
} from "./client";
export {
  bridgeBase,
  CLIENT_ID,
  createBridgeAudio,
  createBridgeAudioFrom,
  displayUrl,
  loopbackBase,
  PairingError,
  probeBridge,
  requestPairingCode,
  sendPairingCode,
} from "./client";
export type { BridgeTarget } from "./config";
export {
  addressOf,
  addressUrl,
  bridgeConfig,
  bridgeTarget,
  bridgeToken,
  bridgeTokenFile,
  bridgeUrl,
  DEFAULT_URL,
  SPARE_PORTS,
  saveBridgeToken,
} from "./config";
