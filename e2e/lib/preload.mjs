// Use via NODE_OPTIONS=--import /abs/path/preload.mjs
// pi calls undici.install() at startup, which overwrites globalThis.fetch. To survive that, fetch is
// exposed as an accessor: the getter always returns our wrapper, the setter swaps the underlying fetch.
import fs from 'node:fs';

let underlying = globalThis.fetch;
// Each real service prefix is rewritten to a fake server named by an environment variable.
const REWRITES = [['https://openrouter.ai/', 'FAKE_OPENROUTER_URL'], ['https://api.x.ai/', 'FAKE_XAI_URL']];

function wrapper(input, init) {
  const orig = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (process.env.FAKE_FETCH_LOG && orig) {
    try { fs.appendFileSync(process.env.FAKE_FETCH_LOG, orig + '\n'); } catch {}
  }
  for (const [prefix, variable] of REWRITES) {
    const target = process.env[variable];
    if (target && typeof orig === 'string' && orig.startsWith(prefix)) {
      const rewritten = target.replace(/\/$/, '') + '/' + orig.slice(prefix.length);
      if (typeof input === 'string' || input instanceof URL) return underlying(rewritten, init);
      return underlying(new Request(rewritten, input), init); // Request: keeps method/headers/body/signal
    }
  }
  return underlying(input, init);
}
Object.defineProperty(globalThis, 'fetch', {
  configurable: true, enumerable: true,
  get: () => wrapper,
  set: (f) => { if (f !== wrapper) underlying = f; },
});
