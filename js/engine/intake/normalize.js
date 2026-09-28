// Deterministic normalization: quoted-as-is -> INR per box, incl. GST. DOM-free.
// The model transcribes; THIS module does every arithmetic step, so the math is
// auditable and identical on every run. Built for the five demo vendor shapes:
//   vijay-corrugators      INR per 100 boxes, email body
//   national-packaging     INR excl. GST, docx
//   shakti-packers          INR incl. GST, clean xlsx
//   sri-lakshmi-enterprises INR incl. GST, phone photo
//   gujarat-paper-mills    USD per box, pdf (2 part-number typos transcribed verbatim)

export function normalizeIntake({ rfx, extracted, vendorId, vendorName, settings }) {
  const lines = [];
  const flags = [];
  const confirmations = [];
  const rfxLines = rfx.lines || [];
  const usedExtracted = new Set();

  // Pass 1 — claim every exact part-number match up front. An extracted line
  // that exactly matches some RFx line can never be consumed by an earlier
  // RFx line's fuzzy proposal (e.g. quoted JTM0103995241 proposed against
  // RFx JTM0103995251 while its own exact line sat unclaimed).
  const exactHit = new Map(); // rfx index -> extracted index
  rfxLines.forEach((rl, r) => {
    const targets = [rl.official_part_number, rl.catalog_ref].map(norm).filter(Boolean);
    if (!targets.length) return;
    const hit = extracted.lines.findIndex((e, i) =>
      !usedExtracted.has(i) && targets.includes(norm(e.quoted_part_number)));
    if (hit >= 0) { usedExtracted.add(hit); exactHit.set(r, hit); }
  });

  rfxLines.forEach((rl, r) => {
    const displayPn = rl.official_part_number || rl.catalog_ref;
    const rec = {
      rfx_sl: rl.sl,
      rfx_part: displayPn,
      rfx_catalog_ref: rl.catalog_ref || null,
      rfx_official_part: rl.official_part_number || null,
      rfx_description: rl.description,
      rfx_qty: rl.quantity_nos,
      quoted_part: null, quoted_description: null, quoted_qty: null,
      quoted_price: null, quoted_currency: null, quoted_basis: null, quoted_gst: null,
      matched: 'missing',            // exact | proposed | unmatched | missing
      proposed_part: null,
      normalized_inr_incl_gst: null, // per box, incl. GST, 2dp — comparable totals only
      proposed_normalized_inr_incl_gst: null, // staged until the buyer confirms the mapping
      match_confirmed: false,        // true once a proposed mapping is buyer-confirmed
      flags: [],
    };

    // 1) exact match claimed in pass 1 (official part number, then catalog
    //    reference — the six KGF lines have no official part number, vendors
    //    quote the catalog ref, e.g. KGF-7PLY-01).
    const hit = exactHit.has(r) ? exactHit.get(r) : -1;

    if (hit >= 0) {
      fillQuoted(rec, extracted.lines[hit]);
      rec.matched = 'exact';
    } else {
      // 2) fuzzy proposal — the Gujarat typos land here, never silently merged.
      //    Scored by description overlap first, part-number distance second:
      //    JTM0103995257 is edit-distance 1 from BOTH 5251 and 5252, and
      //    KGF-7PLY-08 is distance 1 from every KGF-7PLY-0x — digits alone
      //    cannot disambiguate, so the description decides.
      const proposal = proposePartMatch(extracted.lines, usedExtracted, rl);
      if (proposal) {
        usedExtracted.add(proposal.index);
        fillQuoted(rec, proposal.line);
        rec.matched = 'proposed';
        rec.proposed_part = displayPn;
        rec.flags.push({ kind: 'part_mismatch', text: `Quoted ${rec.quoted_part} — proposed match to RFx ${displayPn || 'line ' + rl.sl}` });
        confirmations.push({
          id: `${vendorId}-part-${rl.sl}`,
          vendorId, kind: 'part_match', status: 'pending',
          title: `Map quoted ${rec.quoted_part} to RFx line ${rl.sl}?`,
          detail: `${vendorName} quoted part number ${rec.quoted_part}; closest RFx line is ${rl.sl} ` +
            `(${displayPn || 'no part number'} — ${rl.description}).` +
            (proposal.ambiguous ? ` Ambiguous: also close to ${proposal.candidates.join(', ')}.` : ''),
          evidence: { quoted: rec.quoted_part, proposed: displayPn, rfx_sl: rl.sl,
                      candidates: proposal.candidates || undefined },
        });
      } else {
        rec.flags.push({ kind: 'not_quoted', text: 'Not quoted by this vendor' });
      }
    }

    // 3) normalize the money. A proposed match is STAGED ONLY — its value is
    //    computed for buyer inspection but never enters comparable totals
    //    until the buyer confirms the mapping.
    const moneyVal = (rec.matched === 'exact' || rec.matched === 'proposed')
      ? normalizeMoney(rec, settings, flags, confirmations, vendorId, vendorName)
      : null;
    if (rec.matched === 'exact') rec.normalized_inr_incl_gst = moneyVal;
    else if (rec.matched === 'proposed') rec.proposed_normalized_inr_incl_gst = moneyVal;

    lines.push(rec);
  });

  // 4) quoted lines that match no RFx line at all
  extracted.lines.forEach((e, i) => {
    if (usedExtracted.has(i) || e.unreadable) return;
    flags.push({
      kind: 'extra_line', vendorId,
      text: `${vendorName} quoted ${e.quoted_part_number || 'a line'} not present in the RFx — left out of the comparison.`,
    });
  });

  return { vendorId, vendorName, lines, flags, confirmations, meta: extracted.meta || {} };
}

