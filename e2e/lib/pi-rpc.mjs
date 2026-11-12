import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeLlm } from './fake-llm.mjs';

const PRELOAD = fileURLToPath(new URL('./preload.mjs', import.meta.url));

export async function startPi({ extension, agentDir, env = {}, cwd, extraArgs = [], llm, openrouterUrl, onUi, session = false, fetchLog } = {}) {
  let ownedLlm = null, ownedDir = null;
  if (!agentDir) {
    if (!llm) llm = ownedLlm = await startFakeLlm();
    agentDir = ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-harness-'));
    writeAgentDir(agentDir, llm.url);
  }
  cwd ??= fs.mkdtempSync(path.join(os.tmpdir(), 'pi-harness-cwd-'));
  const args = ['--mode', 'rpc', '--no-extensions', ...(extension ? ['-e', path.resolve(extension)] : []),
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--offline', '--no-mcp',
    '--provider', 'fake', '--model', 'fake-model'];
  if (session) args.push('--session-dir', path.join(agentDir, 'sessions'));
  else args.push('--no-session');
  args.push(...extraArgs);
  const childEnv = { ...process.env, ...env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1',
    NODE_OPTIONS: `--import ${PRELOAD}${env.NODE_OPTIONS ? ' ' + env.NODE_OPTIONS : ''}` };
  for (const k of Object.keys(childEnv)) if (childEnv[k] == null) delete childEnv[k]; // null/undefined = unset
  if (openrouterUrl) childEnv.FAKE_OPENROUTER_URL = openrouterUrl;
  if (fetchLog) childEnv.FAKE_FETCH_LOG = fetchLog;

  const child = spawn('pi', args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [], uiRequests = [], pending = new Map(), waiters = new Set();
  let stderr = '', nextId = 1, exited = false;
  const exitP = new Promise((res) => child.on('exit', (code, sig) => { exited = true; res({ code, sig }); for (const w of waiters) w.check(); }));
  child.stderr.on('data', (d) => { stderr += d; s.stderr = stderr; });
  child.stdin.on('error', () => {});

  const uiHandler = onUi ?? (() => ({ cancelled: true }));
  const dialogs = new Set(['select', 'confirm', 'input', 'editor']);
  function handle(msg) {
    events.push(msg);
    if (msg.type === 'response' && msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.type === 'extension_ui_request') {
      uiRequests.push(msg);
      if (dialogs.has(msg.method)) {
        Promise.resolve(s.onUi(msg)).then((r) => write({ type: 'extension_ui_response', id: msg.id, ...(r ?? { cancelled: true }) }));
      }
    }
    for (const w of [...waiters]) w.check();
  }
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try { handle(JSON.parse(line)); } catch { events.push({ type: 'unparsed', line }); }
    }
  });
  function write(o) { child.stdin.write(JSON.stringify(o) + '\n'); }

  function waitFor(pred, timeoutMs = 15000, from = 0) {
    return new Promise((resolve, reject) => {
      const w = {
        check() {
          const e = events.slice(from).find(pred);
          if (e) { done(); resolve(e); }
          else if (exited) { done(); reject(new Error('pi exited while waiting. stderr:\n' + stderr)); }
        },
      };
      const t = setTimeout(() => { done(); reject(new Error(`waitFor timeout after ${timeoutMs}ms; last events: ${JSON.stringify(events.slice(-5)).slice(0, 800)}\nstderr:\n${stderr}`)); }, timeoutMs);
      const done = () => { clearTimeout(t); waiters.delete(w); };
      waiters.add(w); w.check();
    });
  }
  function send(cmd, timeoutMs = 15000) {
    const id = cmd.id ?? `h${nextId++}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error('response timeout for ' + JSON.stringify(cmd))); }, timeoutMs);
      pending.set(id, (r) => { clearTimeout(t); resolve(r); });
      write({ ...cmd, id });
    });
  }
  const s = {
    agentDir, cwd, llm, child, events, uiRequests, stderr, onUi: uiHandler, send, waitFor,
    async prompt(text, timeoutMs = 30000) {
      const from = events.length;
      const r = await send({ type: 'prompt', message: text }, timeoutMs);
      if (!r.success) throw new Error('prompt rejected: ' + r.error);
      if (r.data?.disposition === 'handled') return r;
      await waitFor((e) => e.type === 'agent_settled', timeoutMs, from);
      return r;
    },
    async getCommands() { return (await send({ type: 'get_commands' })).data.commands; },
    async close() {
      try { child.stdin.end(); } catch {}
      const t = setTimeout(() => child.kill('SIGTERM'), 5000);
      const t2 = setTimeout(() => child.kill('SIGKILL'), 8000);
      const r = await exitP;
      clearTimeout(t); clearTimeout(t2);
      if (ownedLlm) await ownedLlm.close();
      return r;
    },
    cleanup() { if (ownedDir) fs.rmSync(ownedDir, { recursive: true, force: true }); },
  };
  return s;
}

export function writeAgentDir(dir, llmUrl) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
    providers: { fake: {
      baseUrl: llmUrl + '/v1', api: 'openai-completions', apiKey: 'fake-key',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
      models: [{ id: 'fake-model', name: 'Fake Model', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model', quietStartup: true }, null, 2));
}
