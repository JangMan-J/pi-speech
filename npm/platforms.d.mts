/** Types for npm/platforms.mjs (plain JavaScript so the publish job runs it with Node alone). */

export const ROOT: string;
export const BINARY_NAME: string;

export interface Target {
  /** process.platform */
  os: string;
  /** process.arch */
  cpu: string;
  /** `<os>-<cpu>` */
  target: string;
}

export const TARGETS: Target[];
export const GPU_TARGETS: Target[];
/** The shared libraries a target's binary links, which go beside it (absent: linked statically). */
export const LIBRARIES: Record<string, string[]>;
export function findTarget(target: string): Target;
export function binaryFile(target: string): string;
export function archiveFile(target: string): string;
export function bundleBinaries(opts: { binariesDir: string; out?: string }): string[];
export function createReleaseAssets(opts: {
  binariesDir: string;
  assetsDir: string;
  manifestPath?: string;
  version: string;
  repo?: string;
  tag?: string;
}): {
  manifest: {
    version: string;
    repo: string;
    tag: string;
    assets: Record<string, { file: string; size: number; sha256: string }>;
  };
  manifestPath: string;
  archives: string[];
};
