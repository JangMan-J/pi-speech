This project has a director: run `slice status`, then read NEXT.md, before changing anything.

## Directives

## Coding standards

- The extension is TypeScript (ESM) loaded by Pi from `index.ts`; tests use vitest under `test/`. Before each commit run `npm test`, `npm run typecheck`, and `npx biome check .`; `npm ci` installs the tools.
- Make HTTP requests with the global `fetch`.
- `receiver/` is a Rust crate (`pi-speech-receiver`). Keep `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test` clean.
- `protocol/bridge.md` is the contract between the extension and the receiver. Follow it exactly; do not change it.
- Never write secrets (API keys, bridge tokens) or recorded audio to logs, session files, or test snapshots.
- Paths come from the environment or the home directory, never from one machine's layout.
