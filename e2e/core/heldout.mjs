// Held-out acceptance for pi-speech core.
import fs from 'node:fs';
import path from 'node:path';
import { callTool, check, command, errors, finish, notes, setup, wavBytes } from '../lib/lib.mjs';

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. credentials stay with OpenRouter; tool-call overrides; play:false; voices list
{
  const ctx = await setup();
  try {
    const s = await ctx.pi({ session: true });
    await callTool(ctx, s, 'speech_synthesize', { text: 'Secret keeping test', play: false });
    await sleep(400);
    check(ctx.playerLog().length === 0, 'play:false does not start the player', ctx.playerLog());
    check(ctx.history().filter((f) => f.endsWith('.wav')).length === 1, 'play:false still saves the message');
    const set = await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
    await command(s, '/speech --set voice af_heart');
    const v = notes(await command(s, '/speech --voices'));
    check(v.includes('jf_alpha') && v.includes('af_heart') && v.includes('zm_yunxi'), 'voices lists the voices of the current model', v.slice(0, 200));
    const r = await callTool(ctx, s, 'speech_synthesize', { text: 'Per call override', model: 'deepgram/aura-2', voice: 'aura-2-ama-ja' });
    const last = ctx.speechRequests().at(-1);
    check(last?.body?.model === 'deepgram/aura-2' && last?.body?.voice === 'aura-2-ama-ja', 'tool model and voice apply to that call', last?.body);
    const st = notes(await command(s, '/speech --status'));
    check(st.includes('hexgrad/kokoro-82m') && st.includes('af_heart'), 'a per-call override does not change the saved settings', st);
    const before = ctx.speechRequests().length;
    const bad = await callTool(ctx, s, 'speech_synthesize', { text: 'bad voice', voice: 'no_such_voice' });
    check(ctx.speechRequests().length === before, 'an unknown voice is refused before any request');
    check(/af_heart|jf_alpha|voice/i.test(bad.content), 'the refusal names valid voices', bad.content.slice(0, 200));
    const sv = await command(s, '/speech --set voice no_such_voice');
    check(errors(sv).length > 0, 'setting an unknown voice is an error', notes(sv));
    check(notes(await command(s, '/speech --status')).includes('af_heart'), 'a refused voice leaves the setting unchanged');
    const sm = await command(s, '/speech --set tts-model openai/whisper-1');
    check(errors(sm).length > 0, 'a transcription model is refused as speech model', notes(sm));
    await s.close();

    const hay = [JSON.stringify(s.events), s.stderr];
    for (const f of [...walk(ctx.agentDir), ...walk(ctx.speechDir), ...walk(ctx.home)]) {
      hay.push(f);
      try { hay.push(fs.readFileSync(f).toString('latin1')); } catch {}
    }
    check(!hay.some((h) => h.includes(ctx.key)), 'the key appears in no output, session, settings, history or home file');
    const others = ctx.or.requests.filter((q) => q.headers.authorization && q.headers.authorization !== `Bearer ${ctx.key}`);
    check(others.length === 0, 'every OpenRouter request uses the resolved key');
    const urls = fs.existsSync(ctx.fetchLog) ? fs.readFileSync(ctx.fetchLog, 'utf8').split('\n').filter(Boolean) : [];
    const foreign = urls.filter((u) => !/^https:\/\/openrouter\.ai\//.test(u) && !/^http:\/\/127\.0\.0\.1:/.test(u));
    check(foreign.length === 0, 'the extension fetches only openrouter.ai', foreign.slice(0, 3));
  } finally { await ctx.close(); ctx.cleanup(); }
}

// 2. key from models.json; tools off persists
{
  const ctx = await setup();
  try {
    const mj = path.join(ctx.agentDir, 'models.json');
    const models = JSON.parse(fs.readFileSync(mj, 'utf8'));
    models.providers.openrouter = { apiKey: ctx.key + '-mj' };
    fs.writeFileSync(mj, JSON.stringify(models));
    let s = await ctx.pi({ env: { OPENROUTER_API_KEY: '' } });
    await command(s, '/speech models json key');
    const r = ctx.speechRequests().at(-1);
    check(r?.headers?.authorization === `Bearer ${ctx.key}-mj`, 'key from models.json when the variable is empty', r?.headers?.authorization?.slice(0, 24));
    await command(s, '/speech --set tools off');
    await s.close();
    s = await ctx.pi();
    ctx.llm.script([{ text: 'x' }]);
    await s.prompt('hi', 60000);
    const tools = (ctx.llm.requests.at(-1)?.tools ?? []).map((t) => t.function?.name ?? t.name);
    check(!tools.includes('speech_synthesize') && !tools.includes('speech_transcribe'), 'tools off persists across restart', tools);
    await command(s, '/speech --set tools on');
    ctx.llm.script([{ text: 'y' }]);
    await s.prompt('hi again', 60000);
    const tools2 = (ctx.llm.requests.at(-1)?.tools ?? []).map((t) => t.function?.name ?? t.name);
    check(tools2.includes('speech_synthesize') && tools2.includes('speech_transcribe'), 'tools on restores both tools', tools2);
  } finally { await ctx.close(); ctx.cleanup(); }
}

// 3. MP3-only models, failures, conversion failure, transcription formats
{
  const ctx = await setup({ mp3OnlyModels: ['minimax/speech-2.8-hd'] });
  try {
    const s = await ctx.pi();
    await command(s, '/speech --set tts-model minimax/speech-2.8-hd');
    await command(s, '/speech --set voice English_CalmWoman');
    await command(s, '/speech mp3 only model');
    await sleep(300);
    const h = ctx.history();
    check(h.length === 1 && h[0].endsWith('.mp3'), 'an MP3-only model is saved once, as its MP3', h);

    fs.rmSync(ctx.speechDir, { recursive: true, force: true });
    const played0 = ctx.playerLog().length;
    ctx.or.failNext(1, 500, { error: { message: 'upstream exploded', code: 500 } });
    const f = await command(s, '/speech this will fail');
    check(errors(f).some((n) => /upstream exploded|500/.test(n.message)), 'an OpenRouter failure is reported', notes(f));
    check(ctx.history().length === 0, 'a failed synthesis saves nothing', ctx.history());
    await sleep(300);
    check(ctx.playerLog().length === played0, 'a failed synthesis plays nothing');

    const clip = path.join(ctx.work, 'clip.mp3');
    fs.copyFileSync(new URL('../lib/fixture.mp3', import.meta.url), clip);
    ctx.or.setTranscript('mp3 transcript text');
    const t = await callTool(ctx, s, 'speech_transcribe', { path: clip, model: 'openai/whisper-1' });
    const treq = ctx.or.requests.filter((r) => r.path.startsWith('/api/v1/audio/transcriptions')).at(-1);
    const fmt = treq?.body?.input_audio?.format;
    check(t.content.includes('mp3 transcript text'), 'an MP3 file is transcribed', t.content.slice(0, 200));
    check(treq?.body?.model === 'openai/whisper-1' || JSON.stringify(treq?.body ?? '').includes('openai/whisper-1'), 'the given transcription model is used', treq?.body);
    check(fmt === undefined || fmt === 'mp3', 'MP3 audio is declared as mp3', fmt);
    const missing = await callTool(ctx, s, 'speech_transcribe', { path: path.join(ctx.work, 'nope.wav') });
    check(/nope\.wav|not found|no such|ENOENT|exist/i.test(missing.content), 'a missing file is a readable error', missing.content.slice(0, 200));
    await s.close();

    const bin = path.join(ctx.work, 'badbin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\necho "ffmpeg: broken" >&2\nexit 1\n', { mode: 0o755 });
    fs.rmSync(ctx.speechDir, { recursive: true, force: true });
    const s2 = await ctx.pi({ env: { PATH: `${bin}:${process.env.PATH}` } });
    await command(s2, '/speech --set tts-model hexgrad/kokoro-82m');
    await command(s2, '/speech --set voice af_heart');
    const r = await callTool(ctx, s2, 'speech_synthesize', { text: 'conversion will fail', play: false });
    const h2 = ctx.history();
    check(h2.length === 1 && h2[0].endsWith('.wav'), 'with a broken ffmpeg on PATH the message is saved once, as a WAV', h2);
    const named = [...r.content.matchAll(/(\/[^\s"'`,)]+\.(?:wav|mp3))/g)].map((m) => m[1]);
    check(named.length > 0 && named.every((p) => fs.existsSync(p)), 'the result names only files that exist', named);
    check(!/convert|ffmpeg/i.test(r.content), 'the result says nothing about converting (no ffmpeg is used)', r.content.slice(0, 300));
  } finally { await ctx.close(); ctx.cleanup(); }
}

// 4. default history dir under HOME; unique names; stale saved model replaced
{
  const ctx = await setup({ env: { PI_SPEECH_DIR: null } });
  try {
    let s = await ctx.pi();
    await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
    await command(s, '/speech --set voice af_heart');
    await command(s, '/speech same words', 50);
    await command(s, '/speech same words', 50);
    await sleep(300);
    const dir = path.join(ctx.home, 'Music', 'pi-speech');
    const h = ctx.history(dir);
    check(h.filter((f) => f.endsWith('.wav')).length === 2, 'default history is ~/Music/pi-speech and repeated text keeps both messages', h);
    check(!fs.existsSync(path.join(ctx.home, 'Music', 'pi-tts')), "the source extension's history directory is untouched");
    await s.close();

    const cat = JSON.parse(fs.readFileSync(new URL('../lib/openrouter-models.json', import.meta.url), 'utf8'));
    cat.data = cat.data.filter((m) => m.id !== 'hexgrad/kokoro-82m');
    const { startFakeOpenRouter } = await import('../lib/fake-openrouter.mjs');
    const or2 = await startFakeOpenRouter({ catalog: cat });
    try {
      s = await ctx.pi({ openrouterUrl: or2.url });
      await s.waitFor((m) => m.type === 'extension_ui_request' && m.method === 'notify' && /kokoro/.test(m.message ?? ''), 20000).catch(() => {});
      const warn = s.uiRequests.filter((u) => u.method === 'notify' && /kokoro/.test(u.message ?? ''));
      check(warn.some((w) => w.notifyType === 'warning'), 'a saved model missing from the catalog is replaced with a warning', warn.map((w) => w.message));
      await command(s, '/speech after replacement');
      const last = or2.requests.filter((r) => r.path.startsWith('/api/v1/audio/speech')).at(-1);
      check(last && last.body?.model !== 'hexgrad/kokoro-82m', 'synthesis no longer uses the missing model', last?.body?.model);
    } finally { await or2.close(); }
  } finally { await ctx.close(); ctx.cleanup(); }
}
finish();
