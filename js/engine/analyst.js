// Response analyst: natural-language interrogation over the normalized intake. DOM-free.
// Judgment posture: only the buyer records qualification and award decisions.
// The analyst can offer conditional advice after buyer checks; no "L1" language.

import { runToolLoop, apiTranscript } from './loop.js';
import { vendorTotals, cheapestPerLine, lowestOnCommonSet } from './intake/normalize.js';
import { matchedAnswerSet, deterministicEvidence, validateEvidenceReview, buildAwardProposal, qualificationGapCount, validateQualificationTransition, applyQualificationTransition } from './qualification.js';

export const ANALYST_SYSTEM = `You are the Aerchain co-pilot's response analyst. The buyer has vendor quotations normalized side-by-side. You answer questions with cited figures, in plain procurement language.

Your tools read normalized prices, stored matched answers, published terms, validated evidence findings, buyer outcomes, and award state. Give evidence-based provisional shortlist and deprioritization advice when asked, even while reviews are pending. A formal award remains buyer-confirmed. Record technical statuses only when the buyer explicitly directs you to do so.

Iron rules:
1. Answer the buyer's requested shape first. If six buckets are requested, give six terse buckets. For advice, name a provisional shortlist and deprioritized vendors with evidence before discussing statuses and checks. Do not turn an advice question into a status change. For explicit directions to mark, record, set, or clear statuses, use record_outcomes; do not merely stage suggestions. If you asked for a gap override reason on an explicit status instruction, treat the buyer's natural-language answer as completing that instruction and call record_outcomes again. Never record an award.
2. Never use "L1". Say "lowest price on the common set" (the lines every vendor quoted).
3. Always say which denominator a total uses: the common set (lines all vendors quoted) vs a vendor's full quoted set. Never compare totals across different denominators without saying so.
4. Distinguish quoted-as-is from normalized values. Mention material conversion assumptions concisely. Any ex-works or freight-extra quote excludes freight, so do not call its price fully like-for-like with delivered prices.
5. Flags are first-class: part-number mismatches, GST-unstated lines, FX conversions, and unreadable rows must be surfaced, not buried.
6. Only report buyer-recorded outcomes. Never infer clearance from answer coverage or evidence findings.
7. For formal award allocation, use get_cleared_allocation. For provisional commercial advice, use ranking, line detail, flags and response evidence even before clearance; label it provisional.
8. Keep answers short. Do not expose internal field names or repeat line-by-line arithmetic unless asked. Lead with the requested answer, then material caveats.

Presentation: When an answer has multiple distinct points, put each on its own line; if using bullets, put each bullet on its own line. Use short paragraphs for material caveats. A one-sentence answer needs no list. Keep the requested answer first and do not omit material flags or checks for brevity.`;

