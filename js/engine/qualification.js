// Buyer-owned technical review and award arithmetic. DOM-free and deterministic.
import { lineValue } from './intake/normalize.js';

export const QUALIFICATION_STATUSES = ['not_reviewed', 'in_review', 'needs_clarification', 'technically_cleared', 'not_cleared'];

export function qualificationGapCount(intake, rfx, q = {}) {
  const d = deterministicEvidence(intake, rfx);
  return d.missingLines.length + d.missingQuestions.length + (q.evidenceReview?.findings?.length || 0) + (q.reviewState === 'complete' ? 0 : 1);
}

export function validateQualificationTransition({ status, rationale, overrideReason = '', gapCount = 0, awardStatus }) {
  if (awardStatus === 'awarded') return 'This RFx has already been awarded.';
  if (!QUALIFICATION_STATUSES.includes(status)) return 'Choose a valid buyer review status.';
  if (typeof rationale !== 'string' || !rationale.trim()) return 'A buyer rationale is required.';
  if (status === 'technically_cleared' && gapCount > 0 && !String(overrideReason).trim()) return 'Clearing with unresolved evidence requires a buyer-provided reason.';
  return null;
}

export function applyQualificationTransition(state, vendorId, { status, rationale, overrideReason = '', actor = 'buyer via review form' }) {
  const intake = state.intake[vendorId];
  if (!intake?.normalized) return { ok: false, error: 'That vendor response is not loaded.' };
  const prev = state.qualification[vendorId] || { status: 'not_reviewed', history: [], responseVersion: 1 };
  const gapCount = qualificationGapCount(intake, state.rfx, prev);
  const error = validateQualificationTransition({ status, rationale, overrideReason, gapCount, awardStatus: state.award?.status });
  if (error) return { ok: false, error };
  const history = [...(prev.history || [])];
  if (prev.status && prev.status !== 'not_reviewed') history.push({ status: prev.status, rationale: prev.rationale, actor: prev.actor || 'buyer', updatedAt: prev.updatedAt, reason: `Updated by ${actor}.` });
  state.qualification[vendorId] = { ...prev, status, rationale: rationale.trim().slice(0, 1200), overrideReason: status === 'technically_cleared' && gapCount ? overrideReason.trim().slice(0, 1200) : '', unresolvedGapCount: gapCount, history, proposal: null, actor, updatedAt: new Date().toISOString() };
  if (state.award?.status === 'proposed') state.award = null;
  return { ok: true, vendor: intake.vendorName, status, gapCount };
}

export function migrateV6ReviewState(saved) {
  if (!saved) return saved;
  const qualification = {};
  for (const [id, old] of Object.entries(saved.qualification || {})) {
    const status = old.status === 'pending' ? 'not_reviewed' : QUALIFICATION_STATUSES.includes(old.status) ? old.status : 'not_reviewed';
    qualification[id] = { ...old, status, rationale: status === 'not_reviewed' ? '' : (old.rationale || ''),
      history: Array.isArray(old.history) ? old.history : [],
      responseVersion: old.responseVersion || (saved.intake?.[id]?.normalized ? 1 : 0),
      evidenceReview: old.evidenceReview || null, reviewState: old.reviewState === 'loading' ? null : old.reviewState };
  }
  for (const q of Object.values(qualification)) {
    if (q.status === 'technically_cleared' && q.reviewState !== 'complete') {
      q.history = [...q.history, { status: q.status, rationale: q.rationale, updatedAt: q.updatedAt, reason: 'Evidence review is not complete; buyer must reaffirm clearance.' }];
      q.status = 'not_reviewed'; q.rationale = ''; q.overrideReason = '';
    }
  }
  return { ...saved, version: 2, qualification, award: saved.award || null, completed: saved.completed || [] };
}

export function matchedAnswerSet(answers = {}, questions = []) {
  const active = (questions || []).filter(q => !q.omitted);
  const byId = new Map(active.map(q => [String(q.id), q]));
  const matched = [];
  for (const [key, value] of Object.entries(answers || {})) {
    const q = byId.get(String(key));
    if (q && value != null && String(value).trim()) matched.push({ question: q, answer: String(value).trim() });
  }
  const answered = new Set(matched.map(x => String(x.question.id)));
  return { matched, count: matched.length, total: active.length,
    missing: active.filter(q => !answered.has(String(q.id))), unmatchedKeys: Object.keys(answers || {}).filter(k => !byId.has(String(k))) };
}

export function deterministicEvidence(intake, rfx) {
  const q = matchedAnswerSet(intake?.answers, rfx?.questions);
  return {
    answerCount: q.count, answerTotal: q.total, missingQuestions: q.missing,
    missingLines: (intake?.normalized?.lines || []).filter(l => l.matched === 'missing')
      .map(l => ({ sl: l.rfx_sl, part: l.rfx_part, description: l.rfx_description })),
    unmatchedAnswerKeys: q.unmatchedKeys,
  };
}

