// Edge cases through the shared frame, with isolated fake services and null audio.
import { check, finish, setup } from '../lib/lib.mjs';
import { openPanelPi, readSettings, sleep, capture } from '../lib/panel.mjs';
import { startReceiver } from '../lib/receiver.mjs';
async function scenario(options, run, terminal = {}) {
  const ctx = await setup(options); let t;
  try { t = await openPanelPi(ctx,terminal); await t.open(); await run(t,ctx); }
  finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}
const screen = t => capture(t).join('\n');
await scenario({},async t=>{
  check(!/idle/i.test(screen(t).split('\n')[0]),'idle title has no badge');
  await t.key('Tab',7); check(/Remote machine/.test(screen(t)),'Shift/Tab navigation reaches Bridge');
  await t.key('Tab'); check(/Speak: >/.test(screen(t)),'Tab wraps to Main');
  await t.key('shift+tab'); check(/Remote machine/.test(screen(t)),'Shift+Tab wraps to Bridge');
  await t.key('Escape'); check(/Speak: >/.test(screen(t)),'Esc on tab returns to Main');
  t.type('rhst'); check(/Speak: > rhst/.test(screen(t)),'bare action letters are text on Main');
});
const bad = { PI_SPEECH_BRIDGE_URL:'http://127.0.0.1:9', PI_SPEECH_BRIDGE_TOKEN:'x'.repeat(40), SSH_TTY:'/dev/pts/3' };
await scenario({env:bad},async t=>{
  check(/Speak: >/.test(screen(t)),'unreachable receiver does not prevent opening');
  await t.key('Tab',7); await sleep(1500);
  check(/✗.*unreachable|unreachable.*✗/.test(screen(t)),'Bridge reports receiver unreachable');
},{env:bad,unset:['SSH_CONNECTION','PI_SPEECH_LOCAL_MIC']});
await scenario({},async t=>{
  await t.key('Tab',4);
  check(!/xAI Grok|\bxai\//.test(screen(t)),'no xAI models without login');
});
await scenario({xai:true},async (t,ctx)=>{
  await t.key('Tab',2); t.type('kok'); await sleep(400);
  const s=screen(t); check(/hexgrad\/kokoro-82m/.test(s) && !/google\/gemini/.test(s),'typing on model tab filters');
  await t.key('Escape'); check(/Speech model\s+google\/gemini/.test(screen(t)),'Esc preserves model');
  await t.key('Tab',3); t.type('kore'); await sleep(300); await t.key('F2');
  check(/Language of Kore/.test(screen(t)),'F2 opens language field');
  t.type('ja'); await t.key('Enter');
  check(JSON.stringify(readSettings(ctx).languages).includes('ja') && /ja.*set by you/.test(screen(t)),'language override saved and displayed');
  await t.key('F2'); t.type('auto'); await t.key('Enter'); screen(t);
  check(!JSON.stringify(readSettings(ctx).languages??{}).includes('"ja"'),'auto removes language override');
});
const rcv = await startReceiver();
try {
  const env={PI_SPEECH_BRIDGE_URL:rcv.url,PI_SPEECH_BRIDGE_TOKEN:rcv.token,SSH_TTY:'/dev/pts/3'};
  await scenario({env},async (t,ctx)=>{
    await t.key('Tab',7); await sleep(1000);
    check(/Bridge\s+auto/.test(screen(t)),'Bridge starts auto');
    check(/Pairing\s+✓ Connected to 127\.0\.0\.1:\d+.*ms/.test(screen(t)),'Pairing shows reachable receiver');
    for (const mode of ['on','off','auto']) {
      await t.key('Right'); await sleep(400);
      check(new RegExp('Bridge\\s+'+mode).test(screen(t)) && readSettings(ctx).bridge===mode,`Bridge cycles and saves ${mode}`);
    }
    check(!/DIRECTION/.test(screen(t)),'Bridge has no direction heading');
    await t.key('Down',2); await t.key('Enter'); check(/Address|receiver.s address/.test(screen(t)),'Pairing Enter opens address field');
  },{env,unset:['SSH_CONNECTION','PI_SPEECH_LOCAL_MIC']});
} finally { await rcv.stop(); rcv.cleanup(); }
await scenario({},async (t,ctx)=>{
  await t.key('Tab',6); await t.key('Down'); t.type('k'); t.type('x'); await sleep(300);
  check(/cannot be a hotkey/.test(screen(t)),'bare hotkey refused');
  t.type('k'); await t.key('alt+s'); check(/already the key of Speak/.test(screen(t)),'duplicate hotkey refused');
  t.type('k'); await t.key('Escape'); screen(t);
  check(readSettings(ctx).hotkeys===undefined,'capture Escape saves nothing');
  t.type('k'); await t.key('alt+x'); screen(t);
  check(readSettings(ctx).hotkeys?.dictate==='alt+x','Dictate key saves');
  await t.key('Escape'); await sleep(3000); await t.open();
  check(/Alt\+X dictate/.test(screen(t)),'reloaded key bar shows custom Dictate key');
  t.close();
  const restarted = await openPanelPi(ctx);
  try {
    await restarted.open();
    check(/Alt\+X dictate/.test(screen(restarted)), 'custom Dictate key survives Pi restart');
    await restarted.key('Tab',6);
    check(/Dictate\s+Alt\+X/.test(screen(restarted)), 'Hotkeys shows saved binding after restart');
  } finally { restarted.close(); }
});
await scenario({},async t=>{
  const s=screen(t); check(/narrow/i.test(s || t.screen()),'narrow terminal gives honest fallback');
  check(t.lines().every(l=>[...l].length<=38),'narrow fallback fits');
},{cols:38,rows:24});
finish();