export function analystTools() {
  return [
    { name: 'get_ranking', description: 'Lowest total over the lines quoted by ALL compared vendors.',
      parameters: { type: 'object', properties: {} } },
    { name: 'get_vendor_totals', description: 'Per-vendor totals over their own quoted lines.',
      parameters: { type: 'object', properties: {} } },
    { name: 'get_line_detail', description: 'All vendors\' quoted and normalized prices for one RFx line.',
      parameters: { type: 'object', properties: { sl: { type: 'number' } }, required: ['sl'] } },
    { name: 'cheapest_per_line', description: 'Cheapest vendor for each RFx line.',
      parameters: { type: 'object', properties: {} } },
    { name: 'get_flags', description: 'Normalization flags, optionally for one vendor.',
      parameters: { type: 'object', properties: { vendor_id: { type: 'string' } } } },
    { name: 'get_raw_response', description: 'The verbatim extracted lines for a vendor (quoted-as-is).',
      parameters: { type: 'object', properties: { vendor_id: { type: 'string' } }, required: ['vendor_id'] } },
    { name: 'get_review_queue', description: 'Pending buyer confirmations (part matches, GST basis...).',
      parameters: { type: 'object', properties: {} } },
    { name: 'get_qualification', description: 'Read-only buyer-recorded technical outcomes per vendor.',
      parameters: { type: 'object', properties: {} } },
    { name: 'get_matched_answers', description: 'Stored answers matched to active published question IDs; unmatched keys are excluded.', parameters: { type: 'object', properties: { vendor_id: { type: 'string' } }, required: ['vendor_id'] } },
    { name: 'get_published_terms', description: 'Published buyer-approved RFx terms.', parameters: { type: 'object', properties: {} } },
    { name: 'get_evidence_findings', description: 'Validated model evidence findings for one vendor.', parameters: { type: 'object', properties: { vendor_id: { type: 'string' } }, required: ['vendor_id'] } },
    { name: 'get_award_state', description: 'Read-only award proposal or final award state.', parameters: { type: 'object', properties: {} } },
    { name: 'get_cleared_allocation', description: 'Deterministic line-level price allocation among buyer-cleared vendors only; reports pending checks and unassigned lines.', parameters: { type: 'object', properties: {} } },
    { name: 'propose_outcomes', description: 'Stage analyst-suggested buyer outcomes for loaded vendors. This does not record outcomes; the buyer must review and record each one in the UI.', parameters: { type: 'object', properties: { proposals: { type: 'array', items: { type: 'object', properties: { vendor_id: { type: 'string' }, status: { type: 'string', enum: ['in_review', 'needs_clarification', 'technically_cleared', 'not_cleared'] }, rationale: { type: 'string' } }, required: ['vendor_id', 'status', 'rationale'] } } }, required: ['proposals'] } },
    { name: 'record_outcomes', description: 'Record one or more buyer-directed technical statuses atomically. Call only for an explicit buyer instruction to change status, never an advice question. For clearance with gaps, include an exact buyer-provided reason excerpt from this or an earlier buyer message; if none exists, ask for the reason instead. expected_response_version must match the current response.', parameters: { type: 'object', properties: { outcomes: { type: 'array', items: { type: 'object', properties: { vendor_id: { type: 'string' }, status: { type: 'string', enum: ['not_reviewed', 'in_review', 'needs_clarification', 'technically_cleared', 'not_cleared'] }, rationale: { type: 'string' }, override_reason: { type: 'string' }, buyer_reason_excerpt: { type: 'string' }, expected_response_version: { type: 'number' } }, required: ['vendor_id', 'status', 'rationale', 'expected_response_version'] } } }, required: ['outcomes'] } },
  ];
}

