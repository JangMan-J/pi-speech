// Held-out acceptance: streamed reading, edge cases.
import fs from 'node:fs';
import path from 'node:path';
import { callTool, check, command, errors, finish, notes, setup } from '../lib/lib.mjs';
import { startReceiver } from '../lib/receiver.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const make = (word, n = 12) => Array.from({ length: n }, (_, i) => `The ${word} part ${i + 1} explains the plan in plain words and keeps going on.`).join(' ');
const norm = (t) => t.replace(/\s+/g, ' ').trim();
const MS = 8;

// 1. in-flight cap, the tool, /speech <text>
{
  const ctx = await setup({ msPerChar: MS });
  try {
    const s = await ctx.pi();
    await command(s, '/speech --set tts-model hexgrad/kokoro-82m'); await command(s, '/speech --set voice af_heart');
    const text = make('first');
    let from = ctx.speechRequests().length;
    await command(s, `/speech ${text}`, 300);
    for (let i = 0; i < 100 && ctx.playerLog().length < 1; i++) await sleep(100);
    await sleep(MS * text.length * 0.7 + 2000);
    const inputs = ctx.speechRequests().slice(from).map((r) => r.body?.input ?? '');
    check(inputs.length >= 3 && norm(inputs.join(' ')) === norm(text), '/speech <long text> is streamed too and holds every word', inputs.length);
    check(ctx.or.maxInflight() <= 2, 'at most 2 speech requests are in flight at once', ctx.or.maxInflight());

    from = ctx.speechRequests().length;
    const { content } = await callTool(ctx, s, 'speech_synthesize', { text: make('tool') });
    const toolInputs = ctx.speechRequests().slice(from).map((r) => r.body?.input ?? '');
    check(toolInputs.length === 1 && norm(toolInputs[0]) === norm(make('tool')), 'speech_synthesize stays one request with the whole text', toolInputs.length);
    check(/\.wav/.test(content), 'and names the saved WAV');

    from = ctx.speechRequests().length;
    await command(s, '/speech --sample', 800);
    check(ctx.speechRequests().length === from + 1, 'a sample is one request');
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}

// 2. a failing piece ends the reading with one visible error and nothing saved
{
  const ctx = await setup({ msPerChar: MS });
  try {
    const s = await ctx.pi();
    await command(s, '/speech --set tts-model hexgrad/kokoro-82m'); await command(s, '/speech --set voice af_heart');
    await command(s, '/speech --read-aloud on');
    ctx.or.failNext(1, 500, { error: { message: 'injected stream failure', code: 500 } });
    const from = s.uiRequests.length;
    const reqFrom = ctx.speechRequests().length;
    ctx.llm.script([{ text: make('failing') }]);
    await s.prompt('go', 60000);
    await sleep(MS * 300 + 3000);
    const errs = errors(s.uiRequests.slice(from).filter((u) => u.method === 'notify'));
    check(errs.length === 1 && /injected stream failure|500/.test(errs[0].message), 'one visible error with the reason', errs.map((e) => e.message));
    check(/not saved|nothing was saved|no audio/i.test(errs[0]?.message ?? ''), 'the error says the reply was not saved', errs[0]?.message);
    check(ctx.speechRequests().length - reqFrom <= 3, 'no further pieces are requested after a failure', ctx.speechRequests().length - reqFrom);
    check(ctx.history().length === 0, 'nothing is saved', ctx.history());
    await sleep(500);
    check(ctx.playerLog().length === 0, 'no audio plays when the first piece fails', ctx.playerLog());
    check(!JSON.stringify(s.events).includes(ctx.key), 'the key never appears in events');
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}

// 3. a newer message replaces the one being read
{
  const ctx = await setup({ msPerChar: MS });
  try {
    const s = await ctx.pi();
    await command(s, '/speech --set tts-model hexgrad/kokoro-82m'); await command(s, '/speech --set voice af_heart');
    await command(s, '/speech --read-aloud on');
    const reqFrom = ctx.speechRequests().length;
    ctx.llm.script([{ text: make('older') }]);
    await s.prompt('one', 60000);
    for (let i = 0; i < 100 && ctx.playerLog().length < 1; i++) await sleep(100);
    ctx.llm.script([{ text: 'A new short answer.' }]);
    await s.prompt('two', 60000);
    await sleep(MS * 400 + 3000);
    const mark = ctx.speechRequests().findIndex((r, i) => i >= reqFrom && r.body?.input === 'A new short answer.');
    const after = ctx.speechRequests().slice(mark + 1).map((r) => r.body?.input ?? '');
    check(mark >= 0, 'the newer reply is spoken');
    check(after.every((t) => !/older part/.test(t)), 'no piece of the older reply is requested after the newer one began', after.length);
    const wavs = ctx.history().filter((f) => f.endsWith('.wav'));
    check(wavs.length === 1 && /new-short-answer/.test(wavs[0]), 'only the newer message is in the history', wavs);
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}

// 4. over the bridge the pieces play one after another on the receiver
const rcv = await startReceiver();
{
  const ctx = await setup({ msPerChar: MS, env: { PI_SPEECH_BRIDGE_URL: rcv.url, PI_SPEECH_BRIDGE_TOKEN: rcv.token } });
  try {
    const s = await ctx.pi({ env: { SSH_TTY: '/dev/pts/3' } });
    await command(s, '/speech --set tts-model hexgrad/kokoro-82m'); await command(s, '/speech --set voice af_heart');
    await command(s, '/speech --read-aloud on');
    const text = make('bridged');
    const reqFrom = ctx.speechRequests().length;
    ctx.llm.script([{ text }]);
    await s.prompt('go', 60000);
    await sleep(MS * text.length * 0.8 + 4000);
    const inputs = ctx.speechRequests().slice(reqFrom).map((r) => r.body?.input ?? '');
    const plays = rcv.starts('player');
    check(inputs.length >= 3 && norm(inputs.join(' ')) === norm(text), 'the whole reply is requested over the bridge route', inputs.length);
    check(plays.length === inputs.length, 'the receiver played one file per piece', [plays.length, inputs.length]);
    check(ctx.playerLog().length === 0, 'nothing played on the Pi host');
    const wavs = ctx.history().filter((f) => f.endsWith('.wav'));
    check(wavs.length === 1, 'one message in the history', ctx.history());
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); await rcv.stop(); rcv.cleanup(); }
}

// 5. xai streams too
{
  const ctx = await setup({ xai: true });
  try {
    const s = await ctx.pi();
    await command(s, '/speech --set tts-model xai');
    await command(s, '/speech --read-aloud on');
    const text = make('xai');
    ctx.llm.script([{ text }]);
    await s.prompt('go', 60000);
    await sleep(3000);
    const inputs = ctx.xai.tts().map((r) => r.body?.text ?? '');
    check(inputs.length >= 3 && norm(inputs.join(' ')) === norm(text), 'a xai reply is streamed in pieces that hold every word', inputs.length);
    check(ctx.speechRequests().length === 0, 'OpenRouter is not used');
    check(ctx.history().filter((f) => f.endsWith('.wav')).length === 1, 'one message in the history');
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}
// 6. a later piece that cannot be made into WAV is a failure, never a replay of the whole text
{
  const ctx = await setup({ msPerChar: MS, mismatchAt: 2 });
  try {
    const s = await ctx.pi();
    await command(s, '/speech --set tts-model hexgrad/kokoro-82m'); await command(s, '/speech --set voice af_heart');
    await command(s, '/speech --read-aloud on');
    const text = make('mixed');
    const from = s.uiRequests.length, reqFrom = ctx.speechRequests().length;
    ctx.llm.script([{ text }]);
    await s.prompt('go', 60000);
    await sleep(MS * 400 + 3000);
    const inputs = ctx.speechRequests().slice(reqFrom).map((r) => r.body?.input ?? '');
    check(!inputs.some((t) => norm(t) === norm(text)), 'the whole text is never requested again after audio started', inputs.map((t) => t.length));
    check(inputs.length <= 3, 'no more than the pieces in flight are requested', inputs.length);
    const errs = errors(s.uiRequests.slice(from).filter((u) => u.method === 'notify'));
    check(errs.length === 1 && /not saved/i.test(errs[0].message), 'one visible error that says the reply was not saved', errs.map((e) => e.message));
    check(ctx.playerLog().length <= 1, 'at most the first piece was played', ctx.playerLog().length);
    check(ctx.history().length === 0, 'nothing is saved', ctx.history());
    await s.close();
  } finally { await ctx.close(); ctx.cleanup(); }
}
finish();