function norm(pn) {
  return String(pn || '').replace(/\(.*?\)/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// Jaccard overlap of alphanumeric tokens, 0..1.
function descOverlap(a, b) {
  const toks = s => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1));
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function fillQuoted(rec, e) {
  rec.quoted_part = e.quoted_part_number;
  rec.quoted_description = e.quoted_description;
  rec.quoted_qty = e.quoted_qty;
  rec.quoted_price = e.quoted_unit_price;
  rec.quoted_currency = e.quoted_currency;
  rec.quoted_basis = e.quoted_basis;
  rec.quoted_gst = e.quoted_gst;
}

// Closest RFx-line match for an unmatched quoted line.
// Candidates: edit distance <= 2, near-substring, or (no RFx part number)
// strong description overlap. Ranked by description overlap first, then
// part-number distance: JTM0103995257 is distance 1 from BOTH 5251 and 5252,
// and KGF-7PLY-08 is distance 1 from every KGF-7PLY-0x — digits alone cannot
// disambiguate, so the description decides. Ties stay buyer-visible.
function proposePartMatch(extractedLines, used, rfxLine) {
  const target = norm(rfxLine.official_part_number || rfxLine.catalog_ref);
  const scored = [];
  extractedLines.forEach((e, i) => {
    if (used.has(i) || e.unreadable || !e.quoted_part_number) return;
    const cand = norm(e.quoted_part_number);
    const d = target ? levenshtein(cand, target) : 99;
    const nearSubstring = !!target && (target.includes(cand) || cand.includes(target));
    const descScore = descOverlap(e.quoted_description, rfxLine.description);
    if (d <= 2 || (nearSubstring && Math.abs(cand.length - target.length) <= 3) || (!target && descScore > 0.4)) {
      scored.push({ index: i, line: e, d, descScore });
    }
  });
  if (!scored.length) return null;
  scored.sort((a, b) => (b.descScore - a.descScore) || (a.d - b.d));
  const best = scored[0];
  const ambiguous = scored.length > 1 &&
    Math.abs(scored[1].descScore - best.descScore) < 0.02 && scored[1].d === best.d;
  return {
    ...best,
    ambiguous,
    candidates: ambiguous ? scored.slice(1, 4).map(s => s.line.quoted_part_number) : undefined,
  };
}

function normalizeMoney(rec, settings, flags, confirmations, vendorId, vendorName) {
  let price = Number(rec.quoted_price);
  if (!Number.isFinite(price)) {
    rec.flags.push({ kind: 'unreadable_price', text: 'Quoted price unreadable — excluded from totals' });
    return null;
  }
  const steps = [];

  // currency
  const cur = String(rec.quoted_currency || 'INR').toUpperCase();
  if (cur === 'USD' || cur === '$') {
    price = price * settings.usdInr;
    steps.push(`USD→INR @ ${settings.usdInr} (${settings.usdInrAsOf})`);
    rec.flags.push({ kind: 'fx', text: `USD converted at ₹${settings.usdInr} (spot ${settings.usdInrAsOf})` });
  }

  // basis
  const basis = String(rec.quoted_basis || '').toLowerCase();
  if (/per\s*100|100\s*(nos|boxes|pcs)/.test(basis)) {
    price = price / 100;
    steps.push('÷100 (per-100-boxes basis)');
    rec.flags.push({ kind: 'basis', text: 'Quoted per 100 boxes — divided by 100' });
  }

  // GST
  const gst = String(rec.quoted_gst || 'unstated').toLowerCase();
  if (gst === 'excl' || /excl|excluding|exclusive/.test(basis)) {
    price = price * (1 + settings.gstRate);
    steps.push(`+${Math.round(settings.gstRate * 100)}% GST`);
    rec.flags.push({ kind: 'gst', text: `Quoted excl. GST — ${Math.round(settings.gstRate * 100)}% added` });
  } else if (gst === 'unstated') {
    rec.flags.push({ kind: 'gst_unstated', text: 'GST basis not stated — treated as incl. GST for comparison' });
    confirmations.push({
      id: `${vendorId}-gst-${rec.rfx_sl}`,
      vendorId, kind: 'gst_basis', status: 'pending',
      title: `Confirm GST basis for line ${rec.rfx_sl}`,
      detail: `${vendorName}'s quote does not state whether line ${rec.rfx_sl} (${rec.quoted_part}) includes GST. Treated as incl. GST for comparison — confirm with the vendor.`,
      evidence: { rfx_sl: rec.rfx_sl, quoted: rec.quoted_price, assumed: 'incl' },
    });
  }
  // 'incl' -> as-is

  rec.normalization_steps = steps;
  return round2(price);
}

function round2(n) { return Math.round(n * 100) / 100; }

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1,
      dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  }
  return dp[m][n];
}