export function analystExecutors(store, buyerText = '') {
  const compared = () => {
    const s = store.get();
    // Analyst tools cover every loaded response. The table's vendor selector
    // only scopes its visual comparison and must not hide evidence from chat.
    return Object.values(s.intake).filter(v => v && v.normalized);
  };
  return {
    get_ranking: () => lowestOnCommonSet(compared().map(v => v.normalized)),
    get_vendor_totals: () => compared().map(v => vendorTotals(v.normalized)),
    get_line_detail: ({ sl }) => compared().map(v => {
      const l = v.normalized.lines.find(x => x.rfx_sl === sl);
      return l ? { vendor: v.normalized.vendorName, quoted: `${l.quoted_price} ${l.quoted_currency} (${l.quoted_basis}, GST: ${l.quoted_gst})`,
        normalized_inr_incl_gst: l.normalized_inr_incl_gst, matched: l.matched, flags: l.flags.map(f => f.text) }
        : { vendor: v.normalized.vendorName, quoted: null };
    }),
    cheapest_per_line: () => cheapestPerLine(compared().map(v => v.normalized)),
    get_flags: ({ vendor_id } = {}) => {
      const s = store.get();
      const entries = compared().filter(v => !vendor_id || v.normalized.vendorId === vendor_id).flatMap(v => [
        ...v.normalized.flags.map(f => ({ vendor: v.normalized.vendorName, vendor_id: v.vendorId, sl: f.sl ?? null, ...f })),
        ...v.normalized.lines.flatMap(l => (l.flags || []).map(f => ({ vendor: v.normalized.vendorName, vendor_id: v.vendorId, sl: l.rfx_sl, ...f }))),
      ]).map(f => {
        const checkKind = f.kind === 'part_mismatch' ? 'part_match' : f.kind === 'gst_unstated' ? 'gst_basis' : null;
        const checks = checkKind ? s.confirmations.filter(c => c.kind === checkKind && c.vendorId === f.vendor_id && Number(c.evidence?.rfx_sl) === Number(f.sl)) : [];
        return { ...f, review: checks.some(c => c.status === 'pending') ? 'pending buyer check' : checks.length ? 'check resolved' : 'normalization note' };
      });
      if (vendor_id) return entries;
      const groups = new Map();
      for (const f of entries) {
        const key = `${f.vendor_id}|${f.kind}|${f.review}`;
        const g = groups.get(key) || { vendor: f.vendor, kind: f.kind, review: f.review, count: 0, lineIds: [], example: f.text };
        g.count++;
        if (f.sl != null) g.lineIds.push(f.sl);
        groups.set(key, g);
      }
      return [...groups.values()].map(g => ({ ...g, lineIds: [...new Set(g.lineIds)].sort((a,b) => a-b) }));
    },
    get_raw_response: ({ vendor_id }) => {
      const v = compared().find(x => x.normalized.vendorId === vendor_id);
      return v ? { vendor: v.normalized.vendorName, extracted: v.extracted } : { error: 'unknown vendor' };
    },
    get_review_queue: () => store.get().confirmations.filter(c => c.status === 'pending'),
    get_qualification: () => store.get().qualification,
    get_matched_answers: ({ vendor_id }) => {
      const s = store.get(), intake = s.intake[vendor_id];
      if (!intake?.normalized) return { error: 'unknown vendor' };
      const result = matchedAnswerSet(intake.answers, s.rfx?.questions);
      return { vendor: intake.vendorName, answers: result.matched.map(x => ({ question_id: x.question.id, question: x.question.text, answer: x.answer })), count: result.count, total: result.total };
    },
    get_published_terms: () => (store.get().rfx?.terms || []).filter(t => !t.omitted).map(t => ({ id: t.id, text: t.sentence || t.text || t.title })),
    get_evidence_findings: ({ vendor_id }) => store.get().qualification[vendor_id]?.evidenceReview || { findings: [], status: 'not_run' },
    get_award_state: () => store.get().award || { status: 'pending' },
    get_cleared_allocation: () => {
      const s = store.get(), loaded = Object.values(s.intake).filter(v => v?.normalized);
      const ids = loaded.filter(v => s.qualification[v.vendorId]?.status === 'technically_cleared').map(v => v.vendorId);
      return buildAwardProposal(s.rfx, loaded, s.qualification, {}, s.confirmations, ids);
    },
    propose_outcomes: ({ proposals }) => {
      if (!Array.isArray(proposals) || proposals.length > 20) return { error: 'invalid proposal list' };
      const allowed = new Set(['in_review', 'needs_clarification', 'technically_cleared', 'not_cleared']);
      const staged = [];
      store.update(s => {
        if (s.award?.status === 'awarded') return;
        for (const p of proposals) {
          if (!allowed.has(p?.status) || typeof p.rationale !== 'string' || !p.rationale.trim() || !s.intake[p.vendor_id]?.normalized) continue;
          const q = s.qualification[p.vendor_id] || (s.qualification[p.vendor_id] = { status: 'not_reviewed', history: [], responseVersion: 1 });
          q.proposal = { status: p.status, rationale: p.rationale.trim().slice(0, 1200), stagedAt: new Date().toISOString(), responseVersion: q.responseVersion };
          staged.push({ vendor_id: p.vendor_id, status: p.status, rationale: q.proposal.rationale });
        }
      });
      return { staged, note: 'These are suggestions only. No buyer outcome was changed; the buyer must review and record each outcome in the UI.' };
    },
    record_outcomes: ({ outcomes }) => {
      const explicit = /(?:\b(?:mark|record|set|change|update|clear|qualify|reject|move|put|make)\b|\b(?:status|outcome)\b.{0,25}\b(?:to|as)\b)/i.test(buyerText) || (!buyerText.includes('?') && /\b(?:I want|we want|should be|needs to be|please)\b.{0,100}\b(?:technically cleared|not cleared|needs clarification|in review|not reviewed)\b/i.test(buyerText));
      const pending = store.get().analystPendingOutcome;
      const samePending = pending && Array.isArray(outcomes) && outcomes.length === pending.length && outcomes.every(o => pending.some(p => p.vendor_id === o.vendor_id && p.status === o.status && p.expected_response_version === o.expected_response_version));
      if (!explicit && !samePending) return { error: 'No explicit buyer instruction to change a status. Answer as advice only.' };
      if (!Array.isArray(outcomes) || !outcomes.length || outcomes.length > 20) return { error: 'Provide one to twenty outcomes.' };
      const s = store.get(), ids = new Set(), edits = [];
      const buyerMessages = [...(s.analyst.messages || []).filter(m => m.role === 'user').map(m => String(m.content || '')), buyerText];
      for (const o of outcomes) {
        if (!o || ids.has(o.vendor_id)) return { error: 'Duplicate or invalid vendor in outcome batch.' };
        ids.add(o.vendor_id);
        const intake = s.intake[o.vendor_id], q = s.qualification[o.vendor_id] || { responseVersion: 1 };
        if (!intake?.normalized) return { error: `Response unavailable for ${o.vendor_id}.` };
        if (q.responseVersion !== o.expected_response_version) return { error: `Response changed for ${intake.vendorName}; refresh its review state.` };
        const gaps = qualificationGapCount(intake, s.rfx, q);
        const excerpt = String(o.buyer_reason_excerpt || '').trim();
        if (o.status === 'technically_cleared' && gaps > 0 && (!excerpt || !buyerMessages.some(m => m.toLowerCase().includes(excerpt.toLowerCase())))) {
          if (explicit) store.update(st => { st.analystPendingOutcome = outcomes.map(x => ({ vendor_id: x.vendor_id, status: x.status, rationale: x.rationale, expected_response_version: x.expected_response_version })); });
          return { error: `Ask the buyer for their reason to clear ${intake.vendorName} despite unresolved evidence gaps. Their next natural-language reply can complete the pending instruction.` };
        }
        const reason = gaps && o.status === 'technically_cleared' ? excerpt : '';
        const error = validateQualificationTransition({ status: o.status, rationale: o.rationale, overrideReason: reason, gapCount: gaps, awardStatus: s.award?.status });
        if (error) return { error: `${intake.vendorName}: ${error}` };
        edits.push({ vendorId: o.vendor_id, status: o.status, rationale: o.rationale, overrideReason: reason });
      }
      const recorded = [];
      store.update(st => { for (const edit of edits) recorded.push(applyQualificationTransition(st, edit.vendorId, { ...edit, actor: 'buyer via analyst' })); st.analystPendingOutcome = null; });
      return { recorded, note: 'Buyer-directed technical outcomes recorded. Formal award still requires buyer confirmation.' };
    },
  };
}

