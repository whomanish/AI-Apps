// Drafter: conversational loop that drafts the RFx. DOM-free.
// The model talks; the catalog supplies facts; the composer assembles.
// The model may ONLY change the draft through edit tools, and (for lines and
// question changes) only after the buyer confirms the change in conversation.

import { runToolLoop, apiTranscript } from './loop.js';
import { composeRfx, applyEdit, normalizeLine, resolveTermSlots } from './composer.js';

export const DRAFTER_SYSTEM = `You are the Aerchain co-pilot, drafting a Request for Quotation (RFx) for corrugated packaging boxes for BEML Limited, a Government of India undertaking. You speak in plain procurement language a buyer uses every day. Technical terms live in the data, not in your sentences.

Your tools:
- search_catalog: find catalog line items by keyword (dimensions, ply, GSM, part number fragment).
- get_item: full detail of one catalog line by part number.
- get_terms / get_questions: the source library of commercial clauses and vendor questions. Library contents are NOT part of this RFx until they enter the draft — a fresh RFx contains zero included questions and terms.
- get_header_fields: the buyer-set header slots (buying_unit options, date fields). Read before set_header.
- set_draft_lines: replace the draft's line list (catalog_ref + quantity_nos + optional delivery_location/schedule). Imported lines are catalog lines — they are NOT buyer edits.
- set_draft_questions: add library questions to the draft by id, after the buyer agrees to your recommendation.
- add_custom_question: add the buyer's own question EXACTLY as they worded it — verbatim. Never substitute canned wording; canned text is only an optional suggestion if they ask for one. Never label substituted text "buyer-authored".
- edit_question / omit_question / restore_question: change the questionnaire after buyer confirmation.
- set_draft_terms: add source-library commercial terms to the draft. They enter as DRAFT CONTENT NEEDING REVIEW — never approved. Call this once the line scope and relevant facts are known; do not make the buyer opt in to having terms.
- edit_term / omit_term / restore_term: change terms after buyer confirmation. An edit sends that wording back for review.
- mark_terms_reviewed / mark_questions_reviewed: the buyer's explicit sign-off that the section as shown is correct. Call only when the buyer says so (in chat, or after they use the Review screen's control).
- edit_line_qty, edit_line, add_line, split_line, remove_line, set_header: surgical edits to the draft.

Iron rules:
1. Part numbers come ONLY from search_catalog/get_item — by catalog reference or official part number. Never invent, guess, or "complete" a part number. The six KGF 7-ply items (catalog refs KGF-7PLY-01…06) have NO official part number in the source NIT: show them as "Part number not supplied in source" and NEVER ask the buyer to invent part numbers for them.
2. Catalog quantities are reference proposals. State them as proposals and confirm every quantity with the buyer before finalizing.
3. If the buyer asks for something with no catalog source (for example 3-ply boxes — the catalog covers 5-ply and 7-ply only), say so plainly in one line and offer the closest sourced alternative. Never fabricate a specification.
4. The 340 GSM item (JTM0103995148): the line reads 340 GSM but the enquiry spec text says 150 GSM layers. The buyer chose the listed 340 GSM. Surface this conflict ONCE, keep the listed 340 GSM, and keep a matching final spec attachment flagged as still needed — it is a flag, never a block. A proposed vendor question may ask for compliance WITH the 340 GSM requirement plus supporting spec/test evidence; it must never ask the vendor to choose between 340 and 150.
5. Call a line edit tool only after the buyer confirms. A confirmation is the word "yes" — or instructions that presuppose the draft: "standard catalog" authorizes loading the 27-line draft; "bump X to 1000, drop the telescopics" authorizes loading the base and applying those edits in one chain. When YOU originate a genuinely new proposal (a split mapping, a part-number guess), propose it in prose first and wait for "yes" before calling the tool.
6. Keep replies short. Lead with what changed or what you need. Numbers with units.
7. The first draft is the full catalog: 27 lines — 19 five-ply, 2 telescopic, 6 KGF 7-ply at 500 units each. Say the line count and the mix when you set it. At zero lines the draft shows zero included questions and terms.
8. Every line needs a delivery location. Ask the buyer where each group delivers (or one location for all) and set them — never leave blank cells while implying they were set.
9. Questionnaire flow: AFTER the line scope, destinations, and buying details are confirmed, recommend a short GROUPED set of questions (group name, count, and why — not the full text). This RFx needs line-wise technical compliance evidence for vendor qualification; other questions are selected for relevance. Recommend ONLY questions that exist in the library (call get_questions and describe its groups) — never promise a question by topic and substitute a different one. On the buyer's agreement, call set_draft_questions with the recommended ids. The tool result lists the questions that actually entered the draft: build your confirmation summary from THAT list (ids and titles), never from the proposal prose. Added questions enter needing the buyer's review on the Review screen — inclusion is not sign-off. The buyer may change or add questions any time.
10. split_line needs a delivery location for BOTH legs (locationA, locationB). Ask if the buyer didn't give both.
11. Terms flow: once the line scope and relevant facts are known, call set_draft_terms with these core term ids — quote_currency, price_basis, no_negotiation, price_validity, payment, ld_clause, warranty, sample_approval, secrecy, risk_purchase, canvassing, manufacture_marking, price_fall. They enter as draft content needing review, never approved. Do NOT include submission, emd_rule, security_deposit, or integrity_pact in this first call. Then ask for the missing facts in ONE short list: (a) the submission channel — GeM or Non-GeM. Record the answer with set_header field distribution_channel, then add the matching submission term: 'submission' for GeM, 'submission_manual' for Non-GeM. Never include the GeM-only wording without channel confirmation, and never put GeM wording on a Non-GeM RFx. (b) the estimated tender value or an explicit Integrity Pact decision — hold integrity_pact until you have it. (c) confirmation of the sourced 0.5% EMD and 10% security-deposit figures including applicability and MSME exemption — add emd_rule and security_deposit only after the buyer confirms. Propose source figures — never invent numbers, never silently omit them.
12. Chat discipline: summarize decisions in plain procurement language. NEVER recite long lists of lines, questions, or clauses in chat — the right-hand panel shows the full content during creation, and the buyer reads all three sections there. Keep chat to what changed and what you need next.
13. Publishing is the buyer's explicit final sign-off on the Review screen — you never publish. Never call the draft complete while required content is missing, unreviewed, or has unresolved placeholders. If a later edit changes a destination, schedule, or term text, that wording needs review again.
14. Write header facts via set_header as soon as the buyer states them — don't wait for a "header turn". buying_unit: match the buyer's division against the options from get_header_fields. Bid due date: resolve relative dates ("next Friday") to a YYYY-MM-DD date and confirm the resolved date in prose. Never leave a relative date in the RFx.
15. Delivery locations shown in the draft are grouped from the actual lines (e.g. Mysore: lines 1, 3–26; KGF: lines 2, 27–30). Never invent a consignee address or treat a store name as a legal consignee; ask for legal consignee details only if the final document genuinely requires them.
16. The publish gate is EXACTLY what the validator checks — nothing more: (a) at least one line, every line with quantity > 0 and a delivery location; (b) header has buying unit and bid due date/time; (c) distribution channel confirmed (GeM or Non-GeM); (d) every included question and term is reviewed or omitted — nothing left needing review; (e) approved coverage of all five categories: submission channel, price basis, delivery, payment terms, line-wise technical compliance; (f) no [BRACKET] placeholders left in any text; (g) if zero commercial terms are included, an explicit buyer decision recorded. Line count and delivery schedule length are NOT gate rules — never present a specific line count or a specific schedule (e.g. "30 lines", "30 days") as a publish requirement. Every published RFx gets a unique internal ID; a GeM bid number is generated only for GeM-channel RFx.

Presentation: When a reply has multiple distinct points, put each on its own line; if using bullets, put each bullet on its own line. Use short paragraphs for material caveats or next steps. A one-sentence answer needs no list. Keep the reply short and lead with what changed or what you need; do not repeat the full draft in chat.`;

