// A fake of the xAI speech endpoints, as observed against the real service:
//   GET  /v1/tts/voices  -> {voices: [{voice_id, name, language, gender}]}
//   POST /v1/tts         JSON {text, voice_id, language[, output_format: {codec, sample_rate}]} -> audio/mpeg, or audio/wav
//                        when output_format.codec is "wav"; `language` is required (422), an unknown voice is 404
//   POST /v1/stt         multipart `file` -> {text, language, duration, words: []}
// Every request needs `Authorization: Bearer <key>`; anything else is 401.
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseMultipart, pcmTone, sha, wavWrap } from './fake-openrouter.mjs';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const VOICES = [
  { voice_id: 'ara', name: 'Ara', language: 'multilingual', gender: 'female' },
  { voice_id: 'eve', name: 'Eve', language: 'multilingual', gender: 'female' },
  { voice_id: 'leo', name: 'Leo', language: 'multilingual', gender: 'male' },
];

export async function startFakeXai({ key, voices = VOICES, transcript = 'hello from xai' } = {}) {
  const mp3 = fs.readFileSync(here('fixture.mp3'));
  const requests = [];
  const failures = [];
  let text = transcript;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const ctype = req.headers['content-type'] || '';
    const u = new URL(req.url, 'http://x');
    const rec = { method: req.method, path: u.pathname + u.search, headers: { ...req.headers } };
    let body;
    if (raw.length) {
      if (ctype.includes('json')) {
        try { body = JSON.parse(raw.toString('utf8')); rec.body = body; } catch { rec.body = { unparsable: true, bytes: raw.length }; }
      } else if (ctype.includes('multipart/form-data')) {
        body = parseMultipart(raw, ctype);
        rec.body = { multipart: body.parts.map((p) => (p.filename || p.data.length > 256
          ? { name: p.name, filename: p.filename, bytes: p.data.length, sha256: sha(p.data) }
          : { name: p.name, value: p.data.toString('utf8') })) };
      } else rec.body = { bytes: raw.length, sha256: sha(raw) };
    }
    requests.push(rec);
    const send = (status, headers, data) => { rec.status = status; res.writeHead(status, headers); res.end(data); };
    const json = (status, obj) => send(status, { 'content-type': 'application/json' }, JSON.stringify(obj));

    if (req.headers.authorization !== `Bearer ${key}`) return json(401, { error: 'Unauthorized: invalid or missing credentials' });
    if (req.method === 'POST' && failures.length && failures[0].n > 0) {
      const f = failures[0]; if (--f.n <= 0) failures.shift();
      return json(f.status, f.body);
    }
    if (req.method === 'GET' && u.pathname === '/v1/tts/voices') return json(200, { voices });
    if (req.method === 'POST' && u.pathname === '/v1/tts') {
      if (typeof body?.text !== 'string' || !body.text) return send(422, { 'content-type': 'text/plain' }, 'Failed to deserialize the JSON body into the target type: missing field `text`');
      if (typeof body.language !== 'string') return send(422, { 'content-type': 'text/plain' }, 'Failed to deserialize the JSON body into the target type: missing field `language`');
      if (!voices.some((v) => v.voice_id === body.voice_id)) return json(404, { error: `TTS synthesis failed: Voice '${body.voice_id}' not found` });
      if (body.output_format?.codec === 'wav') return send(200, { 'content-type': 'audio/wav' }, wavWrap(pcmTone(0.5, 24000), 24000));
      return send(200, { 'content-type': 'audio/mpeg' }, mp3);
    }
    if (req.method === 'POST' && u.pathname === '/v1/stt') {
      if (!body?.parts?.some((p) => p.name === 'file' && p.data.length > 0)) return json(400, { error: 'missing file' });
      return json(200, { text, language: 'en', duration: 1.5, words: [{ text: 'hello', start: 0.1, end: 0.5 }] });
    }
    json(404, { error: 'The requested resource was not found.' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    voices,
    tts: () => requests.filter((r) => r.path === '/v1/tts'),
    stt: () => requests.filter((r) => r.path === '/v1/stt'),
    failNext(n, status = 500, body = { error: 'injected failure' }) { failures.push({ n, status, body }); },
    setTranscript(t) { text = t; },
    async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
}