export async function runAnalystTurn({ store, settings }, userText) {
  const s = store.get();
  const messages = [...s.analyst.messages, { role: 'user', content: userText }];
  const { text, messages: full } = await runToolLoop(settings, {
    system: ANALYST_SYSTEM,
    messages,
    tools: analystTools(),
    executors: analystExecutors(store, userText),
  });
  store.update(st => { st.analyst.messages = apiTranscript(full); });
  return text;
}

// Intake orchestration: route file -> extract (LLM) -> normalize -> store.
// Lives here (not in extractors.js) because it touches the store but not the DOM.
import { EXTRACT_SYSTEM, extractPrompt, callLLM, userMessage } from './intake/llm.js';
import { normalizeIntake } from './intake/normalize.js';
import { VENDORS } from './config.js';

// Vendor identity comes from the submitted material, not the upload slot.
// Returns the display name plus whether the buyer must confirm it:
//  - exact (normalized) match with the slot -> use the extracted spelling, no check
//  - conflict or unclear/empty -> use the extracted name if there is one
//    (slot name as fallback) and raise a buyer check.
export function resolveVendorName(slotName, extractedName) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ex = (extractedName || '').trim();
  if (!ex) return { name: slotName, needsCheck: true, reason: 'unclear' };
  if (norm(ex) === norm(slotName)) return { name: ex, needsCheck: false, reason: 'match' };
  return { name: ex, needsCheck: true, reason: 'conflict' };
}

// The extraction prompt asks the model for meta.vendor_name; older saved
// extractions may carry a top-level vendor_name instead. Read the
// prompt-shaped field first, fall back to the older shape — the printed name
// must never be silently dropped because the reader looked in the wrong place.
export function extractedVendorName(extracted) {
  const ex = extracted || {};
  const meta = ex.meta || {};
  const fromPrompt = typeof meta.vendor_name === 'string' ? meta.vendor_name : '';
  const fromLegacy = typeof ex.vendor_name === 'string' ? ex.vendor_name : '';
  return (fromPrompt || fromLegacy).trim();
}

