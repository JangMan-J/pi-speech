// Held-out acceptance: xAI speech provider edge cases.
import fs from 'node:fs';
import path from 'node:path';
import { callTool, check, command, errors, finish, notes, setup, wavBytes } from '../lib/lib.mjs';
import { editorEvents, recorderEnv, sha, until } from '../lib/dict.mjs';

const lines = (t) => t.split('\n');
const KANA = /[\u3040-\u30ff]/;

// 1. only the xAI login: no OpenRouter key anywhere, and everything still works
{
  const ctx = await setup({ xai: true, env: { OPENROUTER_API_KEY: null } });
  try {
    const s = await ctx.pi();
    let n = await command(s, '/speech --set tts-model xai');
    check(errors(n).length === 0, 'xai is selectable with no OpenRouter key', notes(n));
    n = await command(s, '/speech No key needed');
    check(errors(n).length === 0 && ctx.xai.tts().length === 1, 'speaking works with only the xAI login', notes(n));
    await command(s, '/speech --set stt-model xai');
    const clip = path.join(ctx.work, 'clip.wav');
    fs.writeFileSync(clip, wavBytes(0.6));
    ctx.xai.setTranscript('only xai');
    const t = await callTool(ctx, s, 'speech_transcribe', { path: clip });
    check(t.content.includes('only xai'), 'transcription works with only the xAI login', t.content.slice(0, 200));
    check(ctx.or.requests.filter((r) => r.path.startsWith('/api/v1/audio')).length === 0, 'no OpenRouter audio request is made');
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}

// 2. hosts, the language request field, voices, and an unlisted voice
{
  const ctx = await setup({ xai: true });
  try {
    const s = await ctx.pi();
    await command(s, '/speech --set tts-model xai');
    await command(s, '/speech --language eve fr');
    await command(s, '/speech --sample eve', 800);
    const fr = ctx.xai.tts().at(-1)?.body;
    check(fr?.language === 'fr' && /bonjour/i.test(fr.text ?? ''), 'a fr override gives French text and language fr', fr);
    const n = await command(s, '/speech --sample nobody', 500);
    check(errors(n).length > 0 && /ara|eve|leo/.test(notes(n)), 'an unknown xai voice is an error naming valid voices', notes(n));
    await command(s, '/speech --set voice eve');
    await command(s, '/speech Some words');
    const body = ctx.xai.tts().at(-1)?.body;
    check(body?.language === 'auto', 'plain speech asks for language auto', body);
    check(Object.keys(body ?? {}).every((k) => ['text', 'voice_id', 'language', 'output_format'].includes(k)), 'the request carries only the documented fields', Object.keys(body ?? {}));

    const fetched = fs.existsSync(ctx.fetchLog) ? fs.readFileSync(ctx.fetchLog, 'utf8').split('\n').filter(Boolean) : [];
    const hosts = [...new Set(fetched.map((u) => new URL(u).host))];
    check(hosts.every((h) => h === 'openrouter.ai' || h === 'api.x.ai'), 'the extension contacts only openrouter.ai and api.x.ai', hosts);
    check(fetched.some((u) => u.startsWith('https://api.x.ai/v1/tts')), 'the fetch log shows api.x.ai/v1/tts');
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}

// 3. an empty voice list: no made-up voices
{
  const ctx = await setup({ xai: { voices: [] } });
  try {
    const s = await ctx.pi();
    await command(s, '/speech --set tts-model xai');
    const out = notes(await command(s, '/speech --voices', 600));
    check(!/\b(ara|eve|leo)\b/.test(out), 'an empty xAI voice list is not replaced by invented voices', out);
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}

// 4. dictation through xai: the recording goes to xAI only
{
  const ctx = await setup({ xai: true });
  const rec = recorderEnv(ctx);
  try {
    ctx.xai.setTranscript('dictated through xai');
    let s = await ctx.pi({ env: rec.env });
    await command(s, '/speech --set stt-model xai');
    const from = s.uiRequests.length;
    await command(s, '/speech --dictate', 600);
    await new Promise((r) => setTimeout(r, 300));
    await command(s, '/speech --dictate', 300);
    await until(() => editorEvents(s, from).length > 0, 8000);
    const ed = editorEvents(s, from);
    check(ed.length === 1 && (ed[0].text ?? '').includes('dictated through xai'), 'the xAI transcript is inserted into the editor', ed);
    const sreq = ctx.xai.stt().at(-1);
    const part = sreq?.body?.multipart?.find((p) => p.name === 'file');
    check(part?.sha256 === sha(rec.lastRecording()), 'the recording is posted to xAI as it was recorded', part);
    check(ctx.or.requests.filter((r) => r.path.includes('/audio')).length === 0, 'the recording is not sent to OpenRouter');
    check(ctx.history().length === 0, 'the recording is not in the speech history', ctx.history());
    ctx.xai.failNext(1, 500, { error: 'stt down' });
    const f = s.uiRequests.length;
    await command(s, '/speech --dictate', 600);
    await new Promise((r) => setTimeout(r, 300));
    const n = await command(s, '/speech --dictate', 1500);
    check(errors(n).length > 0 && editorEvents(s, f).length === 0, 'a transcription failure is an error and inserts nothing', notes(n));
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}
finish();