export function validateEvidenceReview(value, intake, rfx) {
  if (!value || value.schema_version !== 1 || !Array.isArray(value.findings)) throw new Error('The review response did not match the required evidence format.');
  const questions = new Map((rfx?.questions || []).filter(q => !q.omitted).map(q => [String(q.id), q]));
  const terms = new Map((rfx?.terms || []).filter(t => !t.omitted).map(t => [String(t.id), t]));
  const nonemptyAnswers = new Map(Object.entries(intake?.answers || {}).filter(([id, a]) => questions.has(String(id)) && a != null && String(a).trim()).map(([id, a]) => [String(id), String(a)]));
  const findings = value.findings.map(f => {
    if (!f || !['answer_issue', 'answer_deficiency', 'answer_conflict', 'term_conflict'].includes(f.kind) || typeof f.summary !== 'string' || !f.summary.trim() || typeof f.reason !== 'string' || !f.reason.trim()) throw new Error('The review returned an incomplete finding.');
    if (['answer_issue', 'answer_deficiency', 'answer_conflict'].includes(f.kind)) {
      const id = String(f.question_id || ''), answer = nonemptyAnswers.get(id);
      if (!answer || typeof f.evidence_excerpt !== 'string' || !f.evidence_excerpt.trim() || !answer.includes(f.evidence_excerpt)) throw new Error('The review cited an answer that is not present in the stored questionnaire.');
      return { kind: f.kind === 'answer_conflict' ? 'answer_conflict' : 'answer_deficiency', question_id: id, summary: f.summary.trim(), reason: f.reason.trim(), evidence_excerpt: f.evidence_excerpt };
    }
    const id = String(f.term_id || '');
    if (!terms.has(id) || typeof f.evidence_excerpt !== 'string' || !f.evidence_excerpt.trim()) throw new Error('The review cited a term that is not in the published RFx.');
    const stored = [...nonemptyAnswers.values(), intake?.extracted?.meta?.payment_terms, intake?.extracted?.meta?.delivery_terms].filter(Boolean).join('\n');
    if (!stored.includes(f.evidence_excerpt)) throw new Error('The review cited wording that is not present in the stored response.');
    return { kind: f.kind, term_id: id, summary: f.summary.trim(), reason: f.reason.trim(), evidence_excerpt: f.evidence_excerpt };
  });
  return { schema_version: 1, findings, reviewedAt: new Date().toISOString() };
}

export function buildAwardProposal(rfx, intakes, qualifications, priorAssignments = {}, confirmations = [], includedVendorIds = []) {
  const cleared = intakes.filter(v => qualifications[v.vendorId]?.status === 'technically_cleared' && includedVendorIds.includes(v.vendorId));
  const assignments = {};
  const pendingChecks = [];
  for (const line of rfx.lines || []) {
    const candidates = cleared.map(v => {
      const q = v.normalized?.lines?.find(x => x.rfx_sl === line.sl);
      const unit = q?.normalized_inr_incl_gst;
      const price = (q?.matched === 'exact' || q?.match_confirmed) && Number.isFinite(unit) && unit >= 0 ? lineValue(q) : null;
      return price == null ? null : { vendorId: v.vendorId, vendorName: v.vendorName, price, line: q };
    }).filter(Boolean).sort((a, b) => a.price - b.price);
    const prior = candidates.find(x => x.vendorId === priorAssignments[line.sl]);
    const chosen = prior || candidates[0];
    const hasPendingMaterial = chosen && confirmations.some(c => c.status === 'pending' && c.vendorId === chosen.vendorId && Number(c.evidence?.rfx_sl) === Number(line.sl));
    if (hasPendingMaterial) pendingChecks.push(line.sl);
    assignments[line.sl] = { vendorId: chosen?.vendorId || null, price: chosen?.price ?? null, candidates: candidates.map(c => ({ vendorId: c.vendorId, vendorName: c.vendorName, price: c.price })) };
  }
  const complete = Object.values(assignments).every(a => a.vendorId);
  const reviewPendingVendorIds = cleared.filter(v => qualifications[v.vendorId]?.reviewState !== 'complete' && !qualifications[v.vendorId]?.overrideReason?.trim()).map(v => v.vendorId);
  const totals = {};
  for (const [sl, a] of Object.entries(assignments)) if (a.vendorId) totals[a.vendorId] = (totals[a.vendorId] || 0) + a.price;
  const zeroAssignmentVendorIds = cleared.map(v => v.vendorId).filter(id => !totals[id]);
  return { assignments, totals, clearedVendorIds: cleared.map(v => v.vendorId), complete, reviewPendingVendorIds, zeroAssignmentVendorIds,
    pendingChecks, includedVendorIds: cleared.map(v => v.vendorId), canAward: complete && pendingChecks.length === 0 && reviewPendingVendorIds.length === 0 && zeroAssignmentVendorIds.length === 0 && cleared.every(v => {
      const q = qualifications[v.vendorId]; return !((q.unresolvedGapCount || 0) && !q.overrideReason?.trim());
    }) };
}