// --- comparison helpers (used by the analyst + comparison grid) ---

// Buyer confirms a proposed part mapping: the staged value enters comparable
// totals. Rejection (app-side rejectMapping) leaves the line unmatched.
export function confirmPartMatch(normalized, confirmationId) {
  const c = (normalized.confirmations || [])
    .find(x => x.id === confirmationId && x.kind === 'part_match');
  if (!c || c.status !== 'pending') return false;
  const rec = normalized.lines.find(l =>
    l.rfx_sl === c.evidence?.rfx_sl && l.matched === 'proposed');
  if (!rec) return false;
  c.status = 'confirmed';
  rec.match_confirmed = true;
  rec.normalized_inr_incl_gst = rec.proposed_normalized_inr_incl_gst ?? null;
  return rec.normalized_inr_incl_gst != null;
}

// Quoted-line coverage: lines the vendor actually quoted (exact + proposed),
// regardless of whether proposed mappings are buyer-confirmed yet.
export function quotedLineCount(normalized) {
  return normalized.lines.filter(l => l.matched === 'exact' || l.matched === 'proposed').length;
}

// Line value = normalized per-box price x RFx quantity. Totals are sums of
// line values, never sums of unit prices.
export function lineValue(l) {
  if (l.normalized_inr_incl_gst == null || !l.rfx_qty) return 0;
  return round2(l.normalized_inr_incl_gst * l.rfx_qty);
}

export function vendorTotals(normalized) {
  const lines = normalized.lines.filter(l => l.normalized_inr_incl_gst != null);
  const total = round2(lines.reduce((s, l) => s + lineValue(l), 0));
  return {
    vendorId: normalized.vendorId, vendorName: normalized.vendorName,
    linesQuoted: lines.length, total,
  };
}

// Lowest price per RFx line; uncertain mappings are excluded until confirmed.
export function cheapestPerLine(allNormalized) {
  const bySl = {};
  for (const n of allNormalized) {
    for (const l of n.lines) {
      if (l.normalized_inr_incl_gst == null || (l.matched !== 'exact' && l.match_confirmed !== true)) continue;
      const cur = bySl[l.rfx_sl];
      if (!cur || l.normalized_inr_incl_gst < cur.price) {
        bySl[l.rfx_sl] = { price: l.normalized_inr_incl_gst, vendorId: n.vendorId, vendorName: n.vendorName };
      }
    }
  }
  return bySl;
}

// Lowest total over the set of lines quoted by ALL listed vendors (the honest denominator).
export function lowestOnCommonSet(allNormalized) {
  const slCounts = {};
  for (const n of allNormalized) for (const l of n.lines) {
    if (l.normalized_inr_incl_gst != null && (l.matched === 'exact' || l.match_confirmed === true)) slCounts[l.rfx_sl] = (slCounts[l.rfx_sl] || 0) + 1;
  }
  const common = Object.keys(slCounts).filter(sl => slCounts[sl] === allNormalized.length).map(Number);
  common.sort((a, b) => a - b);
  const allIds = [...new Set(allNormalized.flatMap(n => n.lines.map(l => Number(l.rfx_sl)).filter(Number.isFinite)))].sort((a, b) => a - b);
  const excludedOrUnevenLineIds = allIds.filter(sl => !common.includes(sl));
  const totals = allNormalized.map(n => ({
    vendorId: n.vendorId, vendorName: n.vendorName,
    commonLines: common.length,
    total: round2(common.reduce((s, sl) => {
      const l = n.lines.find(x => x.rfx_sl === sl);
      return s + (l ? lineValue(l) : 0);
    }, 0)),
  })).sort((a, b) => a.total - b.total);
  return { commonLines: common.length, commonLineIds: common, excludedOrUnevenLineIds, totals };
}
