import http from 'node:http';

export async function startFakeLlm() {
  const requests = [];
  const queue = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) { res.writeHead(404); return res.end('{}'); }
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    requests.push(body);
    const turn = queue.shift() ?? { text: 'ok' };
    const id = 'chatcmpl-' + ++n, created = Math.floor(Date.now() / 1000), model = body.model || 'fake-model';
    const calls = (turn.toolCalls || []).map((c, i) => ({
      index: i, id: c.id || `call_${n}_${i}`, type: 'function',
      function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
    }));
    const finish = calls.length ? 'tool_calls' : 'stop';
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const base = { id, object: 'chat.completion.chunk', created, model };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id, object: 'chat.completion', created, model, usage,
        choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: turn.text ?? null, ...(calls.length ? { tool_calls: calls.map(({ index, ...c }) => c) } : {}) } }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    ev({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    if (turn.text) ev({ ...base, choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }] });
    if (calls.length) ev({ ...base, choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] });
    ev({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    ev({ ...base, choices: [], usage });
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    script(turns) { queue.push(...turns); },
    async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
  };
}
