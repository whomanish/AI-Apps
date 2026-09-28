// Deterministic RFx composer. DOM-free.
// The drafter proposes; the buyer decides; THIS module assembles the document.
// No LLM output ever lands in the RFx except through explicit buyer-confirmed edits.
//
// Questions and terms are PROGRESSIVE: a fresh RFx contains zero of either.
// They enter the draft with review status, and publishing requires approved
// coverage of five categories — never a blind item-by-item approval flow.
//
// Item shape (questions and terms):
//   { id, text, source_text, status: 'needs-review'|'reviewed',
//     origin: 'library'|'adapted'|'buyer', coverage: [...],
//     conditional: null|{kind,note}, omitted: bool }

let seq = 0;

// Publish-gate coverage categories (human labels for the gate messages).
export const COVERAGE_LABELS = {
  'submission': 'submission channel',
  'price-basis': 'price basis',
  'delivery': 'delivery',
  'payment': 'payment terms',
  'technical-compliance': 'line-wise technical compliance',
};
const COVERAGE_ORDER = ['submission', 'price-basis', 'delivery', 'payment', 'technical-compliance'];

export function composeRfx({ catalog, header = {}, lines = [] }) {
  seq += 1;
  const now = new Date().toISOString();
  return {
    id: `rfx-draft-${String(seq).padStart(3, '0')}`,
    title: header.title || 'Tender Enquiry — Corrugated Boxes / Carton Boxes',
    header: { ...catalog.headerDefaults(), ...header },
    lines: lines.map((l, i) => normalizeLine(l, i + 1)),
    // Progressive: zero included questions and terms at creation. The source
    // library is available via the catalog, but it is not part of this RFx
    // until the buyer agrees (questions) or reviews (terms) it in.
    questions: [],
    terms: [],
    status: 'draft',
    createdAt: now,
    history: [{ at: now, kind: 'composed', detail: `${lines.length} lines composed from catalog + buyer edits` }],
  };
}

export function normalizeLine(l, sl) {
  return {
    sl,
    catalog_ref: l.catalog_ref,
    // Nullable: the six KGF 7-ply items have no official part number in the source NIT.
    official_part_number: l.official_part_number ?? null,
    description: l.description,
    quantity_nos: l.quantity_nos,
    delivery_location: l.delivery_location || null,
    delivery_schedule: l.delivery_schedule || null,
    spec_note: l.spec_note || l.note || null,
    buyer_edited: !!l.buyer_edited,
  };
}

// What the buyer sees in the part-number column.
export function displayPartNumber(line) {
  return line.official_part_number || line.catalog_ref || '—';
}

export function partNumberMissing(line) {
  return !line.official_part_number;
}

// ---- distribution channel + publish identity -------------------------------
// Every published RFx gets a unique internal ID, independent of the
// distribution channel. A GeM bid number is generated ONLY for GeM-channel
// RFx — a Non-GeM publish carries no GeM wording and no GeM number.

