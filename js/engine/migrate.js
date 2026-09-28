// Migration of saved v1 drafts to the progressive questions/terms model.
// DOM-free. The saved 30-line draft keeps its lines and header; its old
// questions and terms become unreviewed draft content. The false
// buyer-authored label on the canned Q-X1 is stripped; its text is kept and
// can be replaced in Review. The old buyer conversation is preserved as
// read-only history; a fresh transcript starts with a resume note.

import { resolveTermSlots } from './composer.js';

// The prepared vendor questionnaires answer the buyer's PSU-supply question
// under Q-X1. Repair only the matching, unpublished 30-line demo draft; a
// generic Q-G6 in any other RFx must keep its original identity and wording.
export function alignDemoPsuQuestion(saved, catalog) {
  const rfx = saved?.draft?.rfx;
  const lines = rfx?.lines || [];
  const questions = rfx?.questions || [];
  const target = catalog?.questions({ custom: true }).find(q => q.id === 'Q-X1');
  const old = questions.find(q => q.id === 'Q-G6' && !q.omitted);
  if (!target || !old || questions.some(q => q.id === 'Q-X1') ||
      lines.length !== 30 || questions.filter(q => !q.omitted).length !== 17 ||
      lines[0]?.catalog_ref !== 'JTM0103995251' ||
      lines[25]?.catalog_ref !== 'JTM0103995251' ||
      lines.slice(19, 25).some((line, i) => line.catalog_ref !== `KGF-7PLY-0${i + 1}`)) {
    return saved;
  }
  const now = new Date().toISOString();
  return {
    ...saved,
    draft: {
      ...saved.draft,
      rfx: {
        ...rfx,
        questions: questions.map(q => q === old ? {
          ...q, id: target.id, text: target.question, source_text: target.question,
          origin: 'adapted', status: 'needs-review',
        } : q),
        history: [...(rfx.history || []), {
          at: now, kind: 'edit',
          detail: 'Aligned the PSU-supply question with vendor answer ID Q-X1; wording needs buyer review',
        }],
      },
    },
  };
}

export function migrateV1Draft(draft, catalog) {
  if (!draft || !draft.rfx) return draft;
  const now = new Date().toISOString();
  const old = draft.rfx;
  const lines = old.lines || [];

  const terms = (old.terms || []).map(t => {
    const src = catalog.termSource(t.id) || {};
    const source_text = src.text || t.sentence || t.text || '';
    // Re-resolve slots from the draft's own lines — this also clears the
    // stale literal [DELIVERY_LOCATION] the old draft carried.
    const { text } = resolveTermSlots(source_text, lines);
    return {
      id: t.id,
      text,
      source_text,
      status: 'needs-review',
      origin: 'library',
      coverage: src.coverage || [],
      conditional: src.conditional ? { ...src.conditional } : null,
      omitted: !!t.omitted,
    };
  });

  const qById = Object.fromEntries(catalog.questionBank().map(q => [q.id, q]));
  const questions = (old.questions || []).map(q => {
    const lib = qById[q.id];
    const isCustom = String(q.id).startsWith('Q-CUSTOM-');
    // The old canned Q-X1 was never buyer-authored: strip the false label.
    // Genuine buyer-authored custom questions keep theirs.
    const buyerAuthored = isCustom && !!q.buyer_authored;
    return {
      id: q.id,
      text: q.question || q.text || '',
      source_text: q.question || q.text || '',
      status: 'needs-review',
      origin: buyerAuthored ? 'buyer' : 'library',
      coverage: lib ? (lib.coverage || []) : [],
      conditional: null,
      omitted: !!q.omitted,
    };
  });

  const historyChat = draft.messages || [];
  const resumeNote = 'Resumed your saved draft. The earlier questions and commercial terms are now ' +
    'draft content needing review — nothing is approved yet. The false buyer-authored label was ' +
    'removed from the canned PSU question; you can replace its text in Review. ' +
    'Your earlier conversation is kept below as read-only history.';

  return {
    ...draft,
    historyChat,
    messages: [{ role: 'assistant', content: resumeNote }],
    rfx: {
      ...old,
      lines,
      terms,
      questions,
      history: [...(old.history || []),
        { at: now, kind: 'migration',
          detail: `Migrated to progressive review model: ${questions.length} questions + ${terms.length} terms marked needs-review; Q-X1 buyer-authored label removed` }],
    },
  };
}

