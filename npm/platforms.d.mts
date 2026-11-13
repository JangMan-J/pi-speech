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

export interface Manifest {
  name: string;
  version: string;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export const TARGETS: Target[];
export function platformName(mainName: string, target: string): string;
export function findTarget(target: string): Target;
export function optionalDependencies(mainName: string, version: string): Record<string, string>;
export function stamp<M extends Manifest>(manifest: M): M & { optionalDependencies: Record<string, string> };
export function stampProblem(manifest: Manifest): string | undefined;
export function buildPlatformPackage(opts: { target: string; binary: string; out: string; manifest?: Manifest }): {
  dir: string;
  name: string;
  version: string;
  binary: string;
};
