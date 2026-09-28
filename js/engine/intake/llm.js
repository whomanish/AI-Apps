// Provider-agnostic LLM call (OpenAI-compatible /chat/completions). DOM-free (fetch only).
// The key is runtime paste-in only — never persisted, never committed.

export async function callLLM(settings, { system, messages, json = false, maxTokens = 8000, reasoningEffort = 'low', onEvent }) {
  const { baseUrl, apiKey, model } = settings;
  if (!apiKey) throw new Error('NO_API_KEY');

  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages,
    ],
  };
  if (json) body.response_format = { type: 'json_object' };
  if (reasoningEffort && supportsReasoningEffort(model)) body.reasoning_effort = reasoningEffort;

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM_${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const text = choice && choice.message && choice.message.content || '';
  return { text, usage: data.usage || null, finishReason: choice && choice.finish_reason };
}

function supportsReasoningEffort(model) {
  return /^(o[1-9]|o[1-9]-|gpt-5|gpt-5\.)/i.test(String(model || ''));
}

// Build a user message; imageDataUrl is a data: URL for vision-capable calls.
export function userMessage(text, imageDataUrl = null) {
  if (!imageDataUrl) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ],
  };
}

// --- Extraction prompt (hardened by the Sept 26 spike) ---
// The model is a VERBATIM extractor. All math (FX, /100, GST) happens in
// normalize.js. The spike showed an unconstrained model will helpfully divide
// per-100 prices itself — correct once, wrong on the next odd file.

export const EXTRACT_SYSTEM = `You are a verbatim transcription engine for vendor quotations. Transcribe EXACTLY what is printed. Never correct, normalize, convert, or "fix" anything.

Rules:
- Transcribe part numbers character-for-character, including anything that looks like a typo. Do not "correct" them.
- Report every price EXACTLY as printed, with its currency symbol/code. Never convert currencies.
- Never divide, multiply, or rebase a price. If a price is "per 100 boxes", report 7070 and say basis "per 100 boxes" — do the arithmetic never.
- Describe the price basis in quoted_basis using the vendor's own words (e.g. "per box", "per 100 boxes", "USD per box", "excluding GST", "inclusive of all taxes").
- quoted_gst is one of: "incl" | "excl" | "unstated". Use "unstated" unless the file explicitly says.
- If a row, page, or cell is unreadable, mark it {"unreadable": true, "note": "..."}. Never guess.
- Quantities: report as printed. Do not infer.
- Respond with a single JSON object only, no prose.`;

export function extractPrompt(vendorName, rfxPartsHint) {
  return `Vendor: ${vendorName}

Transcribe every quoted line item from the attached quotation file into this JSON shape:

{
  "lines": [
    {
      "quoted_part_number": "string exactly as printed, or null if absent",
      "quoted_description": "string as printed",
      "quoted_qty": number or null,
      "quoted_unit_price": number exactly as printed (no conversion),
      "quoted_currency": "INR" | "USD" | "as-printed code",
      "quoted_basis": "vendor's own words for the price basis",
      "quoted_gst": "incl" | "excl" | "unstated"
    }
  ],
  "meta": {
    "vendor_name": "as printed",
    "delivery_terms": "as printed, or null",
    "payment_terms": "as printed, or null",
    "notes": "anything unusual: typos you preserved, unclear cells, missing pages"
  }
}

The RFx these quotes answer has part numbers like: ${rfxPartsHint}. This hint is only to help you align rows — it does not authorize correcting what is printed.

Transcribe now. JSON only.`;
}
