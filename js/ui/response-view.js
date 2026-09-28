// Small pure helpers for response-review display states. Kept separate from
// the DOM renderer so status, evidence, and conversion disclosure can be
// checked without a browser or model call.
const ROUTINE_CONVERSION_FLAGS = new Set(['basis', 'gst', 'fx']);

export function deriveVendorReviewStatus(intake, confirmations) {
  if (!intake) return 'waiting';
  if (intake.status === 'reading' || intake.status === 'failed') return intake.status;
  return confirmations.some(c => c.vendorId === intake.vendorId && c.status === 'pending')
    ? 'needs_review' : 'ready';
}

export function isActionablePriceFlag(flag) {
  return !ROUTINE_CONVERSION_FLAGS.has(flag?.kind);
}

export function responseEvidenceGaps(intake, rfx) {
  if (!intake?.normalized) return [];
  const gaps = [];
  const questions = (rfx?.questions || []).filter(q => !q.omitted);
  const answers = intake.answers || {};
  const hasQuestionnaire = (intake.files || []).some(f => f.kind === 'questionnaire');
  const questionIds = new Set(questions.map(q => String(q.id)));
  const matched = Object.entries(answers).filter(([id, value]) => questionIds.has(String(id)) && value != null && String(value).trim());
  const answered = matched.length;
  const answeredIds = new Set(matched.map(([id]) => String(id)));
  const missingQuestionIds = questions.filter(q => !answeredIds.has(String(q.id))).map(q => q.id);
  if (!hasQuestionnaire) gaps.push({ kind: 'questionnaire_missing', detail: 'Questionnaire file missing' });
  else if (!answered) gaps.push({ kind: 'questionnaire_empty', detail: `Empty questionnaire · 0/${questions.length} answered` });
  else if (missingQuestionIds.length) gaps.push({ kind: 'questionnaire_incomplete', detail: `${missingQuestionIds.length} questionnaire answers missing (${answered}/${questions.length} answered)`, questionIds: missingQuestionIds });
  const unquoted = (intake.normalized.lines || []).filter(l => l.matched === 'missing').map(l => l.rfx_sl);
  if (unquoted.length) gaps.push({ kind: 'unquoted_lines', lineNumbers: unquoted });
  const unreadable = (intake.normalized.lines || []).filter(l => (l.flags || []).some(f => f.kind === 'unreadable_price')).map(l => l.rfx_sl);
  if (unreadable.length) gaps.push({ kind: 'unreadable_prices', lineNumbers: unreadable });
  return gaps;
}

export function comparableCalculation(line, settings) {
  let value = Number(line.quoted_price);
  if (!Number.isFinite(value)) return 'Quoted price could not be calculated.';
  const parts = [`${value.toLocaleString('en-IN')} ${line.quoted_currency || 'INR'}`];
  for (const step of line.normalization_steps || []) {
    if (step.startsWith('USD→INR')) {
      const rate = Number(settings.usdInr);
      value *= rate;
      parts.push(`× ${rate} FX rate = ₹${value.toLocaleString('en-IN', { maximumFractionDigits: 4 })}`);
    } else if (step.startsWith('÷100')) {
      value /= 100;
      parts.push(`÷ 100 boxes = ₹${value.toLocaleString('en-IN', { maximumFractionDigits: 4 })}`);
    } else if (step.startsWith('+')) {
      const rate = Number(settings.gstRate);
      value *= 1 + rate;
      parts.push(`× ${(1 + rate).toFixed(2)} incl. GST = ₹${value.toLocaleString('en-IN', { maximumFractionDigits: 4 })}`);
    }
  }
  return `${parts.join(' ')}. Comparable price: ₹${Number(line.normalized_inr_incl_gst).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} per unit.`;
}

export function conversionRuleText(normalized, settings) {
  const priced = (normalized.lines || []).filter(l => l.quoted_price != null && l.normalized_inr_incl_gst != null);
  const signatures = new Set(priced.map(l => (l.normalization_steps || []).join('|') || 'none'));
  if (signatures.size > 1) return 'Conversion rules vary by line. Open the info control beside an affected price for its calculation.';
  if (!priced.length) return '';
  const steps = new Set(priced.flatMap(l => l.normalization_steps || []));
  const rules = [];
  const perHundred = [...steps].some(step => step.startsWith('÷100'));
  const gst = [...steps].find(step => step.startsWith('+'));
  const fx = [...steps].find(step => step.startsWith('USD→INR'));
  if (perHundred) rules.push('Vendor quotes prices per 100 boxes; comparable per-box prices are derived by dividing the quoted price by 100.');
  if (gst) rules.push(`Vendor quotes prices excluding GST; comparable prices include ${Math.round(Number(settings.gstRate) * 100)}% GST.`);
  if (fx) {
    const currency = priced.find(l => /USD|\$/i.test(l.quoted_currency || ''))?.quoted_currency || 'USD';
    rules.push(`Vendor quotes prices in ${currency}; comparable prices are converted to INR at ₹${settings.usdInr} per ${currency}${settings.usdInrAsOf ? ` (rate dated ${settings.usdInrAsOf})` : ''}.`);
  }
  return rules.length ? rules.join(' ') : 'No currency, basis, or GST adjustment is applied to this vendor’s quoted prices.';
}