// Resolve the display name for an ingested response and build the buyer
// confirmation when one is needed. Pure — the exact logic runIntake applies
// to every extraction, testable without an LLM call.
export function resolveExtractedName(vendorId, slotName, extracted) {
  const printed = extractedVendorName(extracted);
  const resolved = resolveVendorName(slotName, printed);
  let confirmation = null;
  if (resolved.needsCheck) {
    confirmation = {
      id: `${vendorId}-name`,
      kind: 'vendor_name',
      vendorId,
      status: 'pending',
      title: resolved.reason === 'conflict'
        ? `Confirm vendor name: “${resolved.name}”?`
        : 'Vendor name unclear — confirm the display name',
      detail: resolved.reason === 'conflict'
        ? `The file was loaded into the “${slotName}” slot, but the material names the vendor “${resolved.name}”.`
        : 'The submitted material has no readable vendor name.',
      evidence: { slot: slotName, extracted: printed || null },
    };
  }
  return { ...resolved, confirmation };
}

export async function runIntake({ store, catalog, settings }, vendorId, routed, bundle = {}) {
  const vendor = VENDORS.find(v => v.id === vendorId);
  const rfx = store.get().rfx;
  if (!rfx) throw new Error('publish the RFx before running intake');
  if (store.get().award?.status === 'awarded') return { ok: false, error: 'This RFx has been awarded; response changes are locked.' };
  const currentIntake = store.get().intake[vendorId] || null;
  const previous = currentIntake?.previousIntake || currentIntake;
  store.update(s => { s.intake[vendorId] = { ...(previous || {}), status: 'reading', vendorId, vendorName: previous?.vendorName || vendor.name, previousStatus: previous?.status || null }; });

  try {
    const hint = rfx.lines.slice(0, 8).map(l => l.official_part_number || l.catalog_ref).join(', ') + ', …';
    const msg = routed.kind === 'image'
      ? userMessage(extractPrompt(vendor.name, hint), routed.dataUrl)
      : userMessage(extractPrompt(vendor.name, hint) + '\n\n--- QUOTATION TEXT ---\n' + routed.text);

    const { text, finishReason } = await callLLM(settings, {
      system: EXTRACT_SYSTEM, messages: [msg], json: true,
      maxTokens: 8000, reasoningEffort: 'low',
    });
    if (finishReason === 'length') throw new Error('extraction hit the token limit — retry with a larger budget');

    const extracted = JSON.parse(text);
    if (!Array.isArray(extracted.lines)) throw new Error('extraction returned no lines');

    // The name on the material wins over the upload slot it was loaded into.
    // A conflict — or no readable name at all — becomes a buyer check so a
    // fixed demo name never silently replaces what the vendor printed.
    const { confirmation: nameConfirmation, ...resolved } =
      resolveExtractedName(vendorId, vendor.name, extracted);
    const normalized = normalizeIntake({ rfx, extracted, vendorId, vendorName: resolved.name, settings });

    store.update(s => {
      // A replacement is a new review revision. Drop stale checks and collect
      // the new response's checks, while preserving the prior qualification in history.
      s.confirmations = s.confirmations.filter(c => c.vendorId !== vendorId);
      s.intake[vendorId] = {
        status: normalized.confirmations.length || resolved.needsCheck ? 'needs_review' : 'ready',
        vendorId, vendorName: resolved.name, extracted, normalized,
        flags: normalized.flags,
        // Evidence carried together: quote + questionnaire + supporting files.
        answers: bundle.answers || {},
        files: bundle.files || [],
      };
      for (const c of normalized.confirmations) {
        if (!s.confirmations.some(x => x.id === c.id)) s.confirmations.push(c);
      }
      if (nameConfirmation) {
        // A re-read replaces any earlier name check for this vendor.
        s.confirmations = s.confirmations.filter(x => x.id !== nameConfirmation.id);
        s.confirmations.push(nameConfirmation);
      }
      const prior = s.qualification[vendorId];
      const history = [...(prior?.history || [])];
      if (prior && prior.status && prior.status !== 'not_reviewed') history.push({ ...prior, invalidatedAt: new Date().toISOString(), reason: 'Response replaced; prior outcome requires buyer review.' });
      s.qualification[vendorId] = { status: 'not_reviewed', rationale: '', history, responseVersion: (prior?.responseVersion || 0) + 1, evidenceReview: null, proposal: null };
      if (s.award?.status === 'proposed') s.award = null;
    });
    const needsReview = normalized.confirmations.length > 0 || resolved.needsCheck;
    return { ok: true, status: needsReview ? 'needs_review' : 'ready' };
  } catch (e) {
    store.update(s => { s.intake[vendorId] = previous || { status: 'failed', vendorId, vendorName: vendor.name, error: String(e.message || e) }; if (previous) s.intake[vendorId].lastReplacementError = String(e.message || e); });
    return { ok: false, error: String(e.message || e) };
  }
}

