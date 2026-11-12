// Visible acceptance: xAI as a speech provider through Pi's own xAI login.
import fs from 'node:fs';
import path from 'node:path';
import { callTool, check, command, errors, finish, isWav, notes, setup, wavBytes } from '../lib/lib.mjs';

const KANA = /[\u3040-\u30ff]/;
const lines = (t) => t.split('\n');

// 1. no xAI login: xai is not offered, and nothing is sent to xAI
{
  const ctx = await setup();
  try {
    const s = await ctx.pi();
    const models = notes(await command(s, '/speech --models'));
    check(!lines(models).some((l) => /^xai\b/.test(l.trim())), 'without an xAI login, xai is not listed as a model', models.slice(0, 400));
    const n = await command(s, '/speech --set tts-model xai');
    check(errors(n).length > 0 && /xai/i.test(notes(n)) && /log ?in/i.test(notes(n)), 'selecting xai without a login is an error that says to log in', notes(n));
    const st = notes(await command(s, '/speech --status'));
    check(!/Speech model: xai/.test(st), 'the refused model is not selected', st);
    const t = await command(s, '/speech --set stt-model xai');
    check(errors(t).length > 0, 'the same holds for transcription');
    check(ctx.xai.requests.length === 0, 'nothing is sent to xAI without a login', ctx.xai.requests.length);
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}

// 2. with the login: models, voices, synthesis, transcription, language
{
  const ctx = await setup({ xai: true });
  try {
    let s = await ctx.pi();
    const models = notes(await command(s, '/speech --models'));
    const xaiLines = lines(models).filter((l) => /^xai\b/.test(l.trim()));
    check(xaiLines.length === 2, 'xai is listed once as a speech model and once as a transcription model', xaiLines);
    check(xaiLines.every((l) => /price unknown/i.test(l) && !/\$\d/.test(l)), 'no price is invented for xai', xaiLines);

    let n = await command(s, '/speech --set tts-model xai');
    check(errors(n).length === 0, 'selecting xai with a login succeeds', notes(n));
    const st = notes(await command(s, '/speech --status'));
    check(/Speech model: xai/.test(st) && /Voice: (ara|eve|leo)\b/.test(st), 'status shows xai and one of its voices', st);
    const v = notes(await command(s, '/speech --voices'));
    check(['ara', 'eve', 'leo'].every((x) => v.includes(x)), 'voices come from the xAI voice list', v);
    const vreq = ctx.xai.requests.find((r) => r.path === '/v1/tts/voices');
    check(vreq?.headers.authorization === `Bearer ${ctx.xaiKey}`, 'the voice list request carries the xAI login token', vreq?.headers.authorization?.slice(0, 14));

    await command(s, '/speech --set voice leo');
    n = await command(s, '/speech Hello from xai');
    check(errors(n).length === 0, 'speaking with xai succeeds', notes(n));
    const req = ctx.xai.tts().at(-1);
    check(req?.body?.text === 'Hello from xai' && req.body.voice_id === 'leo' && req.body.language === 'auto', 'the request carries text, voice_id and language auto', req?.body);
    check(req?.headers.authorization === `Bearer ${ctx.xaiKey}`, 'the request carries the xAI login token');
    check(ctx.speechRequests().length === 0, 'OpenRouter is not used for xai speech', ctx.speechRequests().length);
    const files = ctx.history();
    const wavs = files.filter((f) => f.endsWith('.wav')), mp3s = files.filter((f) => f.endsWith('.mp3'));
    check(wavs.length === 1 && mp3s.length === 1, 'one message is saved as WAV and MP3', files);
    if (wavs[0]) check(isWav(fs.readFileSync(path.join(ctx.speechDir, wavs[0]))), 'the saved WAV is a valid WAV file');
    await new Promise((r) => setTimeout(r, 500));
    const played = ctx.playerLog();
    check(played.length === 1 && played[0].startsWith(ctx.speechDir), 'the saved message is played', played);

    const { content } = await callTool(ctx, s, 'speech_synthesize', { text: 'tool call through xai' });
    check(ctx.xai.tts().at(-1)?.body?.text === 'tool call through xai' && /\.wav/.test(content), 'speech_synthesize uses xai and names the saved WAV', content.slice(0, 200));

    await command(s, '/speech --set stt-model xai');
    const clip = path.join(ctx.work, 'clip.wav');
    fs.writeFileSync(clip, wavBytes(0.6));
    ctx.xai.setTranscript('the quick brown fox');
    const t = await callTool(ctx, s, 'speech_transcribe', { path: clip });
    const sreq = ctx.xai.stt().at(-1);
    check(sreq?.headers.authorization === `Bearer ${ctx.xaiKey}` && sreq?.body?.multipart?.some((p) => p.name === 'file' && p.bytes > 0), 'transcription posts the audio as multipart file with the token', sreq?.body);
    check(t.content.includes('the quick brown fox'), 'the tool result holds the xAI transcript', t.content.slice(0, 200));
    check(!ctx.or.requests.some((r) => r.path.includes('/audio/transcriptions')), 'OpenRouter is not used for xai transcription');

    // credentials stay with their own provider
    check(![...ctx.xai.requests].some((r) => JSON.stringify(r).includes(ctx.key)), 'the OpenRouter key is never sent to xAI');
    check(![...ctx.or.requests].some((r) => JSON.stringify(r).includes(ctx.xaiKey)), 'the xAI token is never sent to OpenRouter');
    check(!JSON.stringify(s.events).includes(ctx.xaiKey), 'the xAI token never appears in events');

    // the choice persists
    await s.close();
    s = await ctx.pi();
    const st2 = notes(await command(s, '/speech --status'));
    check(/Speech model: xai/.test(st2) && /Transcription model: xai/.test(st2) && /Voice: leo/.test(st2), 'xai and its voice persist across a restart', st2);

    // voice language: xAI lists its voices as multilingual
    const langs = notes(await command(s, '/speech --languages'));
    check(lines(langs).some((l) => l.startsWith('ara') && /multilingual/i.test(l)), 'a xai voice is shown as multilingual', langs);
    const before = ctx.history().length;
    n = await command(s, '/speech --sample ara', 800);
    const smp = ctx.xai.tts().at(-1)?.body;
    check(smp?.voice_id === 'ara' && !KANA.test(smp.text) && /english/i.test(notes(n)), 'a multilingual voice is sampled in English and the fallback is disclosed', [smp, notes(n)]);
    n = await command(s, '/speech --language ara ja');
    check(errors(n).length === 0, 'a language override can be set on a xai voice', notes(n));
    await command(s, '/speech --sample ara', 800);
    const jp = ctx.xai.tts().at(-1)?.body;
    check(KANA.test(jp?.text ?? '') && jp?.language === 'ja', 'the override selects Japanese text and language ja in the request', jp);
    check(ctx.history().length === before, 'samples stay out of the history');

    // failures are visible and never fall back to another provider
    const spoken = ctx.xai.tts().length, played2 = ctx.playerLog().length, hist = ctx.history().length;
    ctx.xai.failNext(1, 401, { error: 'Unauthorized: invalid or missing credentials' });
    n = await command(s, '/speech this will fail', 800);
    check(errors(n).length > 0 && /xai/i.test(notes(n)) && /log ?in/i.test(notes(n)), 'a rejected login is an error naming xAI and the login', notes(n));
    check(!notes(n).includes(ctx.xaiKey), 'the error never shows the token');
    ctx.xai.failNext(1, 500, { error: 'upstream broke' });
    n = await command(s, '/speech this fails too', 800);
    check(errors(n).length > 0 && /500|upstream broke/.test(notes(n)), 'a server error is an error with its status or message', notes(n));
    check(ctx.speechRequests().length === 0, 'no failure falls back to OpenRouter', ctx.speechRequests().length);
    check(ctx.playerLog().length === played2 && ctx.history().length === hist && ctx.xai.tts().length === spoken + 2, 'a failure plays and saves nothing');

    // back to OpenRouter
    await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
    await command(s, '/speech --set voice af_heart');
    const xaiCalls = ctx.xai.tts().length;
    await command(s, '/speech and back to openrouter');
    check(ctx.speechRequests().length === 1 && ctx.xai.tts().length === xaiCalls, 'switching back to an OpenRouter model uses OpenRouter again');
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}
finish();