// Migrate a whole saved v1 state object (draft + optional published RFx).
export function migrateV1State(saved, catalog) {
  if (!saved) return null;
  const out = { ...saved };
  if (saved.draft) out.draft = migrateV1Draft(saved.draft, catalog);
  if (saved.rfx && saved.rfx.terms && saved.rfx.terms.length && saved.rfx.terms[0].sentence) {
    // Published RFx in the old shape: normalize to the new item shape as
    // reviewed (it was published), keeping it readable downstream.
    out.rfx = {
      ...saved.rfx,
      terms: saved.rfx.terms.map(t => ({ id: t.id, text: t.sentence || t.text, source_text: t.sentence || t.text,
        status: 'reviewed', origin: 'library', coverage: [], conditional: null, omitted: false })),
      questions: (saved.rfx.questions || []).map(q => ({ id: q.id, text: q.question || q.text, source_text: q.question || q.text,
        status: 'reviewed', origin: q.buyer_authored ? 'buyer' : 'library', coverage: [], conditional: null, omitted: false })),
    };
  }
  return out;
}

// v3's publish() left the just-published RFx duplicated under `draft` (with
// the 340 GSM conflict attached to the draft, not the published object).
// v4 consumes the draft on publish and carries the conflict onto the
// published RFx, so a saved v3 state needs a one-time repair:
//  - remove the draft ONLY when proven to be the pre-publish snapshot of the
//    published RFx (same document id + title + identical line fingerprint)
//  - never touch the published RFx, intake, confirmations, qualification,
//    analyst or compare state
//  - restore rfx.specConflict from the published lines when it is missing
//    (recomputed via catalog.specConflictFor — data-driven, never invented)
// Idempotent: a repaired state passes through unchanged.
export function repairV3PublishedState(saved, catalog) {
  if (!saved || !saved.rfx) return { state: saved, repaired: false, detail: '' };
  const out = { ...saved };
  const details = [];
  const d = saved.draft;
  if (d && d.rfx && isPublishedDuplicate(d.rfx, saved.rfx)) {
    out.draft = null;
    details.push('removed draft duplicating the published RFx');
  }
  if (!out.rfx.specConflict && catalog && typeof catalog.specConflictFor === 'function') {
    const restored = catalog.specConflictFor(out.rfx.lines || []);
    if (restored) {
      out.rfx = { ...out.rfx, specConflict: restored };
      details.push('restored 340 GSM flag from the published lines');
    }
  }
  return { state: out, repaired: details.length > 0, detail: details.join('; ') };
}

function lineFingerprint(lines) {
  return (lines || []).map(l =>
    [l.sl, l.official_part_number || '', l.catalog_ref || '', l.quantity_nos,
     l.delivery_location || ''].join('|')).join('~');
}

// publishRfx spreads the draft's RFx, so the published object keeps the
// draft's document id. Same id + title + identical lines == the draft is the
// pre-publish snapshot, safe to drop. A genuinely different draft (new id,
// edited lines, different title) is left alone.
function isPublishedDuplicate(draftRfx, rfx) {
  if (!draftRfx || !rfx) return false;
  if (!draftRfx.id || draftRfx.id !== rfx.id) return false;
  if ((draftRfx.title || '') !== (rfx.title || '')) return false;
  const a = draftRfx.lines || [], b = rfx.lines || [];
  if (!a.length || a.length !== b.length) return false;
  return lineFingerprint(a) === lineFingerprint(b);
}
