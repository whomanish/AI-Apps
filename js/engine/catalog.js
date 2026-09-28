// Retrieval tools over catalog-seed.json. DOM-free.
// The drafter calls these as tools; the composer reads the same shapes.
// Nothing here invents data — every line comes from the catalog.

export function createCatalog(data) {
  const attrs = data.attributes || {};

  const items = (attrs.line_items && attrs.line_items.items) || [];
  const itemFields = (attrs.line_items && attrs.line_items.static_fields) || [];
  const dynFields = (attrs.line_items && attrs.line_items.dynamic_fields) || [];
  const termsRaw = (attrs.commercial_terms && attrs.commercial_terms.static_clauses) || [];
  const termSlots = (attrs.commercial_terms && attrs.commercial_terms.dynamic_slots) || [];
  const qBank = (attrs.questionnaire && attrs.questionnaire.static_bank) || [];
  const qSubsetIds = (attrs.questionnaire && attrs.questionnaire.demo_default_subset) || [];
  const qCustom = (attrs.questionnaire && attrs.questionnaire.demo_custom_question) || null;
  const specTemplates = (attrs.specifications && attrs.specifications.static_templates) || {};
  const headerDefaults = (attrs.rfx_header && attrs.rfx_header.static_defaults) || {};
  const headerSlots = (attrs.rfx_header && attrs.rfx_header.dynamic_slots) || [];

  function lineItems() {
    return items.map(it => ({ ...it }));
  }

  // Lookup by catalog reference or official part number (either identifies the item).
  function getItem(refOrPn) {
    const key = String(refOrPn || '').trim();
    return items.find(it => it.catalog_ref === key || it.official_part_number === key) || null;
  }

  function searchLineItems(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return lineItems();
    const toks = q.split(/\s+/);
    return items.filter(it => {
      const hay = [it.catalog_ref, it.official_part_number, it.description, it.spec_regime, it.flute, String(it.ply), String(it.gsm)]
        .join(' ').toLowerCase();
      return toks.every(t => hay.includes(t));
    }).map(it => ({ ...it }));
  }

  // Commercial terms as full sentences; dynamic slots filled from `fill`.
  // Each entry carries coverage (publish-gate categories it satisfies) and an
  // optional conditional flag (channel / confirm / value) — the drafter must
  // satisfy the condition before the term enters the RFx.
  function terms(fill = {}) {
    return Object.entries(termsRaw).map(([id, entry]) => {
      let s = entry.text;
      for (const slot of termSlots) {
        const name = slot.name;
        s = s.split(`[${name.toUpperCase()}]`).join(fill[name] ?? `[${name.toUpperCase()}]`);
      }
      return { id, text: s, coverage: entry.coverage || [],
               conditional: entry.conditional ? { ...entry.conditional } : null };
    });
  }

  // Raw (unfilled) library text for one term — used when the composer resolves
  // slots from the live draft instead of a static fill map.
  function termSource(id) { return termsRaw[id] ? { ...termsRaw[id] } : null; }

  // Questionnaire: the 16-question subset by default. The buyer-authored PSU
  // question (Q-X1) is appended only when the buyer requests it ({ custom: true }).
  function questions({ custom = false } = {}) {
    const byId = Object.fromEntries(qBank.map(q => [q.id, q]));
    const subset = qSubsetIds.map(id => byId[id]).filter(Boolean)
      .map(q => ({ id: q.id, question: q.question, coverage: q.coverage || [], conditional: null }));
    if (custom && qCustom) subset.push({ id: qCustom.id, question: qCustom.question,
      coverage: [], conditional: null, buyer_authored: true });
    return subset;
  }

  // Full question bank entries (with coverage) for the drafter's recommendations.
  function questionBank() { return qBank.map(q => ({ id: q.id, question: q.question, coverage: q.coverage || [] })); }

  // The known source inconsistency: line JTM0103995148 reads 340 GSM while the
  // enquiry's spec text (five_ply_150gsm_rsc) states 150 GSM layers.
  // Returns the conflict object iff that part is in the draft's lines.
  function specConflictFor(lines) {
    const hit = (lines || []).find(l => (l.official_part_number || l.catalog_ref) === 'JTM0103995148');
    if (!hit) return null;
    return {
      part_number: 'JTM0103995148',
      listed_gsm: 340,
      spec_text_gsm: 150,
      message:
        'Line JTM0103995148 reads 340 GSM, but the enquiry spec text (five_ply_150gsm_rsc) ' +
        'states 150 GSM layers. Flagged for your decision — the draft keeps the listed 340 GSM ' +
        'until you say otherwise.',
    };
  }

  return {
    lineItems, getItem, searchLineItems, terms, termSource, questions, questionBank, specConflictFor,
    specTemplates: () => JSON.parse(JSON.stringify(specTemplates)),
    headerDefaults: () => ({ ...headerDefaults }),
    headerSlots: () => headerSlots.map(s => ({ ...s })),
    itemFields: () => [...itemFields],
    dynamicFields: () => dynFields.map(f => ({ ...f })),
    thinSourceFlag: !!(attrs.questionnaire && attrs.questionnaire.thin_source_flag),
  };
}