const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newRfxInternalId(at = new Date()) {
  const d = at.toISOString().slice(0, 10).replaceAll('-', '');
  let s = '';
  for (let i = 0; i < 4; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return `RFQ-${d}-${s}`;
}

// Canonical channel from the header field the drafter records
// (set_header distribution_channel = 'GeM' or 'Non-GeM').
export function distributionChannel(header = {}) {
  const v = String(header.distribution_channel || '').toLowerCase();
  if (/\bnon[\s_-]*gem\b/.test(v) || /\bmanual\b/.test(v)) return 'non-gem';
  if (/\bgem\b/.test(v)) return 'gem';
  return 'unknown';
}

// Effective channel: the recorded header value wins; otherwise infer from the
// live submission terms (the GeM-only clause vs the manual clause), so drafts
// saved before the channel field existed keep working. Unknown when neither
// is present — publishing then blocks until the buyer confirms the channel.
export function effectiveChannel(rfx) {
  const fromHeader = distributionChannel(rfx.header);
  if (fromHeader !== 'unknown') return fromHeader;
  const live = liveItems(rfx.terms).map(t => t.id);
  const hasGem = live.includes('submission');
  const hasManual = live.includes('submission_manual');
  if (hasGem && !hasManual) return 'gem';
  if (hasManual && !hasGem) return 'non-gem';
  return 'unknown';
}

// ---- progressive questions & terms ----------------------------------------

export function makeQuestion({ id, question, coverage = [], origin = 'library', status = 'needs-review' }) {
  return { id, text: question, source_text: question, status, origin,
           coverage: [...coverage], conditional: null, omitted: false };
}

export function makeTerm({ id, text, source_text, coverage = [], conditional = null,
                           origin = 'library', status = 'needs-review' }) {
  return { id, text, source_text: source_text ?? text, status, origin,
           coverage: [...coverage],
           conditional: conditional ? { ...conditional } : null, omitted: false };
}

// Group line serials by delivery location, e.g. [{ location, sls:[1,3..26], range:'1, 3–26' }].
export function deliveryLocationGroups(lines) {
  const order = [];
  const byLoc = new Map();
  for (const l of lines) {
    const loc = l.delivery_location || 'Not set';
    if (!byLoc.has(loc)) { byLoc.set(loc, []); order.push(loc); }
    byLoc.get(loc).push(l.sl);
  }
  return order.map(loc => ({ location: loc, sls: byLoc.get(loc), range: compactRanges(byLoc.get(loc)) }));
}

function compactRanges(sls) {
  const out = [];
  let start = null, prev = null;
  const flush = () => { out.push(start === prev ? `${start}` : (prev === start + 1 ? `${start}, ${prev}` : `${start}–${prev}`)); };
  for (const s of [...sls].sort((a, b) => a - b)) {
    if (start == null) { start = prev = s; continue; }
    if (s === prev + 1) { prev = s; continue; }
    flush(); start = prev = s;
  }
  if (start != null) flush();
  return out.join(', ');
}

// Resolve [DELIVERY_LOCATION] / [DELIVERY_SCHEDULE] from the draft's own lines.
// Returns { text, unresolved: [...] }. Unresolvable slots stay literal so the
// placeholder scan can block publishing — the co-pilot must ask for the fact.
export function resolveTermSlots(sentence, lines) {
  const locs = [...new Set((lines || []).map(l => l.delivery_location).filter(Boolean))];
  const schs = [...new Set((lines || []).map(l => l.delivery_schedule).filter(Boolean))];
  let text = sentence;
  const unresolved = [];
  const locFill = locs.length ? joinList(locs) : null;
  const schFill = schs.length ? joinList(schs) : null;
  if (locFill) text = text.split('[DELIVERY_LOCATION]').join(locFill);
  else if (text.includes('[DELIVERY_LOCATION]')) unresolved.push('DELIVERY_LOCATION');
  if (schFill) text = text.split('[DELIVERY_SCHEDULE]').join(schFill);
  else if (text.includes('[DELIVERY_SCHEDULE]')) unresolved.push('DELIVERY_SCHEDULE');
  return { text, unresolved };
}

function joinList(xs) {
  if (xs.length === 1) return xs[0];
  return xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
}

// Scan rendered question/term text for leftover [PLACEHOLDERS]. Empty = clean.
export function findPlaceholders(rfx) {
  const hits = [];
  const re = /\[([A-Z][A-Z_0-9]*)\]/g;
  for (const t of (rfx.terms || []).filter(t => !t.omitted)) {
    let m; re.lastIndex = 0;
    while ((m = re.exec(t.text || ''))) hits.push({ kind: 'term', id: t.id, token: m[1] });
  }
  for (const q of (rfx.questions || []).filter(q => !q.omitted)) {
    let m; re.lastIndex = 0;
    while ((m = re.exec(q.text || ''))) hits.push({ kind: 'question', id: q.id, token: m[1] });
  }
  return hits;
}

const liveItems = items => (items || []).filter(i => !i.omitted);

// Approved coverage: every category needs at least one reviewed, live item.
// Returns the missing category ids, in gate order.
export function coverageCheck(rfx) {
  const covered = new Set();
  for (const t of liveItems(rfx.terms)) {
    if (t.status === 'reviewed') for (const c of (t.coverage || [])) covered.add(c);
  }
  for (const q of liveItems(rfx.questions)) {
    if (q.status === 'reviewed') for (const c of (q.coverage || [])) covered.add(c);
  }
  return COVERAGE_ORDER.filter(c => !covered.has(c));
}

// Required-field + review + coverage + placeholder check before publishing.
// Returns human-readable descriptions of what is missing; empty = publishable.
// Publishing must never turn missing required content into a seemingly complete tender.
export function validateForPublish(rfx) {
  const missing = [];
  if (!rfx.title || !String(rfx.title).trim()) missing.push('RFx title');
  const h = rfx.header || {};
  if (!h.buying_unit) missing.push('Buying unit (which division is buying)');
  if (!h.bid_due_datetime) missing.push('Bid due date/time');
  if (effectiveChannel(rfx) === 'unknown') {
    missing.push('Distribution channel (GeM or Non-GeM) — confirm how vendors will submit');
  }
  const noLoc = (rfx.lines || []).filter(l => !l.delivery_location).map(l => l.sl);
  if (noLoc.length) missing.push(`Delivery location on line${noLoc.length > 1 ? 's' : ''} ${noLoc.join(', ')}`);
  const noQty = (rfx.lines || []).filter(l => !(l.quantity_nos > 0)).map(l => l.sl);
  if (noQty.length) missing.push(`Quantity on line${noQty.length > 1 ? 's' : ''} ${noQty.join(', ')}`);
  if (!(rfx.lines || []).length) missing.push('At least one line item');

  // Review gate: nothing may publish unreviewed, and required coverage must hold.
  const pendingQ = liveItems(rfx.questions).filter(q => q.status !== 'reviewed').length;
  const pendingT = liveItems(rfx.terms).filter(t => t.status !== 'reviewed').length;
  if (pendingQ) missing.push(`${pendingQ} questionnaire item${pendingQ > 1 ? 's' : ''} still need${pendingQ > 1 ? '' : 's'} your review`);
  if (pendingT) missing.push(`${pendingT} commercial term${pendingT > 1 ? 's' : ''} still need${pendingT > 1 ? '' : 's'} your review`);
  const covMissing = coverageCheck(rfx);
  if (covMissing.length) {
    const labels = covMissing.map(c => COVERAGE_LABELS[c] || c).join(', ');
    missing.push(`Approved coverage missing for: ${labels}`);
  }
  if (!liveItems(rfx.terms).length && !h.no_commercial_terms_confirmed) {
    missing.push('No commercial terms included — record an explicit buyer decision to issue the RFx without terms');
  }
  const ph = findPlaceholders(rfx);
  if (ph.length) {
    const seen = [...new Set(ph.map(p => `[${p.token}] in ${p.kind} '${p.id}'`))];
    missing.push(`Unresolved placeholders: ${seen.join('; ')}`);
  }
  return missing;
}

// ---- edits ----------------------------------------------------------------
// Buyer edits. Each returns { rfx, edit } where edit is recorded in history.
// Edits: setQty, setLineFields, addLine, splitLine, removeLine, setHeader,
//        addQuestion, addCustomQuestion, editQuestion, omitQuestion, restoreQuestion,
//        addTerm, editTerm, omitTerm, restoreTerm, markTermsReviewed, markQuestionsReviewed.
export function applyEdit(rfx, edit) {
  const now = new Date().toISOString();
  const lines = rfx.lines.map(l => ({ ...l }));
  let questions = (rfx.questions || []).map(q => ({ ...q }));
  let terms = (rfx.terms || []).map(t => ({ ...t }));
  let detail = '';
  let linesChanged = false;

  const findQ = id => questions.find(q => q.id === id);
  const findT = id => terms.find(t => t.id === id);

  switch (edit.kind) {
    case 'setQty': {
      const line = lines.find(l => l.sl === edit.sl);
      if (!line) throw new Error(`no line ${edit.sl}`);
      line.quantity_nos = edit.qty;
      line.buyer_edited = true;
      detail = `Line ${edit.sl} qty -> ${edit.qty}`;
      break;
    }
    case 'setLineFields': {
      // Change a line's destination and/or schedule. Because derived term
      // wording (e.g. the FOR delivery clause) is built from these fields,
      // the change re-derives library wording and flags it for re-review.
      const line = lines.find(l => l.sl === edit.sl);
      if (!line) throw new Error(`no line ${edit.sl}`);
      const bits = [];
      if (edit.delivery_location !== undefined) {
        line.delivery_location = edit.delivery_location;
        bits.push(`delivery -> ${edit.delivery_location}`);
      }
      if (edit.delivery_schedule !== undefined) {
        line.delivery_schedule = edit.delivery_schedule;
        bits.push(`schedule -> ${edit.delivery_schedule}`);
      }
      if (!bits.length) throw new Error('setLineFields needs delivery_location and/or delivery_schedule');
      line.buyer_edited = true;
      detail = `Line ${edit.sl} ${bits.join(', ')}`;
      linesChanged = true;
      break;
    }
    case 'addLine': {
      lines.push(normalizeLine({ ...edit.line, buyer_edited: true }, lines.length + 1));
      detail = `Added line: ${edit.line.official_part_number || edit.line.catalog_ref || edit.line.description}`;
      linesChanged = true;
      break;
    }
    case 'splitLine': {
      // One catalog line -> two lines with qty allocation AND delivery locations.
      // Both legs must carry an explicit destination; a split that leaves the
      // new leg's location blank is rejected.
      const idx = lines.findIndex(l => l.sl === edit.sl);
      if (idx < 0) throw new Error(`no line ${edit.sl}`);
      if (!edit.locA || !edit.locB) {
        throw new Error(`split_line needs a delivery location for both legs (locA, locB)`);
      }
      const [orig] = lines.splice(idx, 1);
      const a = { ...orig, quantity_nos: edit.qtyA, delivery_location: edit.locA, buyer_edited: true };
      const b = { ...orig, sl: 0, quantity_nos: edit.qtyB, delivery_location: edit.locB, buyer_edited: true,
                  spec_note: (orig.spec_note ? orig.spec_note + ' ' : '') + '(split from line ' + edit.sl + ')' };
      lines.splice(idx, 0, a, b);
      lines.forEach((l, i) => { l.sl = i + 1; });
      detail = `Split line ${edit.sl} into ${edit.qtyA} (${edit.locA}) + ${edit.qtyB} (${edit.locB})`;
      linesChanged = true;
      break;
    }
    case 'removeLine': {
      const idx = lines.findIndex(l => l.sl === edit.sl);
      if (idx < 0) throw new Error(`no line ${edit.sl}`);
      lines.splice(idx, 1);
      lines.forEach((l, i) => { l.sl = i + 1; });
      detail = `Removed line ${edit.sl}`;
      linesChanged = true;
      break;
    }
    case 'setHeader': {
      detail = `Header ${edit.field} -> ${edit.value}`;
      return {
        rfx: { ...rfx, header: { ...rfx.header, [edit.field]: edit.value },
               history: [...rfx.history, { at: now, kind: 'edit', detail }] },
        edit: { at: now, kind: edit.kind, detail },
      };
    }
    // -- questions -----------------------------------------------------------
    case 'addQuestion': {
      if (findQ(edit.question.id)) { detail = `Question ${edit.question.id} already in draft`; break; }
      questions.push(makeQuestion(edit.question));
      detail = `Question added: ${edit.question.id}`;
      break;
    }
    case 'addCustomQuestion': {
      const id = `Q-CUSTOM-${questions.filter(q => q.id.startsWith('Q-CUSTOM-')).length + 1}`;
      questions.push(makeQuestion({ id, question: edit.text, origin: 'buyer', status: 'reviewed' }));
      detail = `Buyer question added verbatim: ${id}`;
      break;
    }
    case 'editQuestion': {
      const q = findQ(edit.id);
      if (!q) throw new Error(`no question ${edit.id}`);
      q.text = edit.text; q.origin = 'adapted'; q.status = 'needs-review';
      detail = `Question ${edit.id} edited — needs review again`;
      break;
    }
    case 'omitQuestion': {
      const q = findQ(edit.id);
      if (!q) throw new Error(`no question ${edit.id}`);
      q.omitted = true;
      detail = `Question ${edit.id} omitted`;
      break;
    }
    case 'restoreQuestion': {
      const q = findQ(edit.id);
      if (!q) throw new Error(`no question ${edit.id}`);
      q.omitted = false; q.status = 'needs-review';
      detail = `Question ${edit.id} restored — needs review again`;
      break;
    }
    case 'markQuestionsReviewed': {
      let n = 0;
      for (const q of questions) if (!q.omitted && q.status !== 'reviewed') { q.status = 'reviewed'; n++; }
      detail = n ? `${n} question${n > 1 ? 's' : ''} marked reviewed` : 'Questions already reviewed';
      break;
    }
    // -- terms ---------------------------------------------------------------
    case 'addTerm': {
      if (findT(edit.term.id)) { detail = `Term ${edit.term.id} already in draft`; break; }
      terms.push(makeTerm(edit.term));
      detail = `Term added as draft content needing review: ${edit.term.id}`;
      break;
    }
    case 'editTerm': {
      const t = findT(edit.id);
      if (!t) throw new Error(`no term ${edit.id}`);
      t.text = edit.text; t.origin = 'adapted'; t.status = 'needs-review';
      detail = `Term ${edit.id} edited — needs review again`;
      break;
    }
    case 'omitTerm': {
      const t = findT(edit.id);
      if (!t) throw new Error(`no term ${edit.id}`);
      t.omitted = true;
      detail = `Term ${edit.id} omitted`;
      break;
    }
    case 'restoreTerm': {
      const t = findT(edit.id);
      if (!t) throw new Error(`no term ${edit.id}`);
      t.omitted = false; t.status = 'needs-review';
      detail = `Term ${edit.id} restored — needs review again`;
      break;
    }
    case 'markTermsReviewed': {
      let n = 0;
      for (const t of terms) if (!t.omitted && t.status !== 'reviewed') { t.status = 'reviewed'; n++; }
      detail = n ? `${n} term${n > 1 ? 's' : ''} marked reviewed` : 'Terms already reviewed';
      break;
    }
    default:
      throw new Error(`unknown edit kind: ${edit.kind}`);
  }

  // A line change that alters destinations or schedules re-derives the wording
  // of library-origin terms built from them, and sends the affected terms back
  // for review. Buyer-authored or hand-edited wording is never rewritten — it
  // is only flagged back to needs-review when it covers delivery.
  if (linesChanged) {
    for (const t of terms) {
      if (t.omitted || t.origin === 'buyer') continue;
      if (t.origin === 'library' && t.source_text) {
        const { text } = resolveTermSlots(t.source_text, lines);
        if (text !== t.text) { t.text = text; t.status = 'needs-review'; }
      } else if ((t.coverage || []).includes('delivery')) {
        t.status = 'needs-review';
      }
    }
  }

  return {
    rfx: { ...rfx, lines, questions, terms,
           history: [...rfx.history, { at: now, kind: 'edit', detail }] },
    edit: { at: now, kind: edit.kind, detail },
  };
}

export function publishRfx(rfx) {
  const missing = validateForPublish(rfx);
  if (missing.length) {
    const err = new Error(`Cannot publish: missing required content — ${missing.join('; ')}`);
    err.missing = missing;
    throw err;
  }
  const now = new Date().toISOString();
  const channel = effectiveChannel(rfx);
  return {
    ...rfx,
    status: 'published',
    publishedAt: now,
    internal_id: rfx.internal_id || newRfxInternalId(new Date(now)),
    // A GeM bid number exists only for GeM-channel RFx. Non-GeM publishes
    // carry the internal ID only — never a generated GEM number.
    gem_bid_number: channel === 'gem'
      ? (rfx.header.gem_bid_number || `GEM/${now.slice(0, 10).replaceAll('-', '')}/B/XXXXXXX`)
      : null,
    history: [...rfx.history, { at: now, kind: 'published', detail: 'RFx published; responses tracked under this RFx' }],
  };
}

function statusTag(item) {
  if (item.omitted) return ' · omitted';
  return item.status === 'reviewed' ? '' : ' · needs review';
}

// Plain-text RFx document for the stub export (md download).
export function rfxToMarkdown(rfx) {
  const L = [];
  L.push(`# ${rfx.title}`);
  L.push('');
  const idLine = `RFx ID: ${rfx.internal_id || rfx.id}` +
    (rfx.gem_bid_number ? ` · GeM bid no: ${rfx.gem_bid_number}` : '') +
    ` · Status: ${rfx.status}`;
  L.push(idLine);
  L.push(`Buying unit: ${rfx.header.buying_unit || 'Not set'} · Bid due: ${rfx.header.bid_due_datetime || 'Not set'}`);
  L.push('');
  L.push('## Delivery locations');
  L.push('');
  for (const g of deliveryLocationGroups(rfx.lines)) {
    L.push(`- ${g.location}: lines ${g.range}`);
  }
  L.push('');
  L.push('## Line items');
  L.push('');
  L.push('| Sl | Part no | Description | Qty (nos) | Delivery |');
  L.push('|---|---|---|---|---|');
  for (const l of rfx.lines) {
    const pn = l.official_part_number || l.catalog_ref || '—';
    const pnNote = l.official_part_number ? '' : ' (part number not supplied in source)';
    L.push(`| ${l.sl} | ${pn}${pnNote} | ${l.description} | ${l.quantity_nos} | ${l.delivery_location || 'Not set'} |`);
  }
  L.push('');
  L.push('## Commercial terms');
  L.push('');
  liveItems(rfx.terms).forEach((t, i) => L.push(`${i + 1}. ${t.text}${statusTag(t)}`));
  if (!liveItems(rfx.terms).length) L.push('_No commercial terms included._');
  L.push('');
  L.push('## Vendor questionnaire');
  L.push('');
  liveItems(rfx.questions).forEach((q, i) =>
    L.push(`${i + 1}. ${q.text}${q.origin === 'buyer' ? ' *(buyer-authored)*' : ''}${statusTag(q)}`));
  if (!liveItems(rfx.questions).length) L.push('_No questions included yet._');
  return L.join('\n');
}