// One structured, read-only model pass per current response revision. Buyer outcomes
// remain a separate manual form and cannot be changed by the model.
export async function runEvidenceReview({ store, settings }, vendorId) {
  const s = store.get(), intake = s.intake[vendorId], version = s.qualification[vendorId]?.responseVersion || 1;
  if (!intake?.normalized || !s.rfx) throw new Error('Load a response before reviewing its evidence.');
  store.update(st => { const q = st.qualification[vendorId] || (st.qualification[vendorId] = { status: 'not_reviewed', history: [], responseVersion: version }); q.reviewState = 'loading'; q.reviewError = null; });
  try {
    const matched = matchedAnswerSet(intake.answers, s.rfx.questions);
    const payload = {
      task: 'Identify only specific potential deviations in stored answers or explicit conflicts with published terms. Do not decide qualification. Return no finding when evidence is insufficient. Quote exact response wording in evidence_excerpt.',
      questions: matched.matched.map(x => ({ id: x.question.id, requirement: x.question.text, answer: x.answer })),
      missing_question_ids: matched.missing.map(q => q.id),
      terms: (s.rfx.terms || []).filter(t => !t.omitted).map(t => ({ id: t.id, text: t.sentence || t.text || t.title })),
      response_terms: [intake.extracted?.meta?.payment_terms, intake.extracted?.meta?.delivery_terms].filter(Boolean),
      output_schema: { schema_version: 1, findings: [{ kind: 'answer_deficiency|answer_conflict|term_conflict', question_id: 'active question id for answer_deficiency or answer_conflict', term_id: 'published id for term_conflict', summary: 'short issue', reason: 'why it may matter', evidence_excerpt: 'verbatim substring from stored response' }] },
    };
    const { callLLM } = await import('./intake/llm.js');
    const result = await callLLM(settings, { system: 'You assist a buyer by checking stored response evidence. Never decide qualification or award. Do not invent evidence, terms, answers, or IDs. Output JSON only.', messages: [{ role: 'user', content: JSON.stringify(payload) }], json: true, maxTokens: 3000, reasoningEffort: 'low' });
    const validated = validateEvidenceReview(JSON.parse(result.text), intake, s.rfx);
    store.update(st => {
      const q = st.qualification[vendorId];
      if (q.responseVersion !== version) throw new Error('Response changed during review; rerun against the current response.');
      q.evidenceReview = validated; q.reviewState = 'complete';
      const det = deterministicEvidence(st.intake[vendorId], st.rfx);
      const gapCount = det.missingLines.length + det.missingQuestions.length + validated.findings.length;
      const hasNewFindings = validated.findings.length > 0 && q.status === 'technically_cleared';
      q.unresolvedGapCount = gapCount;
      if (hasNewFindings) {
        q.history = [...(q.history || []), { status: q.status, rationale: q.rationale, updatedAt: q.updatedAt, reason: 'New evidence findings arrived after clearance; buyer reaffirmation is required.' }];
        q.status = 'not_reviewed'; q.rationale = ''; q.overrideReason = '';
        if (st.award?.status === 'proposed') st.award = null;
      }
    });
    return validated;
  } catch (err) {
    store.update(st => { const q = st.qualification[vendorId]; if (q) { q.reviewState = 'error'; q.reviewError = String(err.message || err); if (q.status === 'technically_cleared') { q.history = [...(q.history || []), { status: q.status, rationale: q.rationale, updatedAt: q.updatedAt, reason: 'Evidence review failed after clearance; buyer reaffirmation is required.' }]; q.status = 'not_reviewed'; q.rationale = ''; q.overrideReason = ''; if (st.award?.status === 'proposed') st.award = null; } } });
    throw err;
  }
}
