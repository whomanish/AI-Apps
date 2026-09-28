// Shared LLM tool-loop for the drafter and analyst. DOM-free (fetch only).
// executors: { toolName: async (args) => resultObject }

import { callLLM } from './intake/llm.js';

export function toOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function runToolLoop(settings, { system, messages, tools, executors, maxRounds = 6 }) {
  const openAITools = toOpenAITools(tools);
  const convo = [...messages];
  const editSummaries = [];
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds += 1;
    const msg = await rawCall(settings, system, convo, openAITools);
    convo.push(msg);

    const calls = (msg.tool_calls || []);
    if (!calls.length) return { text: msg.content || '', messages: convo };

    for (const c of calls) {
      const name = c.function.name;
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
      let result;
      try {
        const exec = executors[name];
        result = exec ? await exec(args) : { error: `unknown tool ${name}` };
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      convo.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 12000) });
      if (result && result.ok && result.edit) editSummaries.push(result.edit);
    }
  }
  // The model burned all its rounds on tools without writing a reply. End on a
  // short completion summary built from what the tools actually did — never on
  // a bare "(tool rounds exhausted)".
  const summary = summarizeEdits(editSummaries);
  return { text: summary, messages: convo, exhausted: true };
}

// Short buyer-facing completion summary from tool-result edit descriptions.
export function summarizeEdits(edits) {
  const ds = (edits || []).filter(Boolean);
  if (!ds.length) return 'Done — the draft was updated.';
  if (ds.length === 1) return `Done — ${lcFirst(ds[0])}.`;
  const last = ds[ds.length - 1];
  return `Done — ${ds.length} updates applied, finishing with ${lcFirst(last)}.`;
}

function lcFirst(s) {
  s = String(s);
  return s.charAt(0).toLowerCase() + s.slice(1);
}

async function rawCall(settings, system, convo, tools) {
  const { baseUrl, apiKey, model } = settings;
  if (!apiKey) throw new Error('NO_API_KEY');
  const body = {
    model,
    max_tokens: 4000,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...convo],
    tools,
    tool_choice: 'auto',
  };
  if (supportsReasoningEffort(model)) body.reasoning_effort = 'low';
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM_${res.status}`);
  const data = await res.json();
  return data.choices[0].message;
}

function supportsReasoningEffort(model) {
  return /^(o[1-9]|o[1-9]-|gpt-5|gpt-5\.)/i.test(String(model || ''));
}

// Transcript for storage + next-turn API use: tool payloads truncated, but the
// assistant tool_calls / tool response pairing kept intact (the API requires it).
export function apiTranscript(messages, keepChars = 600) {
  return messages.map(m => {
    if (m.role === 'tool') return { ...m, content: String(m.content).slice(0, keepChars) };
    return m;
  });
}

// Displayable messages only (drop tool plumbing and content-less tool calls).
export function displayMessages(messages) {
  return (messages || []).filter(m =>
    m.role === 'user' || (m.role === 'assistant' && m.content && !(m.tool_calls || []).length));
}
