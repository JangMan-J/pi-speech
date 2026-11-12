// Visible acceptance for pi-speech core: real pi (RPC mode) with only this extension, fake LLM and fake OpenRouter.
import fs from 'node:fs';
import path from 'node:path';
import { callTool, check, command, errors, finish, isWav, notes, setup, wavBytes } from '../lib/lib.mjs';

const ctx = await setup();
try {
  let s = await ctx.pi();

  const cmds = (await s.getCommands()).filter((c) => c.source === 'extension').map((c) => c.name);
  check(JSON.stringify(cmds) === JSON.stringify(['speech']), 'the only extension command is /speech', cmds);

  ctx.llm.script([{ text: 'hello' }]);
  await s.prompt('hi', 60000);
  const tools = (ctx.llm.requests.at(-1)?.tools ?? []).map((t) => t.function?.name ?? t.name).sort();
  check(JSON.stringify(tools) === JSON.stringify(['speech_synthesize', 'speech_transcribe']), 'the only tools are speech_synthesize and speech_transcribe', tools);

  // synthesize through the tool
  const text = 'Hello from the acceptance check';
  const { content } = await callTool(ctx, s, 'speech_synthesize', { text });
  const req = ctx.speechRequests().at(-1);
  check(req && req.headers.authorization === `Bearer ${ctx.key}`, 'synthesis request carries the OpenRouter key', req?.headers?.authorization?.slice(0, 20));
  check(req && req.body?.input === text, 'synthesis request carries the text', req?.body);
  const files = ctx.history();
  const wavs = files.filter((f) => f.endsWith('.wav')), mp3s = files.filter((f) => f.endsWith('.mp3'));
  check(wavs.length === 1 && mp3s.length === 1, 'one message saved as WAV and MP3', files);
  if (wavs[0]) check(isWav(fs.readFileSync(path.join(ctx.speechDir, wavs[0]))), 'saved WAV is a valid WAV file');
  if (wavs[0]) check(content.includes(path.join(ctx.speechDir, wavs[0])), 'tool result names the saved WAV', content.slice(0, 300));
  await new Promise((r) => setTimeout(r, 500));
  const played = ctx.playerLog();
  check(played.length === 1 && fs.existsSync(played[0]) && played[0].startsWith(ctx.speechDir), 'the saved message is played with PI_SPEECH_PLAYER', played);

  // transcribe through the tool
  const clip = path.join(ctx.work, 'clip.wav');
  fs.writeFileSync(clip, wavBytes(0.6));
  ctx.or.setTranscript('the quick brown fox');
  const t = await callTool(ctx, s, 'speech_transcribe', { path: clip });
  const treq = ctx.or.requests.filter((r) => r.path.startsWith('/api/v1/audio/transcriptions')).at(-1);
  check(treq && treq.headers.authorization === `Bearer ${ctx.key}`, 'transcription request carries the key');
  check(t.content.includes('the quick brown fox'), 'tool result holds the transcript', t.content.slice(0, 300));

  // prices
  const m = notes(await command(s, '/speech --models'));
  const line = (id) => m.split('\n').find((l) => l.includes(id)) ?? '';
  check(line('elevenlabs/eleven-v3 ').includes('~$0.064/min') || line('elevenlabs/eleven-v3').includes('~$0.064/min'), 'estimated speech price marked with ~', line('elevenlabs/eleven-v3'));
  check(/\$0\.006\/min/.test(line('openai/whisper-1')) && !line('openai/whisper-1').includes('~$0.006'), 'exact transcription price without ~', line('openai/whisper-1'));

  // settings persist across a restart without sessions
  const set1 = await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
  const set2 = await command(s, '/speech --set voice jf_alpha');
  check(errors([...set1, ...set2]).length === 0, 'setting model and voice succeeds', notes([...set1, ...set2]));
  await s.close();
  s = await ctx.pi();
  const st = notes(await command(s, '/speech --status'));
  check(st.includes('hexgrad/kokoro-82m') && st.includes('jf_alpha'), 'status after restart shows the saved model and voice', st);
  await command(s, '/speech konnichiwa');
  const r2 = ctx.speechRequests().at(-1);
  check(r2?.body?.model === 'hexgrad/kokoro-82m' && r2?.body?.voice === 'jf_alpha', 'after restart synthesis uses the saved model and voice', r2?.body);
  await s.close();

  // missing key
  const n0 = ctx.speechRequests().length;
  s = await ctx.pi({ env: { OPENROUTER_API_KEY: null } });
  const nk = await command(s, '/speech hello');
  check(errors(nk).some((n) => /api key/i.test(n.message)), 'without a key the error says so', notes(nk));
  check(ctx.speechRequests().length === n0, 'without a key nothing is sent');
  await s.close();

  // history keeps the newest ten messages
  fs.rmSync(ctx.speechDir, { recursive: true, force: true });
  s = await ctx.pi();
  let early = [];
  for (let i = 1; i <= 12; i++) {
    await command(s, `/speech history message number ${i}`, 100);
    if (i === 2) early = ctx.history();
  }
  await new Promise((r) => setTimeout(r, 500));
  const h = ctx.history();
  const hw = h.filter((f) => f.endsWith('.wav')), hm = h.filter((f) => f.endsWith('.mp3'));
  check(hw.length === 10 && hm.length === 10, 'history holds ten WAV and ten MP3 files', h.length);
  check(hw.every((f) => hm.includes(f.replace(/\.wav$/, '.mp3'))), 'each kept WAV has its MP3');
  check(early.length === 4 && early.every((f) => !h.includes(f)), 'the two oldest messages were removed', early);
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
