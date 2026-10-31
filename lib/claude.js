'use strict';
// Minimal Anthropic Messages API client (Node 18+). The API key stays on the server.
async function complete({ system, messages, max_tokens = 800, model }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY is not set. Add it to .env, or set MOCK_LLM=1 to test without it.'), { status: 503 });
  const body = JSON.stringify({ model: model || process.env.CLAUDE_MODEL || 'claude-haiku-5-5', max_tokens, system, messages });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body,
      signal: AbortSignal.timeout(45000),
    });
    if (res.ok) {
      const j = await res.json();
      return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    const t = await res.text();
    throw Object.assign(new Error('Claude API error ' + res.status + ': ' + t.slice(0, 300)), { status: 502 });
  }
}
module.exports = { complete };
