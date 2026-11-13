import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));

export function pcmTone(seconds = 0.5, rate = 24000) {
  const n = Math.floor(seconds * rate), b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / rate)), i * 2);
  return b;
}
export function wavWrap(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Replace base64 audio payloads in a parsed JSON body by {bytes, sha256}.
function redact(v, key) {
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  if (typeof v === 'string' && (key === 'data' || key === 'input_audio' || key === 'audio') && v.length > 64 && /^[A-Za-z0-9+/=\s]+$/.test(v)) {
    const buf = Buffer.from(v, 'base64');
    return { bytes: buf.length, sha256: sha(buf) };
  }
  return v;
}

export async function startFakeOpenRouter(opts = {}) {
  const catalog = opts.catalog ?? JSON.parse(fs.readFileSync(here('openrouter-models.json'), 'utf8'));
  const mp3OnlyModels = new Set(opts.mp3OnlyModels ?? []);
  const mp3 = fs.readFileSync(here('fixture.mp3'));
  const requests = [];
  let transcript = opts.transcript ?? 'hello world';
  let failures = [];
  const msPerChar = opts.msPerChar ?? 0;
  let speechCount = 0;
  const mismatchAt = opts.mismatchAt ?? 0; // the Nth speech request answers bytes that are not audio (not a readable WAV)
  let inflight = 0, maxInflight = 0;
  if (opts.logFile) fs.writeFileSync(opts.logFile, '', { flag: 'a' });

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const ctype = req.headers['content-type'] || '';
    const u = new URL(req.url, 'http://x');
    const rec = { time: new Date().toISOString(), method: req.method, path: u.pathname + u.search, headers: { ...req.headers } };
    let body;
    if (raw.length) {
      if (ctype.includes('json')) {
        try { body = JSON.parse(raw.toString('utf8')); rec.body = redact(body); } catch { rec.body = { unparsable: true, bytes: raw.length }; }
      } else if (ctype.includes('multipart/form-data')) {
        body = parseMultipart(raw, ctype);
        rec.body = { multipart: body.parts.map((p) => p.filename || p.contentType?.startsWith('audio') || p.data.length > 256
          ? { name: p.name, filename: p.filename, contentType: p.contentType, bytes: p.data.length, sha256: sha(p.data) }
          : { name: p.name, value: p.data.toString('utf8') }) };
      } else rec.body = { bytes: raw.length, sha256: sha(raw) };
    }
    requests.push(rec);
    if (opts.logFile) fs.appendFileSync(opts.logFile, JSON.stringify(rec) + '\n');

    const send = (status, headers, data) => { rec.status = status; res.writeHead(status, headers); res.end(data); };
    const json = (status, obj) => send(status, { 'content-type': 'application/json' }, JSON.stringify(obj));
    const isAudio = u.pathname.startsWith('/api/v1/audio/');

    if (req.method === 'GET' && u.pathname === '/api/v1/models') return json(200, catalog);
    if (isAudio && req.method === 'POST' && failures.length && failures[0].n > 0) {
      const f = failures[0]; if (--f.n <= 0) failures.shift();
      return send(f.status, { 'content-type': typeof f.body === 'string' ? 'text/plain' : 'application/json' },
        typeof f.body === 'string' ? f.body : JSON.stringify(f.body));
    }
    if (req.method === 'POST' && u.pathname === '/api/v1/audio/speech') {
      inflight++; maxInflight = Math.max(maxInflight, inflight); rec.start = Date.now();
      try { await new Promise((r) => setTimeout(r, msPerChar * String(body?.input ?? '').length)); } finally { inflight--; rec.end = Date.now(); }
      speechCount++;
      if (mismatchAt && speechCount === mismatchAt) return send(200, { 'content-type': 'audio/mpeg' }, Buffer.from('this is not audio at all'.repeat(40)));
      const fmt = body?.response_format ?? 'mp3';
      if (fmt === 'pcm' && mp3OnlyModels.has(body?.model))
        return json(400, { error: { message: `Model ${body.model} does not support response_format "pcm"; use mp3`, code: 400 } });
      if (fmt === 'pcm') return send(200, { 'content-type': 'audio/pcm;rate=24000;channels=1' }, pcmTone());
      if (fmt === 'wav') return send(200, { 'content-type': 'audio/wav' }, wavWrap(pcmTone()));
      return send(200, { 'content-type': 'audio/mpeg' }, mp3);
    }
    if (req.method === 'POST' && u.pathname === '/api/v1/audio/transcriptions') return json(200, { text: transcript });
    json(404, { error: { message: 'not found: ' + u.pathname, code: 404 } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    maxInflight: () => maxInflight,
    failNext(n, status = 500, body = { error: { message: 'injected failure', code: status } }) { failures.push({ n, status, body }); },
    setTranscript(t) { transcript = t; },
    async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
}

export function parseMultipart(buf, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype);
  const b = Buffer.from('--' + (m[1] || m[2]));
  const parts = [];
  let pos = buf.indexOf(b);
  while (pos !== -1) {
    const start = pos + b.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(b, start);
    if (next === -1) break;
    const part = buf.slice(start + 2, next - 2); // strip CRLF after boundary and before next
    const sep = part.indexOf('\r\n\r\n');
    const head = part.slice(0, sep).toString('utf8');
    parts.push({
      name: /name="([^"]*)"/.exec(head)?.[1], filename: /filename="([^"]*)"/.exec(head)?.[1],
      contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1], data: part.slice(sep + 4),
    });
    pos = next;
  }
  return { parts };
}