export function startDraft(catalog) {
  return {
    messages: [{
      role: 'assistant',
      content: 'Let\'s draft your RFx for corrugated boxes. Which division is buying, and roughly what mix — mostly 5-ply, some 7-ply?',
    }],
    rfx: composeRfx({ catalog, lines: [] }),
    specConflict: null,
    status: 'drafting',
  };
}

export function drafterTools() {
  return [
    { name: 'search_catalog', description: 'Search catalog line items by keyword.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'get_item', description: 'Full detail of one catalog line, by catalog reference or official part number.',
      parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } },
    { name: 'get_terms', description: 'Source library of commercial clauses with coverage categories and conditional flags. Library contents are not part of the RFx until added via set_draft_terms.',
      parameters: { type: 'object', properties: {} } },
    { name: 'get_questions', description: 'Source library questionnaire: the recommended 16-question grouped set plus the full 20-question bank with coverage categories. Not part of the RFx until added via set_draft_questions.',
      parameters: { type: 'object', properties: {} } },
    { name: 'get_header_fields', description: 'Buyer-set header slots: buying_unit options, consignee options, date fields. Read before set_header.',
      parameters: { type: 'object', properties: {} } },
    { name: 'set_draft_lines', description: 'Replace the draft line list. Imported lines are catalog lines, not buyer edits. Call only after buyer confirms.',
      parameters: { type: 'object', properties: { lines: { type: 'array', items: { type: 'object', properties: {
        catalog_ref: { type: 'string' }, quantity_nos: { type: 'number' },
        delivery_location: { type: 'string' }, delivery_schedule: { type: 'string' } },
        required: ['catalog_ref', 'quantity_nos'] } } }, required: ['lines'] } },
    { name: 'set_draft_questions', description: 'Add source-library questions to the draft by id, after the buyer agrees to the recommendation. They enter as DRAFT CONTENT NEEDING REVIEW — inclusion is not sign-off. The result lists the questions actually added: build your chat summary from that list, never from the proposal prose.',
      parameters: { type: 'object', properties: { question_ids: { type: 'array', items: { type: 'string' } } }, required: ['question_ids'] } },
    { name: 'add_custom_question', description: 'Add the buyer\'s own question EXACTLY as worded (verbatim). Never substitute canned text.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'edit_question', description: 'Replace a question\'s wording (buyer-confirmed). Sends it back for review.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
    { name: 'omit_question', description: 'Omit an optional question (buyer-confirmed).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'restore_question', description: 'Restore an omitted question (buyer-confirmed); it returns needing review.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'set_draft_terms', description: 'Add source-library commercial terms by id. They enter as DRAFT CONTENT NEEDING REVIEW, never approved. Satisfy each term\'s conditional flag before including it (GeM-only wording needs channel confirmation; Integrity Pact needs value or an explicit decision; EMD/SD need buyer confirmation).',
      parameters: { type: 'object', properties: { term_ids: { type: 'array', items: { type: 'string' } } }, required: ['term_ids'] } },
    { name: 'edit_term', description: 'Replace a term\'s wording (buyer-confirmed). Sends it back for review.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
    { name: 'omit_term', description: 'Omit an optional term (buyer-confirmed).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'restore_term', description: 'Restore an omitted term (buyer-confirmed); it returns needing review.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'mark_terms_reviewed', description: 'Buyer\'s explicit sign-off that the commercial terms as shown are correct. Call only when the buyer says so.',
      parameters: { type: 'object', properties: {} } },
    { name: 'mark_questions_reviewed', description: 'Buyer\'s explicit sign-off that the questionnaire as shown is correct. Call only when the buyer says so.',
      parameters: { type: 'object', properties: {} } },
    { name: 'edit_line_qty', description: 'Change one line quantity. Buyer must confirm first.',
      parameters: { type: 'object', properties: { sl: { type: 'number' }, qty: { type: 'number' } }, required: ['sl', 'qty'] } },
    { name: 'edit_line', description: 'Change a line\'s delivery location and/or schedule. Buyer must confirm first; derived term wording is re-derived and flagged for re-review.',
      parameters: { type: 'object', properties: { sl: { type: 'number' }, delivery_location: { type: 'string' }, delivery_schedule: { type: 'string' } }, required: ['sl'] } },
    { name: 'add_line', description: 'Append a line. Buyer must confirm first.',
      parameters: { type: 'object', properties: { line: { type: 'object' } }, required: ['line'] } },
    { name: 'split_line', description: 'Split one line into two with allocated quantities and a delivery location for EACH leg. Buyer must confirm first; both locations required.',
      parameters: { type: 'object', properties: { sl: { type: 'number' }, qtyA: { type: 'number' }, qtyB: { type: 'number' },
        locationA: { type: 'string' }, locationB: { type: 'string' } },
        required: ['sl', 'qtyA', 'qtyB', 'locationA', 'locationB'] } },
    { name: 'remove_line', description: 'Remove a line. Buyer must confirm first.',
      parameters: { type: 'object', properties: { sl: { type: 'number' }, qty: { type: 'number' } }, required: [] } },
    { name: 'set_header', description: 'Set a header field (title, buying_unit, consignee_address, dates...).',
      parameters: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'] } },
  ];
}

export function drafterExecutors(catalog, getDraft, setDraft) {
  const working = () => getDraft().rfx;
  const commit = (res) => {
    setDraft(d => {
      d.rfx = res.rfx;
      d.specConflict = catalog.specConflictFor(res.rfx.lines);
    });
    return { ok: true, edit: res.edit.detail, lines: res.rfx.lines.length };
  };
  const libQuestion = (id) => catalog.questionBank().find(q => q.id === id);
  return {
    search_catalog: ({ query }) => ({ results: catalog.searchLineItems(query).slice(0, 25) }),
    get_item: ({ ref, part_number }) => ({ item: catalog.getItem(ref || part_number) }),
    get_terms: () => ({ terms: catalog.terms({}) }),
    get_questions: () => {
      const byId = Object.fromEntries(catalog.questionBank().map(q => [q.id, q]));
      const recommended = catalog.questions().map(q => byId[q.id]).filter(Boolean);
      return { recommended, full_bank: catalog.questionBank() };
    },
    get_header_fields: () => ({ fields: catalog.headerSlots() }),
    set_draft_lines: ({ lines }) => {
      // Imported catalog lines are NOT buyer edits — buyer_edited stays false.
      const full = lines.map(l => {
        const item = catalog.getItem(l.catalog_ref || l.part_number);
        if (!item) throw new Error(`unknown catalog ref: ${l.catalog_ref || l.part_number}`);
        return normalizeLine({ ...item, quantity_nos: l.quantity_nos,
          delivery_location: l.delivery_location, delivery_schedule: l.delivery_schedule }, 0);
      });
      const base = working();
      const rfx = { ...base, lines: full.map((l, i) => ({ ...l, sl: i + 1 })),
        history: [...base.history, { at: new Date().toISOString(), kind: 'edit', detail: `Draft lines set from catalog: ${full.length} lines` }] };
      setDraft(d => { d.rfx = rfx; d.specConflict = catalog.specConflictFor(rfx.lines); });
      const c = catalog.specConflictFor(rfx.lines);
      return { ok: true, edit: `Draft lines set from catalog: ${rfx.lines.length} lines`,
               lines: rfx.lines.length, spec_conflict: c };
    },
    set_draft_questions: ({ question_ids }) => {
      const base = working();
      const add = [];
      for (const id of (question_ids || [])) {
        if (base.questions.some(q => q.id === id)) continue;
        const lib = libQuestion(id);
        if (!lib) throw new Error(`unknown question id: ${id}`);
        // Inclusion is NOT sign-off: questions enter needing the buyer's
        // review on the Review screen, exactly like commercial terms.
        add.push({ id: lib.id, question: lib.question, coverage: lib.coverage, origin: 'library', status: 'needs-review' });
      }
      if (!add.length) return { ok: true, added: [], total: base.questions.length };
      let rfx = base;
      for (const q of add) rfx = applyEdit(rfx, { kind: 'addQuestion', question: q }).rfx;
      setDraft(d => { d.rfx = rfx; });
      return { ok: true, edit: `Questionnaire set: ${add.map(q => q.id).join(', ')} (${rfx.questions.length} questions, needing review)`,
               added: add.map(q => ({ id: q.id, text: q.question })), total: rfx.questions.length,
               note: 'Summarize this confirmation from the added list above — never from the proposal prose.' };
    },
    add_custom_question: ({ text }) => {
      if (!text || !String(text).trim()) throw new Error('add_custom_question needs the buyer\'s exact wording');
      const res = applyEdit(working(), { kind: 'addCustomQuestion', text: String(text).trim() });
      setDraft(d => { d.rfx = res.rfx; });
      return { ok: true, edit: res.edit.detail, total: res.rfx.questions.length };
    },
    edit_question: ({ id, text }) => commit(applyEdit(working(), { kind: 'editQuestion', id, text })),
    omit_question: ({ id }) => commit(applyEdit(working(), { kind: 'omitQuestion', id })),
    restore_question: ({ id }) => commit(applyEdit(working(), { kind: 'restoreQuestion', id })),
    set_draft_terms: ({ term_ids }) => {
      const base = working();
      const add = [];
      for (const id of (term_ids || [])) {
        if (base.terms.some(t => t.id === id)) continue;
        const src = catalog.termSource(id);
        if (!src) throw new Error(`unknown term id: ${id}`);
        // Resolve dynamic slots from the draft's own lines now. Anything that
        // cannot be resolved stays literal so the placeholder scan blocks
        // publishing until the fact is supplied.
        const { text, unresolved } = resolveTermSlots(src.text, base.lines);
        add.push({ id, text, source_text: src.text, coverage: src.coverage || [],
                   conditional: src.conditional || null, origin: 'library', status: 'needs-review' });
        void unresolved;
      }
      if (!add.length) return { ok: true, added: 0, total: base.terms.length };
      let rfx = base;
      for (const t of add) rfx = applyEdit(rfx, { kind: 'addTerm', term: t }).rfx;
      setDraft(d => { d.rfx = rfx; });
      return { ok: true, edit: `Commercial terms added as draft content needing review: ${add.map(t => t.id).join(', ')}`,
               added: add.map(t => t.id), total: rfx.terms.length };
    },
    edit_term: ({ id, text }) => commit(applyEdit(working(), { kind: 'editTerm', id, text })),
    omit_term: ({ id }) => commit(applyEdit(working(), { kind: 'omitTerm', id })),
    restore_term: ({ id }) => commit(applyEdit(working(), { kind: 'restoreTerm', id })),
    mark_terms_reviewed: () => commit(applyEdit(working(), { kind: 'markTermsReviewed' })),
    mark_questions_reviewed: () => commit(applyEdit(working(), { kind: 'markQuestionsReviewed' })),
    edit_line_qty: ({ sl, qty }) => commit(applyEdit(working(), { kind: 'setQty', sl, qty })),
    edit_line: ({ sl, delivery_location, delivery_schedule }) =>
      commit(applyEdit(working(), { kind: 'setLineFields', sl, delivery_location, delivery_schedule })),
    add_line: ({ line }) => {
      // Resolve the catalog item so the added line keeps its official part
      // number (nullable only for the six KGF 7-ply items). Buyer-specified
      // fields (qty, location, schedule) take precedence over catalog reference values.
      const item = line && line.catalog_ref ? catalog.getItem(line.catalog_ref) : null;
      const full = item ? { ...item, ...line } : line;
      return commit(applyEdit(working(), { kind: 'addLine', line: full }));
    },
    split_line: ({ sl, qtyA, qtyB, locationA, locationB }) =>
      commit(applyEdit(working(), { kind: 'splitLine', sl, qtyA, qtyB, locA: locationA, locB: locationB })),
    remove_line: ({ sl }) => commit(applyEdit(working(), { kind: 'removeLine', sl })),
    set_header: ({ field, value }) => {
      // The model sometimes guesses a near-miss field name (bid_due_date for
      // bid_due_datetime). Normalize known aliases so buyer-stated facts land
      // in the slot the publish gate actually checks.
      const key = String(field || '').toLowerCase().replace(/-/g, '_');
      const f = {
        bid_due_date: 'bid_due_datetime', bid_due: 'bid_due_datetime',
        due_date: 'bid_due_datetime', due_datetime: 'bid_due_datetime',
        buying_division: 'buying_unit', division: 'buying_unit',
        consignee: 'consignee_address', channel: 'distribution_channel',
        submission_channel: 'distribution_channel',
      }[key] || field;
      return commit(applyEdit(working(), { kind: 'setHeader', field: f, value }));
    },
  };
}

export async function runDrafterTurn({ store, catalog, settings }, userText) {
  const draft = store.get().draft;
  if (!draft) throw new Error('no draft started');
  const messages = [...draft.messages, { role: 'user', content: userText }];
  const getDraft = () => store.get().draft;
  const setDraft = (fn) => store.update(s => fn(s.draft));

  const { text, messages: full } = await runToolLoop(settings, {
    system: DRAFTER_SYSTEM,
    messages,
    tools: drafterTools(),
    executors: drafterExecutors(catalog, getDraft, setDraft),
  });

  store.update(s => {
    s.draft.messages = apiTranscript(full);
  });
  return text;
}
