// Aerchain co-pilot UI. Renders the engine's store into the v4 screen structure.
// Engine never touches the DOM; this file never does normalization math.

import { createStore } from '../engine/store.js';
import { captureLive, clearLive, activateLive, deleteProject } from '../engine/project-state.js';
import { connectSharedWorkspace, loadWorkspace, saveWorkspace, uploadOriginal, downloadOriginal } from '../engine/shared-cloud.js';
import { createCatalog } from '../engine/catalog.js';
import { publishRfx, rfxToMarkdown, validateForPublish, applyEdit, deliveryLocationGroups } from '../engine/composer.js';
import { startDraft, runDrafterTurn } from '../engine/drafter.js';
import { runAnalystTurn, runIntake, runEvidenceReview } from '../engine/analyst.js';
import { routeFile, loadDemoFile } from '../engine/intake/extractors.js';
import { vendorTotals, lowestOnCommonSet, cheapestPerLine, lineValue, confirmPartMatch, quotedLineCount } from '../engine/intake/normalize.js';
import { displayMessages } from '../engine/loop.js';
import { renderChatText } from './chat-format.js';
import { DEFAULT_SETTINGS, VENDORS } from '../engine/config.js';
import { deriveVendorReviewStatus, responseEvidenceGaps, isActionablePriceFlag, comparableCalculation, conversionRuleText } from './response-view.js';
import { matchedAnswerSet, deterministicEvidence, QUALIFICATION_STATUSES, buildAwardProposal, migrateV6ReviewState, qualificationGapCount, validateQualificationTransition, applyQualificationTransition } from '../engine/qualification.js';
import { alignDemoPsuQuestion } from '../engine/migrate.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = n => n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let store, catalog, activeScreen = 's-home', cmpMode = 'comparable', deleteTarget = null;

async function boot(client) {
  const data = await (await fetch('data/catalog-seed.json')).json();
  catalog = createCatalog(data);
  const remote = await loadWorkspace(client);
  let revision = remote.revision || 0;
  let cloudConflict = false;
  let saveQueue = Promise.resolve();
  const saved = remote.state ? alignDemoPsuQuestion(migrateV6ReviewState(remote.state), catalog) : null;
  store = createStore({
    load: () => saved,
    save: s => {
      if (cloudConflict) return saveQueue;
      const snapshot = structuredClone(s);
      saveQueue = saveQueue.then(async () => {
        if (cloudConflict) return;
        const result = await saveWorkspace(client, snapshot, revision);
        if (result.conflict) {
          cloudConflict = true;
          if (confirm('A newer workspace version exists on the server. Reload it now? Your unsaved local changes will be lost.')) location.reload();
          else toast('This session can no longer save. Reload before continuing.');
          return;
        }
        revision = result.revision;
        const banner = $('#cloudSaveError');
        if (banner) banner.hidden = true;
      }).catch(err => {
        console.error('[aerchain] cloud save failed', err);
        showCloudSaveError();
      });
      return saveQueue;
    },
  });
  // settings live in the store; apiKey starts empty every load (memory only)
  store.update(s => { s.settings = { ...DEFAULT_SETTINGS, ...s.settings, apiKey: '' }; });
  document.body.classList.remove('auth-locked');
  $('#authGate').hidden = true;
  $('#headerSignout').hidden = false;

  $$('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  $('#createRfx').addEventListener('click', newDraft);
  $('#discardDraft').addEventListener('click', () => {
    if (confirm('Discard this draft?')) { store.set({ draft: null }); go('s-home'); }
  });
  $('#draftForm').addEventListener('submit', sendDraft);
  $('#analystForm').addEventListener('submit', e => { e.preventDefault(); sendAnalystText($('#analystInput').value.trim()); });
  $('#publishBtn').addEventListener('click', publish);
  $('#exportMd').addEventListener('click', exportMd);
  $('#loadAllDemo').addEventListener('click', loadAllDemo);
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#settingsClose').addEventListener('click', () => $('#settingsModal').classList.remove('show'));
  $('#settingsSave').addEventListener('click', saveSettings);
  $('#rawClose').addEventListener('click', () => $('#rawModal').classList.remove('show'));
  $('#rawClose2').addEventListener('click', () => $('#rawModal').classList.remove('show'));
  $('#exportRfxBundle').addEventListener('click', exportRfxBundle);
  $('#reviewRespBtn').addEventListener('click', () => go('s-intake'));
  $('#analystBtn').addEventListener('click', () => go('s-analysis'));
  $('#deleteRfxBtn').addEventListener('click', deleteRfx);
  document.body.appendChild($('#deleteRfxModal'));
  $('#deleteRfxCancel').addEventListener('click', () => { deleteTarget = null; $('#deleteRfxModal').classList.remove('show'); });
  $('#deleteRfxConfirm').addEventListener('click', confirmDeleteRfx);
  $('#buildAward').addEventListener('click', buildAward);
  $('#confirmAward').addEventListener('click', openAwardConfirmation);
  $('#awardCancel').addEventListener('click', () => {
    const completed = $('#awardCancel').dataset.completed === 'true';
    $('#awardModal').classList.remove('show');
    if (completed) { $('#awardCancel').dataset.completed = 'false'; go('s-home'); }
  });
  $('#awardConfirmButton').addEventListener('click', confirmAward);
  $('#reviewProposalBatch').addEventListener('click', openProposalBatch);
  $('#proposalCancel').addEventListener('click', () => $('#proposalModal').classList.remove('show'));
  $('#proposalConfirm').addEventListener('click', applyProposalBatch);
  $$('#basisToggle button').forEach(b => b.addEventListener('click', () => {
    cmpMode = b.dataset.mode;
    $$('#basisToggle button').forEach(x => x.classList.toggle('on', x === b));
    renderAnalysis();
  }));
  $('#reviewDoc').addEventListener('click', onReviewClick);
  $('#fltSearch').addEventListener('input', () => renderIntake());
  $('#fltIssue').addEventListener('change', () => renderIntake());
  $('#fltSort').addEventListener('change', () => renderIntake());
  $('#lineSearch').addEventListener('input', () => renderAnalysis());
  $('#issuesOnly').addEventListener('change', () => renderAnalysis());
  document.addEventListener('click', e => {
    const picker = $('#vendorPicker');
    if (picker && !picker.contains(e.target)) setVendorPickerOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#vendorPickerPop') && !$('#vendorPickerPop').hidden) {
      setVendorPickerOpen(false);
      $('#vendorPickerTrigger')?.focus();
    }
  });

  store.subscribe(() => { renderScreen(activeScreen); });
  window.__ac_go = go; // smoke-test hook: drive the router without a mouse
  renderScreen('s-home');
}

function showCloudSaveError() {
  const banner = $('#cloudSaveError');
  if (banner) banner.hidden = false;
}

function go(id) {
  // Review and analysis need a published RFx with ingested responses; the
  // screens themselves render a clean empty state if reached directly.
  if ((id === 's-intake' || id === 's-analysis') && !store.get().rfx) {
    toast('Publish an RFx first.');
    return;
  }
  activeScreen = id;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  renderScreen(id);
  window.scrollTo(0, 0);
}

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- settings ----------
function openSettings(note) {
  const s = store.get().settings;
  $('#setBaseUrl').value = s.baseUrl;
  $('#setModel').value = s.model;
  $('#setKey').value = '';
  $('#setFx').value = s.usdInr;
  $('#setFxDate').value = s.usdInrAsOf;
  $('#setGst').value = s.gstRate;
  renderDemoData();
  $('#settingsModal').classList.add('show');
  if (note) toast(note);
}

// Settings → Demo data: secondary utility, scoped to the published RFx.
// Loading a bundle starts intake directly.
function renderDemoData() {
  const s = store.get();
  const r = s.rfx;
  $('#demoRfxLine').textContent = r
    ? `Target: ${r.title} · ${rfxIdLine(r)}`
    : 'Publish an RFx first — bundles load into the live RFx.';
  $('#demoVendorList').innerHTML = VENDORS.map(v => {
    const st = s.intake[v.id];
    const status = deriveVendorReviewStatus(st, s.confirmations);
    const [label, cls] = PILL[status] || PILL.waiting;
    const busy = status === 'reading';
    return `<div class="demo-vendor"><div><b>${esc(v.name)}</b><div class="sub">${esc(v.file)}</div></div>
      <div class="btnrow"><span class="pill ${cls}">${label}</span>
      ${r ? `<button class="btn sm ghost" data-ddemo="${v.id}" ${busy ? 'disabled' : ''}>Load sample</button>
      <label class="btn sm ghost ${busy ? 'disabled' : ''}" style="cursor:${busy ? 'not-allowed' : 'pointer'}">Upload<input type="file" data-dup="${v.id}" ${busy ? 'disabled' : ''} hidden></label>` : ''}
      </div></div>`;
  }).join('');
  $$('#demoVendorList [data-ddemo]').forEach(b => b.addEventListener('click', async () => {
    if (needKey()) return;
    const id = b.dataset.ddemo;
    markVendorReading(id);
    renderDemoData();
    const result = await demoLoad(id);
    renderScreen(activeScreen);
    renderDemoData();
    if (result?.ok) toast(`${vendorById(id)?.name || id}: quotation read.`);
    else if (result?.error) toast(`${vendorById(id)?.name || id}: ${result.error}`);
  }));
  $$('#demoVendorList [data-dup]').forEach(i => i.addEventListener('change', async () => {
    if (i.files[0]) {
      if (needKey()) return;
      const id = i.dataset.dup;
      markVendorReading(id);
      renderDemoData();
      const result = await uploadFile(id, i.files[0]);
      renderScreen(activeScreen);
      renderDemoData();
      if (result?.ok) toast(`${vendorById(id)?.name || id}: quotation read.`);
      else if (result?.error) toast(`${vendorById(id)?.name || id}: ${result.error}`);
    }
  }));
}
function markVendorReading(vendorId) {
  store.update(s => {
    const prev = s.intake[vendorId];
    s.intake[vendorId] = { ...(prev || {}), vendorId, status: 'reading', previousIntake: prev ? { ...prev, previousIntake: undefined } : null, vendorName: prev?.vendorName || vendorById(vendorId)?.name };
  });
}
function saveSettings() {
  const key = $('#setKey').value.trim();
  store.update(s => {
    s.settings.baseUrl = $('#setBaseUrl').value.trim() || DEFAULT_SETTINGS.baseUrl;
    s.settings.model = $('#setModel').value.trim() || DEFAULT_SETTINGS.model;
    if (key) s.settings.apiKey = key;
    s.settings.usdInr = parseFloat($('#setFx').value) || s.settings.usdInr;
    s.settings.usdInrAsOf = $('#setFxDate').value || s.settings.usdInrAsOf;
    s.settings.gstRate = parseFloat($('#setGst').value) || s.settings.gstRate;
  });
  $('#settingsModal').classList.remove('show');
  toast('Settings saved. The key stays in memory only.');
  queuePendingEvidenceReviews();
}
function needKey() {
  if (!store.get().settings.apiKey) { openSettings('Paste your API key to continue — it is never saved.'); return true; }
  return false;
}

// Apply a composer edit to the draft from the UI (Review screen controls).
// Every change flows through the same deterministic edit path as the chat tools.
function draftEdit(edit) {
  const d = store.get().draft;
  if (!d) { toast('Draft an RFx first.'); return; }
  try {
    const res = applyEdit(d.rfx, edit);
    store.update(s => {
      s.draft.rfx = res.rfx;
      s.draft.specConflict = catalog.specConflictFor(res.rfx.lines);
    });
    toast(res.edit.detail + '.');
  } catch (err) { toast(`Couldn't apply that change: ${err.message}`); }
}

function statusPill(item) {
  if (item.omitted) return '<span class="pill p-mut">omitted</span>';
  if (item.status === 'reviewed') return '<span class="pill p-ok">reviewed</span>';
  return '<span class="pill p-flag">needs review</span>';
}

function originTag(item) {
  if (item.origin === 'buyer') return ' <span class="pill p-add">buyer-authored</span>';
  if (item.origin === 'adapted') return ' <span class="sub">adapted</span>';
  return '';
}
function publishedOrigin(item) {
  if (item.origin === 'buyer') return `<span class="clause-provenance">Buyer-authored</span>`;
  if (item.origin === 'adapted') return `<span class="clause-provenance">Adapted wording</span>`;
  return '';
}

function rfxIdLine(r) {
  // Every published RFx carries a unique internal ID; the GeM bid number
  // appears only on GeM-channel RFx.
  return esc(r.internal_id || r.id) + (r.gem_bid_number ? ` · GeM ${esc(r.gem_bid_number)}` : '');
}

function deliveryGroupsHtml(lines) {
  const groups = deliveryLocationGroups(lines);
  if (!groups.length) return '<span class="sub">No lines yet</span>';
  return groups.map(g => `<div><b>${esc(g.location)}</b> <span class="sub">— lines ${esc(g.range)}</span></div>`).join('');
}

// ---------- 1 · pipeline home ----------
function deleteIcon(label, attribute, value) {
  return `<button class="btn sm ghost danger delete-icon" type="button" ${attribute}="${esc(value)}" aria-label="Delete ${esc(label)}" title="Delete ${esc(label)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 4h4m-8 3 1 13h10l1-13M10 11v6m4-6v6"/></svg></button>`;
}

function renderHome() {
  const s = store.get();
  const live = $('#liveList'), drafts = $('#draftList');
  const liveEntries = [
    ...(s.rfx ? [{ project: captureLive(s), parkedIndex: -1 }] : []),
    ...(s.otherLive || []).map((project, parkedIndex) => ({ project, parkedIndex })),
  ];
  live.innerHTML = liveEntries.length ? `<div class="hscroll"><table class="pipeline-table"><thead><tr><th>RFx</th><th>Stage</th><th>Responses</th><th>Needs attention</th><th>Next step</th></tr></thead><tbody>${liveEntries.map(({ project, parkedIndex }) => {
    const r = project.rfx;
    const received = Object.values(project.intake || {}).filter(st => st?.normalized);
    const lineResp = received.reduce((sum, st) => sum + (st.normalized.lines || []).filter(l => l.normalized_inr_incl_gst != null).length, 0);
    const pending = (project.confirmations || []).filter(c => c.status === 'pending').length;
    const stagePill = received.length ? '<span class="pill p-info">Live · reviewing responses</span>' : '<span class="pill p-mut">Waiting for responses</span>';
    const review = received.length ? `<button class="btn sm" data-open-live="${parkedIndex}" data-dest="s-intake">Review responses</button>` : `<button class="btn sm" disabled title="Available after the first vendor response is loaded">Review responses</button>`;
    return `<tr><td><b>${esc(r.title)}</b><br><span class="sub">${rfxIdLine(r)} · ${r.lines.length} lines</span></td><td>${stagePill}</td><td>${received.length} received · ${lineResp}/${received.length * r.lines.length || r.lines.length} line responses</td><td>${pending ? `${pending} buyer check${pending > 1 ? 's' : ''} pending` : 'Nothing pending'}</td><td><div class="project-actions">${review}<button class="btn sm ghost" data-open-live="${parkedIndex}" data-dest="s-published">Open RFx</button>${deleteIcon(r.title, 'data-delete-live', r.internal_id)}</div></td></tr>`;
  }).join('')}</tbody></table></div>` : `<div class="empty">No live RFx yet. Draft one and publish it to start tracking responses.</div>`;
  live.querySelectorAll('[data-open-live]').forEach(el => el.addEventListener('click', () => {
    const parkedIndex = Number(el.dataset.openLive);
    if (parkedIndex >= 0) store.update(state => activateLive(state, parkedIndex));
    go(el.dataset.dest);
  }));
  live.querySelectorAll('[data-delete-live]').forEach(el => el.addEventListener('click', () => {
    const id = el.dataset.deleteLive;
    const entry = liveEntries.find(x => x.project.rfx.internal_id === id);
    if (entry) openDeleteModal({ kind: 'live', id, active: entry.parkedIndex === -1 });
  }));

  if (s.draft) {
    const d = s.draft.rfx;
    drafts.innerHTML = `<div class="rfx"><div><h3>${esc(d.title)}</h3><div><span class="pill p-info">Saved draft</span><span class="pill p-mut">${d.lines.length} proposed lines</span></div><div class="meta">Continue the conversation or review the RFx before publishing.</div></div><div class="cta project-actions"><button class="btn ghost" data-go="s-draft">Continue draft</button>${deleteIcon(d.title || 'draft', 'data-delete-draft', 'true')}</div></div>`;
  } else {
    drafts.innerHTML = `<div class="empty">No saved drafts. Create one to see how saving and returning works.</div>`;
  }
  drafts.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  drafts.querySelector('[data-delete-draft]')?.addEventListener('click', () => openDeleteModal({ kind: 'draft' }));
  const completed = s.completed || [];
  $('#completedList').className = completed.length ? '' : 'empty';
  $('#completedList').innerHTML = completed.length ? completed.map((x, index) => `<div class="rfx"><div><b>${esc(x.title)}</b><div class="meta">${esc(x.rfx?.internal_id || x.id)} · ${x.lineCount} lines · ${x.vendorCount} awarded vendors</div></div><div class="project-actions"><span class="pill p-ok">Completed · awarded</span>${deleteIcon(x.title, 'data-delete-completed', index)}</div></div>`).join('') : 'No completed RFx yet.';
  $('#completedList').querySelectorAll('[data-delete-completed]').forEach(el => el.addEventListener('click', () => {
    const x = completed[Number(el.dataset.deleteCompleted)];
    if (x) openDeleteModal({ kind: 'completed', completedAt: x.completedAt });
  }));
}

function newDraft() {
  if (!store.get().draft) store.set({ draft: startDraft(catalog) });
  go('s-draft');
}

// ---------- 2 · drafter ----------
function renderDraft() {
  const d = store.get().draft;
  if (!d) { $('#draftChat').innerHTML = `<div class="empty">No draft. <a href="#" id="startFresh">Start one</a>.</div>`;
    $('#startFresh')?.addEventListener('click', e => { e.preventDefault(); newDraft(); }); return; }

  const historyChat = displayMessages(d.historyChat || []);
  $('#draftChat').innerHTML =
    (historyChat.length ? `<details class="raw"><summary>Earlier conversation (read-only)</summary>` +
      historyChat.map(m => `<div class="msg ${m.role === 'user' ? 'buyer' : 'bot'}"><span class="who">${m.role === 'user' ? 'Buyer' : 'Co-pilot'}</span>${renderChatText(m.content)}</div>`).join('') +
      `</details>` : '') +
    displayMessages(d.messages)
      .map(m => `<div class="msg ${m.role === 'user' ? 'buyer' : 'bot'}"><span class="who">${m.role === 'user' ? 'Buyer' : 'Co-pilot'}</span>${renderChatText(m.content)}</div>`)
      .join('');
  $('#draftChat').scrollTop = $('#draftChat').scrollHeight;

  const rfx = d.rfx;
  $('#draftLineCount').textContent = `${rfx.lines.length} lines`;
  $('#draftHeaderMeta').innerHTML =
    `Buying unit: <b>${esc(rfx.header.buying_unit || 'Not set')}</b> · Bid due: <b>${esc(rfx.header.bid_due_datetime || 'Not set')}</b>` +
    `<div style="margin-top:6px"><b>Delivery locations</b><div>${deliveryGroupsHtml(rfx.lines)}</div></div>`;
  const conflictLine = d.specConflict
    ? rfx.lines.find(l => (l.official_part_number || l.catalog_ref) === d.specConflict.part_number) : null;
  $('#draftSpecFlag').innerHTML = d.specConflict ? `<div class="banner warn"><h3>Specification needs resolution</h3><p>Line ${conflictLine ? conflictLine.sl : ''} (${esc(String(d.specConflict.part_number))}) is listed at ${d.specConflict.listed_gsm} GSM while the source specification says ${d.specConflict.spec_text_gsm} GSM. Keeping the listed value confirms the line item; it does not create a final spec sheet.</p></div>` : '';
  const partCell = l => {
    const pn = l.official_part_number || l.catalog_ref || '—';
    const note = l.official_part_number ? '' : '<div class="sub">Part number not supplied in source</div>';
    return `${esc(pn)}${note}`;
  };
  $('#draftPreview tbody').innerHTML = rfx.lines.map(l => `<tr${(l.official_part_number || l.catalog_ref) === 'JTM0103995148' ? ' class="flagged"' : ''}>
    <td>${l.sl}</td><td>${partCell(l)}</td><td class="num">${l.quantity_nos}</td>
    <td>${esc(l.delivery_location || 'Not set')}</td><td>${l.buyer_edited ? '<span class="pill p-add">Buyer edited</span>' : '<span class="sub">Catalog</span>'}</td></tr>`).join('')
    || `<tr><td colspan="5" class="sub">No lines yet — tell the co-pilot what you need.</td></tr>`;

  // Questionnaire — full content on the right; chat never recites the list.
  const liveQ = (rfx.questions || []).filter(q => !q.omitted);
  $('#draftQCount').textContent = `${liveQ.length} questions`;
  $('#draftQuestionPreview').innerHTML = liveQ.length
    ? `<ol style="margin:6px 0;padding-left:20px">${liveQ.map(q => `<li>${esc(q.text)}${originTag(q)} ${statusPill(q)}</li>`).join('')}</ol>`
    : `<span class="sub">No questions yet — the source library is available, but nothing is part of this RFx until you agree the questionnaire.</span>`;

  // Commercial terms — draft content needing review, full text on the right.
  const liveT = (rfx.terms || []).filter(t => !t.omitted);
  $('#draftTCount').textContent = `${liveT.length} clauses`;
  $('#draftTermsPreview').innerHTML = liveT.length
    ? `<ol style="margin:6px 0;padding-left:20px">${liveT.map(t => `<li>${esc(t.text)}${originTag(t)} ${statusPill(t)}</li>`).join('')}</ol>`
    : `<span class="sub">No terms yet — applicable core terms are added as draft content needing your review once the scope is set.</span>`;
}

async function sendDraft(e) {
  e.preventDefault();
  const input = $('#draftInput');
  const text = input.value.trim();
  if (!text || needKey()) return;
  input.value = '';
  const chat = $('#draftChat');
  chat.insertAdjacentHTML('beforeend', `<div class="msg buyer"><span class="who">Buyer</span>${renderChatText(text)}</div>`);
  chat.insertAdjacentHTML('beforeend', `<div class="msg bot thinking" id="think"><span class="who">Co-pilot</span>…</div>`);
  chat.scrollTop = chat.scrollHeight;
  try {
    await runDrafterTurn({ store, catalog, settings: store.get().settings }, text);
  } catch (err) {
    store.update(s => { s.draft.messages.push({ role: 'assistant', content: `I couldn't complete that turn (${err.message}). Your draft is unchanged — try again.` }); });
  }
  renderDraft();
}

// ---------- 3 · review ----------
function revItemRow(kind, item, i) {
  const idAttr = esc(item.id);
  const editAct = kind === 'q' ? 'qedit' : 'tedit';
  const omitAct = kind === 'q' ? (item.omitted ? 'qrestore' : 'qomit') : (item.omitted ? 'trestore' : 'tomit');
  const saveAct = kind === 'q' ? 'qsave' : 'tsave';
  return `<li class="rev-item${item.omitted ? ' is-omitted' : ''}" data-rid="${idAttr}">
    <div class="rev-text"><span class="rev-n">${i + 1}.</span> ${esc(item.text)}${originTag(item)} ${statusPill(item)}</div>
    <div class="btnrow rev-actions">
      ${item.omitted ? '' : `<button class="btn sm ghost" data-act="${editAct}" data-id="${idAttr}">Edit</button>`}
      <button class="btn sm ghost" data-act="${omitAct}" data-id="${idAttr}">${item.omitted ? 'Restore' : 'Omit'}</button>
    </div>
    <div class="rev-editor" hidden><textarea rows="3" aria-label="Edit text"></textarea>
      <div class="btnrow"><button class="btn sm" data-act="${saveAct}" data-id="${idAttr}">Save</button>
      <button class="btn sm ghost" data-act="cancel" data-id="${idAttr}">Cancel</button></div>
      <p class="note">Saving sends this wording back for review.</p></div>
  </li>`;
}

function renderReview() {
  const d = store.get().draft;
  const el = $('#reviewDoc');
  if (!d) { el.innerHTML = `<div class="empty">No draft to review.</div>`; return; }
  const r = d.rfx;
  const conflictLine = d.specConflict
    ? r.lines.find(l => (l.official_part_number || l.catalog_ref) === d.specConflict.part_number) : null;
  const partCell = l => {
    const pn = l.official_part_number || l.catalog_ref || '—';
    const note = l.official_part_number ? '' : '<div class="sub">Part number not supplied in source</div>';
    return `${esc(pn)}${note}`;
  };
  const missing = validateForPublish(r);
  const noTermsBlock = missing.some(m => m.startsWith('No commercial terms included'));
  const liveQ = (r.questions || []).filter(q => !q.omitted);
  const liveT = (r.terms || []).filter(t => !t.omitted);
  const omitQ = (r.questions || []).filter(q => q.omitted);
  const omitT = (r.terms || []).filter(t => t.omitted);
  const pendQ = liveQ.filter(q => q.status !== 'reviewed').length;
  const pendT = liveT.filter(t => t.status !== 'reviewed').length;

  el.innerHTML = `
  ${d.specConflict ? `<div class="banner warn"><h3>Specification needs resolution</h3><p>Line ${conflictLine ? conflictLine.sl : ''} (${esc(d.specConflict.part_number)}) is listed at 340 GSM while the source specification says 150 GSM. This is a flag, not a block — publishing keeps the listed 340 GSM until you resolve it.</p></div>` : ''}
  ${missing.length ? `<div class="banner warn"><h3>Not ready to publish</h3><p>Publishing is blocked until these are resolved:</p><ul>${missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
    ${noTermsBlock ? `<div class="btnrow" style="margin-top:8px"><button class="btn sm" data-act="confirmNoTerms">Record decision: issue without commercial terms</button></div>` : ''}</div>` : ''}
  <div class="card"><div class="rowhead"><h2>${esc(r.title)}</h2><span class="pill p-info">Draft · not published</span></div>
    <div class="field"><label>RFx title</label><input id="revTitle" value="${esc(r.title)}"></div>
    <div class="field"><label>Buying unit</label><input id="revBuyingUnit" value="${esc(r.header.buying_unit || '')}" placeholder="Not set"></div>
    <div class="field"><label>Bid due (YYYY-MM-DD)</label><input id="revBidDue" value="${esc(r.header.bid_due_datetime || '')}" placeholder="Not set"></div>
    <div class="field"><label>Consignee (only if the final document requires it)</label><input id="revConsignee" value="${esc(r.header.consignee_address || '')}" placeholder="Not set"></div>
    <div class="btnrow"><button class="btn sm" data-act="saveHeader">Save header</button></div></div>
  <div class="card"><div class="rowhead"><h2>Delivery locations</h2><span class="pill p-info">grouped from lines</span></div>
    ${deliveryGroupsHtml(r.lines)}</div>
  <div class="card"><div class="rowhead"><h2>Line items</h2><span class="pill p-info">${r.lines.length} lines</span></div>
    <div class="hscroll"><table><thead><tr><th>Line</th><th>Part</th><th>Description</th><th>Qty</th><th>Delivery</th></tr></thead><tbody>
    ${r.lines.map(l => `<tr><td>${l.sl}</td><td>${partCell(l)}</td><td>${esc(l.description)}</td><td class="num">${l.quantity_nos}</td><td>${esc(l.delivery_location || 'Not set')}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note">Line changes go through the co-pilot chat so quantities stay confirmed.</p></div>
  <div class="card"><div class="rowhead"><h2>Commercial terms</h2><span class="pill ${pendT ? 'p-flag' : 'p-mut'}">${liveT.length} clauses${pendT ? ` · ${pendT} need review` : ''}</span></div>
    ${pendT ? `<div class="btnrow" style="margin-bottom:8px"><button class="btn sm" data-act="markT">Mark all terms reviewed</button></div>` : ''}
    ${liveT.length ? `<ol class="rev-list">${liveT.map((t, i) => revItemRow('t', t, i)).join('')}</ol>`
      : `<div class="empty">No commercial terms included.</div>`}</div>
  ${omitT.length ? `<div class="card"><div class="rowhead"><h2>Omitted terms</h2><span class="pill p-mut">${omitT.length} omitted</span></div>
    <ol class="rev-list">${omitT.map((t, i) => revItemRow('t', t, i)).join('')}</ol></div>` : ''}
  <div class="card"><div class="rowhead"><h2>Vendor questionnaire</h2><span class="pill ${pendQ ? 'p-flag' : 'p-mut'}">${liveQ.length} questions${pendQ ? ` · ${pendQ} need review` : ''}</span></div>
    ${pendQ ? `<div class="btnrow" style="margin-bottom:8px"><button class="btn sm" data-act="markQ">Mark all questions reviewed</button></div>` : ''}
    ${liveQ.length ? `<ol class="rev-list">${liveQ.map((q, i) => revItemRow('q', q, i)).join('')}</ol>`
      : `<div class="empty">No questions yet — agree the questionnaire with the co-pilot first.</div>`}</div>
  ${omitQ.length ? `<div class="card"><div class="rowhead"><h2>Omitted questions</h2><span class="pill p-mut">${omitQ.length} omitted</span></div>
    <ol class="rev-list">${omitQ.map((q, i) => revItemRow('q', q, i)).join('')}</ol></div>` : ''}`;
}

// Review-screen interactions (event delegation; the element persists across renders).
function onReviewClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act, id = btn.dataset.id;
  const li = btn.closest('[data-rid]');
  const editor = li?.querySelector('.rev-editor');
  const box = editor?.querySelector('textarea');
  switch (act) {
    case 'qedit': case 'tedit': {
      const item = findReviewItem(act === 'qedit' ? 'q' : 't', id);
      if (item && box) { box.value = item.text; editor.hidden = false; }
      break;
    }
    case 'qsave': case 'tsave': {
      if (box && box.value.trim()) draftEdit(act === 'qsave'
        ? { kind: 'editQuestion', id, text: box.value.trim() }
        : { kind: 'editTerm', id, text: box.value.trim() });
      break;
    }
    case 'cancel': if (editor) editor.hidden = true; break;
    case 'qomit': draftEdit({ kind: 'omitQuestion', id }); break;
    case 'qrestore': draftEdit({ kind: 'restoreQuestion', id }); break;
    case 'tomit': draftEdit({ kind: 'omitTerm', id }); break;
    case 'trestore': draftEdit({ kind: 'restoreTerm', id }); break;
    case 'markQ': draftEdit({ kind: 'markQuestionsReviewed' }); break;
    case 'markT': draftEdit({ kind: 'markTermsReviewed' }); break;
    case 'confirmNoTerms':
      if (confirm('Record an explicit buyer decision to issue this RFx without commercial terms?')) {
        draftEdit({ kind: 'setHeader', field: 'no_commercial_terms_confirmed', value: 'yes — recorded by buyer on Review' });
      }
      break;
    case 'saveHeader': {
      const v = sid => document.getElementById(sid)?.value.trim();
      const title = v('revTitle'), bu = v('revBuyingUnit'), due = v('revBidDue'), con = v('revConsignee');
      if (title) draftEdit({ kind: 'setHeader', field: 'title', value: title });
      if (bu) draftEdit({ kind: 'setHeader', field: 'buying_unit', value: bu });
      if (due) draftEdit({ kind: 'setHeader', field: 'bid_due_datetime', value: due });
      draftEdit({ kind: 'setHeader', field: 'consignee_address', value: con || '' });
      break;
    }
  }
}

function findReviewItem(kind, id) {
  const d = store.get().draft;
  if (!d) return null;
  const list = kind === 'q' ? d.rfx.questions : d.rfx.terms;
  return (list || []).find(x => x.id === id) || null;
}

function publish() {
  const d = store.get().draft;
  if (!d) { toast('Draft an RFx first.'); return; }
  let rfx;
  try {
    rfx = publishRfx(d.rfx);
  } catch (err) {
    toast(`Cannot publish — missing: ${err.missing ? err.missing.join('; ') : err.message}`);
    renderReview();
    return;
  }
  store.update(s => {
    // The draft is consumed by publishing: it must not reappear under Draft.
    rfx.specConflict = d.specConflict || null; // keep the visible 340 GSM flag on the read-only view
    if (s.rfx) s.otherLive = [...(s.otherLive || []), captureLive(s)];
    clearLive(s);
    s.rfx = rfx;
    s.draft = null;
    s.compare.vendorIds = VENDORS.map(v => v.id);
    for (const v of VENDORS) if (!s.qualification[v.id]) s.qualification[v.id] =
      { status: 'not_reviewed', rationale: '', history: [], responseVersion: 0, evidenceReview: null };
    s.award = null;
  });
  toast('RFx published. Responses will be tracked under this RFx.');
  go('s-home');
}

function exportMd() {
  const d = store.get().draft;
  if (!d) return;
  // Draft export — never a publish. Missing fields stay visible as "Not set".
  const blob = new Blob([rfxToMarkdown(d.rfx)], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rfx-draft.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportRfxBundle() {
  const r = store.get().rfx;
  if (!r) { toast('Publish an RFx first.'); return; }
  const blob = new Blob([rfxToMarkdown(r)], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rfx-bundle.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 5 · review responses ----------
const PILL = {
  waiting: ['Waiting for file', 'p-mut'],
  reading: ['Reading quotation…', 'p-info'],
  needs_review: ['Needs your check', 'p-flag'],
  ready: ['Ready to review', 'p-ok'],
  failed: ['Couldn\u2019t read — retry', 'p-flag'],
};

// Flag kinds grouped for the Missing information / Different terms filter.
const ISSUE_GROUP = {
  not_quoted: 'missing', unreadable_price: 'missing', gst_unstated: 'missing',
  part_mismatch: 'terms', basis: 'terms', fx: 'terms', gst: 'terms',
  extra_line: 'terms', rejected: 'terms',
};
const CONFIRM_GROUP = { part_match: 'terms', gst_basis: 'missing' };

function vendorById(id) { return VENDORS.find(v => v.id === id); }

// Short grouped attention summaries for one vendor: { missing: [...], terms: [...] }
function attentionSummary(st, pendingForVendor, totalLines) {
  const missing = [], terms = [];
  const push = (kind, text) => (ISSUE_GROUP[kind] === 'missing' ? missing : terms).push(text);
  for (const f of (st?.flags || [])) push(f.kind, f.text);
  for (const c of pendingForVendor) {
    if (c.kind === 'part_match') terms.push(`Part proposal: ${c.evidence?.quoted || '?'} → line ${c.evidence?.rfx_sl || '?'}`);
    else if (c.kind === 'gst_basis') missing.push(`GST basis unstated · line ${c.evidence?.rfx_sl || '?'}`);
  }
  const answers = st?.answers ? matchedAnswerSet(st.answers, store.get().rfx?.questions).count : 0;
  const hasQuestionnaire = (st?.files || []).some(f => f.kind === 'questionnaire');
  if (st?.normalized && !hasQuestionnaire) missing.push('Questionnaire file missing');
  else if (st?.normalized && !answers) {
    const totalQ = (store.get().rfx?.questions || []).filter(q => !q.omitted).length;
    missing.push(`Empty questionnaire (0/${totalQ} answered)`);
  } else if (st?.normalized) {
    const totalQ = (store.get().rfx?.questions || []).filter(q => !q.omitted).length;
    if (answers < totalQ) missing.push(`${totalQ - answers} questionnaire answers missing (${answers}/${totalQ} answered)`);
  }
  for (const f of (st?.normalized?.lines || []).filter(f => f.matched === 'missing')) missing.push(`RFx line ${f.rfx_sl} not quoted`);
  return { missing, terms };
}

function renderIntake() {
  const s = store.get();
  const r = s.rfx;
  if (!r) {
    $('#intakeHead').innerHTML = `<div class="empty">Publish an RFx first.</div>`;
    $('#intakeEmpty').innerHTML = '';
    $('#intakeMain').style.display = 'none';
    return;
  }
  $('#intakeHead').innerHTML = `<div class="rowhead"><div><h2>Vendor responses</h2>
    <p class="sub" style="margin:4px 0 0">${esc(r.title)} — ${esc(r.header?.buying_unit || '')} · ${rfxIdLine(r)}</p></div></div>`;

  // Rows are built from actually ingested responses only — never from fixed
  // vendor slots. With zero responses there is no table, no search/filter,
  // and no buyer-check queue: just a clean empty state.
  const entries = Object.values(s.intake);
  if (!entries.length) {
    $('#intakeMain').style.display = 'none';
    $('#intakeEmpty').innerHTML = `<div class="empty"><b>No responses yet.</b><br>
      <span class="sub">Load the first vendor bundle under Settings → Demo data. Review and analysis unlock as responses arrive.</span></div>`;
    return;
  }
  $('#intakeMain').style.display = '';
  $('#intakeEmpty').innerHTML = '';

  const totalQ = (r.questions || []).filter(q => !q.omitted).length;
  const received = entries.filter(st => st?.normalized);
  $('#recvPill').textContent = `${received.length} received · reviewing`;

  const allNorm = received.map(st => st.normalized);
  const { commonLines, totals } = allNorm.length ? lowestOnCommonSet(allNorm) : { commonLines: 0, totals: [] };
  $('#sharedPriceHead').textContent = `Price on ${commonLines} shared lines`;

  const q = ($('#fltSearch').value || '').toLowerCase();
  const issueF = $('#fltIssue').value || 'all';
  const sortF = $('#fltSort').value || 'name';
  const totalFor = id => totals.find(t => t.vendorId === id)?.total;

  let rows = entries.map(st => {
    const slot = vendorById(st.vendorId);
    const name = st.vendorName || slot?.name || st.vendorId;
    const n = st.normalized;
    const quoted = n ? quotedLineCount(n) : 0;
    const pending = s.confirmations.filter(c => c.vendorId === st.vendorId && c.status === 'pending');
    const att = attentionSummary(st, pending, r.lines.length);
    const answers = st.answers ? matchedAnswerSet(st.answers, r.questions).count : 0;
    const files = st.files || [];
    const hasKind = k => files.some(f => f.kind === k);
    const displayStatus = deriveVendorReviewStatus(st, s.confirmations);
    const docs = [
      hasKind('quote') ? 'Quote' : null,
      hasKind('questionnaire') ? (answers ? 'answers' : 'Empty questionnaire') : null,
      ...files.filter(f => f.kind === 'supporting').map(f => f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')),
    ].filter(Boolean).join(' + ') || '—';
    const statusPill = (() => {
      const [label, cls] = PILL[displayStatus] || PILL.waiting;
      return `<span class="pill ${cls}">${label}</span>`;
    })();
    const attLines = [...att.missing.map(t => `⚑ ${esc(t)}`), ...att.terms.map(t => `⚑ ${esc(t)}`)];
    return {
      st, n, name, quoted, answers, docs, statusPill, pending,
      att, attText: attLines.length ? attLines.slice(0, 3).join('<br>') + (attLines.length > 3 ? `<br><span class="sub">+${attLines.length - 3} more</span>` : '') : (st.status === 'failed' ? esc(st.error || 'Read failed') : '—'),
      hasMissing: att.missing.length > 0, hasTerms: att.terms.length > 0,
      total: totalFor(st.vendorId),
    };
  });

  if (q) rows = rows.filter(x => x.name.toLowerCase().includes(q));
  if (issueF !== 'all') rows = rows.filter(x => issueF === 'missing' ? x.hasMissing : x.hasTerms);
  rows.sort((a, b) =>
    sortF === 'coverage' ? b.quoted - a.quoted :
    sortF === 'price' ? (a.total ?? Infinity) - (b.total ?? Infinity) :
    a.name.localeCompare(b.name));

  $('#respTable tbody').innerHTML = rows.map(x => `<tr>
      <td><b>${esc(x.name)}</b><br>${x.statusPill}</td>
      <td class="num">${x.n ? `${x.quoted}/${r.lines.length}<div class="covbar"><i style="width:${Math.round(100 * x.quoted / r.lines.length)}%"></i></div>` : '—'}</td>
      <td class="num">${x.n ? ((x.st.files || []).some(f => f.kind === 'questionnaire') ? `${x.answers}/${totalQ} answered` : 'Questionnaire missing') : '—'}</td>
      <td>${esc(x.docs)}</td>
      <td>${x.attText}</td>
      <td class="num">${x.total != null ? fmt(x.total) : '—'}</td>
      <td>${x.n ? `<button class="btn sm ghost" data-view="${x.st.vendorId}">View response</button>` : ''}</td>
    </tr>`).join('') || `<tr><td colspan="7"><div class="empty">No vendors match this filter.</div></td></tr>`;

  $('#compareCta').innerHTML = allNorm.length
    ? `${allNorm.length === 1 ? `One response is loaded. Its quoted-line total is shown; comparison begins when another response arrives.` : `Prices cover the <b>${commonLines} lines every vendor quoted</b>. Compare quotes now; an award decision needs buyer review of technical evidence and terms.`}
       <div class="btnrow" style="margin-top:8px"><button class="btn sm" data-go="s-analysis">Compare responses →</button></div>`
    : `Load vendor bundles from Settings → Demo data to start the comparison.`;

  renderCheckGroups(s);

  // wire
  $$('#respTable [data-view]').forEach(b => b.addEventListener('click', () => showResponse(b.dataset.view)));
  $$('#compareCta [data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
}

// Buyer checks grouped by vendor × issue type, with per-issue actions.
function renderCheckGroups(s) {
  const groups = [];
  const byKey = {};
  for (const c of s.confirmations.filter(c => c.status === 'pending')) {
    const key = `${c.vendorId}|${c.kind}`;
    (byKey[key] ||= { vendorId: c.vendorId, kind: c.kind, items: [] }).items.push(c);
  }
  for (const g of Object.values(byKey)) groups.push(g);

  const openCount = s.confirmations.filter(c => c.status === 'pending').length;
  $('#checksPill').textContent = `${openCount} pending`;
  if (!groups.length) {
    $('#checksList').innerHTML = `<div class="empty">No buyer confirmations pending. Evidence gaps are listed with each response.</div>`;
    return;
  }
  $('#checksList').innerHTML = groups.map((g, gi) => {
    const v = vendorById(g.vendorId);
    if (g.kind === 'part_match') {
      const items = g.items.map(c => {
        const ev = c.evidence || {};
        const intake = s.intake[g.vendorId];
        const rec = intake?.normalized.lines.find(l => l.rfx_sl === ev.rfx_sl && l.matched === 'proposed');
        const staged = rec?.proposed_normalized_inr_incl_gst;
        return `<li><b>Quoted ${esc(ev.quoted || '?')}</b> → RFx line ${ev.rfx_sl || '?'} (${esc(ev.proposed || '')})${staged != null ? ` — staged <span class="staged">${fmt(staged)}/unit, not in totals yet</span>` : ''}
          <div class="btnrow" style="margin:6px 0"><button class="btn sm" data-cconfirm="${c.id}">Confirm mapping</button>
          <button class="btn sm ghost" data-creject="${c.id}">Reject mapping</button>
          <button class="btn sm ghost" data-cdefer="${c.id}">Defer</button></div></li>`;
      }).join('');
      return `<div class="checkgroup"><div class="rowhead"><b>${esc(v?.name || g.vendorId)} — ${g.items.length} part-number proposal${g.items.length > 1 ? 's' : ''}</b>
        <button class="btn sm ghost" data-cview="${g.vendorId}">View evidence</button></div>
        <p class="sub" style="margin:0 0 6px">Confirming a mapping moves its staged value into the comparison. Rejecting excludes the line.</p>
        <ul>${items}</ul>
        ${g.items.length > 1 ? `<div class="btnrow"><button class="btn sm ghost" data-cconfirmall="${gi}">Confirm all ${g.items.length}</button></div>` : ''}</div>`;
    }
    // vendor_name — the material's printed name vs the upload slot
    if (g.kind === 'vendor_name') {
      const items = g.items.map(c => {
        const ev = c.evidence || {};
        const conflict = ev.extracted && ev.slot;
        return `<li><b>${esc(c.title)}</b><div class="sub">${esc(c.detail || '')}</div>
          <div class="btnrow" style="margin:6px 0">${conflict
            ? `<button class="btn sm" data-cnameyes="${c.id}">Confirm “${esc(ev.extracted)}”</button><button class="btn sm ghost" data-cnameno="${c.id}">Use “${esc(ev.slot)}” instead</button>`
            : `<button class="btn sm" data-cconfirm="${c.id}">Confirm name</button><button class="btn sm ghost" data-cdefer="${c.id}">Defer</button>`}</div></li>`;
      }).join('');
      return `<div class="checkgroup"><div class="rowhead"><b>${esc(v?.name || g.vendorId)} — vendor name to confirm</b>
        <button class="btn sm ghost" data-cview="${g.vendorId}">View evidence</button></div>
        <p class="sub" style="margin:0 0 6px">The name on the submitted material is used — never silently replaced by the upload slot.</p>
        <ul>${items}</ul></div>`;
    }
    // gst_basis
    const sls = g.items.map(c => c.evidence?.rfx_sl).filter(Boolean).sort((a, b) => a - b);
    const ranges = sls.length ? ` (lines ${compactRanges(sls)})` : '';
    return `<div class="checkgroup"><div class="rowhead"><b>${esc(v?.name || g.vendorId)} — GST basis unstated · ${g.items.length} line${g.items.length > 1 ? 's' : ''}</b>
      <button class="btn sm ghost" data-cview="${g.vendorId}">View evidence</button></div>
      <p class="sub" style="margin:0 0 6px">Treated as incl. GST for comparison${ranges}. Accept the assumption or keep it pending for vendor clarification.</p>
      <div class="btnrow"><button class="btn sm" data-cacceptall="${gi}">Accept incl.-GST for all ${g.items.length}</button>
      <button class="btn sm ghost" data-cdeferall="${gi}">Defer</button></div></div>`;
  }).join('');

  $$('#checksList [data-cconfirm]').forEach(b => b.addEventListener('click', () => setConfirm(b.dataset.cconfirm, 'confirmed')));
  $$('#checksList [data-creject]').forEach(b => b.addEventListener('click', () => rejectMapping(b.dataset.creject)));
  $$('#checksList [data-cdefer]').forEach(b => b.addEventListener('click', () => setConfirm(b.dataset.cdefer, 'deferred')));
  $$('#checksList [data-cview]').forEach(b => b.addEventListener('click', () => showResponse(b.dataset.cview)));
  $$('#checksList [data-cconfirmall]').forEach(b => b.addEventListener('click', () => {
    const g = Object.values(byKey)[Number(b.dataset.cconfirmall)];
    store.update(s2 => {
      for (const c of g.items) {
        const intake = s2.intake[c.vendorId];
        if (intake) confirmPartMatch(intake.normalized, c.id);
        else c.status = 'confirmed';
      }
    });
    toast(`${g.items.length} mappings confirmed — values now count in the comparison.`);
  }));
  $$('#checksList [data-cacceptall]').forEach(b => b.addEventListener('click', () => {
    const g = Object.values(byKey)[Number(b.dataset.cacceptall)];
    store.update(s2 => { for (const c of g.items) c.status = 'confirmed'; });
    toast('Incl.-GST assumption accepted.');
  }));
  $$('#checksList [data-cdeferall]').forEach(b => b.addEventListener('click', () => {
    const g = Object.values(byKey)[Number(b.dataset.cdeferall)];
    store.update(s2 => { for (const c of g.items) c.status = 'deferred'; });
  }));
  $$('#checksList [data-cnameyes]').forEach(b => b.addEventListener('click', () => resolveNameCheck(b.dataset.cnameyes, true)));
  $$('#checksList [data-cnameno]').forEach(b => b.addEventListener('click', () => resolveNameCheck(b.dataset.cnameno, false)));
}

// Vendor-name check resolution: confirming keeps the extracted name (already
// stored); "use the slot name" writes the slot name back onto the response.
function resolveNameCheck(id, useExtracted) {
  store.update(s => {
    const c = s.confirmations.find(x => x.id === id);
    if (!c || c.kind !== 'vendor_name') return;
    if (!useExtracted) {
      const intake = s.intake[c.vendorId];
      const slotName = c.evidence?.slot;
      if (intake && slotName) {
        intake.vendorName = slotName;
        if (intake.normalized) intake.normalized.vendorName = slotName;
      }
      toast(`Display name set to “${slotName}”.`);
    } else {
      toast('Vendor name confirmed.');
    }
    c.status = 'confirmed';
    const intake = s.intake[c.vendorId];
    if (intake && intake.status !== 'reading' && intake.status !== 'failed') {
      intake.status = s.confirmations.some(x => x.vendorId === c.vendorId && x.status === 'pending' && x.id !== c.id) ? 'needs_review' : 'ready';
    }
  });
}

function compactRanges(nums) {
  const out = [];
  let a = nums[0], p = nums[0];
  for (const n of nums.slice(1)) {
    if (n === p + 1) { p = n; continue; }
    out.push(a === p ? `${a}` : `${a}–${p}`); a = p = n;
  }
  out.push(a === p ? `${a}` : `${a}–${p}`);
  return out.join(', ');
}

async function uploadFile(vendorId, file) {
  if (needKey()) return { ok: false, error: 'API key required.' };
  try {
    const routed = await routeFile(file);
    const result = await runIntake({ store, catalog, settings: store.get().settings }, vendorId, routed,
      { files: [{ name: file.name, kind: 'quote', source: 'upload' }] });
    if (result.ok) {
      try {
        const { data: { user }, error } = await cloudClient.auth.getUser();
        if (error || !user) throw error || new Error('Sign in again to save the original file.');
        const storagePath = await uploadOriginal(cloudClient, user.id, vendorId, file);
        store.update(s => {
          const intake = s.intake[vendorId];
          const quote = intake?.files?.find(f => f.kind === 'quote' && f.source === 'upload');
          if (quote) quote.storagePath = storagePath;
        });
      } catch (err) {
        const message = String(err.message || err);
        store.update(s => {
          const quote = s.intake[vendorId]?.files?.find(f => f.kind === 'quote' && f.source === 'upload');
          if (quote) quote.originalSaveError = message;
        });
        toast(`Response extracted, but its original file was not saved: ${message}`, 7000);
      }
      queueEvidenceReview(vendorId);
    }
    renderScreen(activeScreen); // first response changes pipeline state and unlocks review
    renderDemoData();
    return result;
  } catch (err) {
    store.update(s => restoreReplacementFailure(s, vendorId, String(err.message || err)));
    return { ok: false, error: String(err.message || err) };
  }
}

// Demo bundle manifest: quote + questionnaire + supporting files per vendor.
const DEMO_SUPPORTING = { 'shakti-packers': ['gst-certificate.pdf'] };

async function loadDemoBundle(vendorId, quoteFile) {
  const files = [{ name: quoteFile, kind: 'quote' }];
  let answers = {};
  try {
    const r = await fetch(`data/vendors/${vendorId}/questionnaire.json`);
    if (r.ok) {
      answers = await r.json();
      files.push({ name: 'questionnaire.json', kind: 'questionnaire' });
    }
  } catch (e) { /* questionnaire is optional in a bundle */ }
  for (const f of DEMO_SUPPORTING[vendorId] || []) files.push({ name: f, kind: 'supporting' });
  return { answers, files };
}

async function demoLoad(vendorId) {
  if (needKey()) return { ok: false, error: 'API key required.' };
  const v = VENDORS.find(x => x.id === vendorId);
  try {
    const routed = await loadDemoFile(`data/vendors/${vendorId}/${v.file}`, v.file);
    const bundle = await loadDemoBundle(vendorId, v.file);
    const result = await runIntake({ store, catalog, settings: store.get().settings }, vendorId, routed, bundle);
    if (result.ok) queueEvidenceReview(vendorId);
    return result;
  } catch (err) {
    const error = String(err.message || err);
    store.update(s => restoreReplacementFailure(s, vendorId, error, v.name));
    return { ok: false, error };
  }
}

function restoreReplacementFailure(s, vendorId, error, fallbackName = '') {
  const active = s.intake[vendorId];
  const previous = active?.previousIntake || (active?.status === 'reading' ? null : active);
  s.intake[vendorId] = previous?.normalized
    ? { ...previous, lastReplacementError: error }
    : { ...(previous || {}), vendorId, vendorName: previous?.vendorName || fallbackName || vendorById(vendorId)?.name, status: 'failed', error };
}

async function loadAllDemo() {
  if (needKey()) return;
  const button = $('#loadAllDemo');
  button.disabled = true;
  button.textContent = 'Loading sample files…';
  let succeeded = 0, failed = 0;
  try {
    for (const v of VENDORS) {
      markVendorReading(v.id);
      renderDemoData();
      const result = await demoLoad(v.id);
      if (result?.ok) succeeded++; else failed++;
      renderScreen(activeScreen);
      renderDemoData();
    }
    toast(`${succeeded} response${succeeded === 1 ? '' : 's'} loaded${failed ? `; ${failed} failed` : ''}.`);
  } finally {
    button.disabled = false;
    button.textContent = 'Load all five sample files';
  }
}

// Response viewer: quote + questionnaire + supporting files, carried together.
function showResponse(vendorId) {
  const st = store.get().intake[vendorId];
  if (!st) return;
  $('#rawTitle').textContent = `${st.vendorName} — response details`;
  const ex = st.extracted;
  const quoteRows = ex ? ex.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.quoted_part_number ?? '—')}</td>
    <td>${esc(l.quoted_description ?? '')}</td><td class="num">${l.quoted_unit_price ?? '—'}</td>
    <td>${esc(l.quoted_currency ?? '')}</td><td>${esc(l.quoted_basis ?? '')}</td><td>${esc(l.quoted_gst ?? '')}</td></tr>`).join('') : '';
  const answerSet = matchedAnswerSet(st.answers || {}, store.get().rfx?.questions);
  const answers = answerSet.matched;
  const totalQ = answerSet.total;
  const files = st.files || [];
  const qf = files.find(f => f.kind === 'quote');
  $('#rawBody').innerHTML = `
    <div class="viewer-sec"><h3>Quote — as transcribed</h3>
      <p class="note">Exactly what the co-pilot transcribed — quoted as-is, before normalization.</p>
      ${ex ? `<div class="hscroll"><table><thead><tr><th>#</th><th>Part</th><th>Description</th><th>Price</th><th>Ccy</th><th>Basis</th><th>GST</th></tr></thead><tbody>${quoteRows}</tbody></table></div>`
        : `<div class="empty">No quote transcribed yet.</div>`}</div>
    <div class="viewer-sec"><h3>Questionnaire — ${answers.length}/${totalQ} answered</h3>
      ${answers.length ? answers.map(x => `<div class="qa"><b>${esc(x.question.id)} · ${esc(x.question.text)}</b>${esc(x.answer)}</div>`).join('')
        : `<div class="empty">No questionnaire answers in this bundle.</div>`}</div>
    <div class="viewer-sec"><h3>Files in this bundle</h3>
      <div class="filelist">${files.length ? files.map(f => `<span class="filechip">${esc(f.name)} <span class="sub">· ${esc(f.kind)}${f.storagePath ? ' · original saved' : f.source === 'upload' ? ' · original not saved' : ''}</span></span>`).join('') : '<span class="sub">—</span>'}</div>
      ${qf?.source === 'upload' && !qf.storagePath ? `<p class="note" role="alert">The original upload is not saved in cloud storage${qf.originalSaveError ? `: ${esc(qf.originalSaveError)}` : '.'}</p>` : ''}</div>`;
  const dl = $('#rawDownload');
  if (qf && vendorId) {
    const uploaded = qf.source === 'upload';
    dl.style.display = uploaded && !qf.storagePath ? 'none' : '';
    dl.href = uploaded ? '#' : `data/vendors/${vendorId}/${qf.name}`;
    dl.setAttribute('download', qf.name);
    dl.onclick = async event => {
      if (!uploaded) return;
      event.preventDefault();
      if (!qf.storagePath) return;
      try {
        const blob = await downloadOriginal(cloudClient, qf.storagePath);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = qf.name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) { toast(`Could not download the original file: ${err.message || err}`, 6000); }
    };
  } else dl.style.display = 'none';
  $('#rawModal').classList.add('show');
}

// ---------- 4 · published ----------
// Published overview: tracking state only. Comparison, the buyer-check queue
// and qualification live on Review responses / Analysis, not here.
function comparedNormalized() {
  const s = store.get();
  return Object.values(s.intake).filter(v => v?.normalized).map(v => v.normalized);
}

function renderPublished() {
  const s = store.get();
  const r = s.rfx;
  if (!r) { $('#publishedHead').innerHTML = `<div class="empty">No published RFx.</div>`; return; }

  // Read-only view of the published document: header, lines, questionnaire,
  // commercial terms, and the visible spec flag. Nothing here is editable.
  const liveQ = (r.questions || []).filter(q => !q.omitted);
  const liveT = (r.terms || []).filter(t => !t.omitted);
  const channelNote = r.gem_bid_number
    ? `GeM bid no. ${esc(r.gem_bid_number)}`
    : 'Non-GeM — shared by the buyer through their own channel';
  $('#publishedHead').innerHTML = `<div class="rowhead"><div><h2>${esc(r.title)}</h2>
    <p class="sub" style="margin:4px 0 0">${rfxIdLine(r)} · <span class="pill p-info">Published · read-only</span></p>
    <p class="sub" style="margin:4px 0 0">Buying unit: <b>${esc(r.header?.buying_unit || 'Not set')}</b> · Bid due: <b>${esc(r.header?.bid_due_datetime || 'Not set')}</b> · ${channelNote}</p>
    <div style="margin-top:6px"><b>Delivery locations</b><div>${deliveryGroupsHtml(r.lines)}</div></div></div></div>`;

  $('#pubLinePill').textContent = `${r.lines.length} lines`;
  const conflictLine = r.specConflict
    ? r.lines.find(l => (l.official_part_number || l.catalog_ref) === r.specConflict.part_number) : null;
  $('#pubSpecFlag').innerHTML = r.specConflict ? `<div class="banner warn"><h3>Specification needs resolution</h3><p>Line ${conflictLine ? conflictLine.sl : ''} (${esc(String(r.specConflict.part_number))}) is listed at ${r.specConflict.listed_gsm} GSM while the source specification says ${r.specConflict.spec_text_gsm} GSM. This flag is part of the published RFx; vendors confirm compliance.</p></div>` : '';
  $('#pubLines tbody').innerHTML = r.lines.map(l => `<tr${(l.official_part_number || l.catalog_ref) === 'JTM0103995148' ? ' class="flagged"' : ''}>
    <td>${l.sl}</td><td>${esc(l.official_part_number || l.catalog_ref || '—')}</td>
    <td>${esc(l.description || '')}</td><td class="num">${l.quantity_nos}</td>
    <td>${esc(l.delivery_location || 'Not set')}</td></tr>`).join('');

  $('#pubQPill').textContent = `${liveQ.length} questions`;
  $('#pubQuestions').innerHTML = liveQ.length
    ? `<ol style="margin:6px 0;padding-left:20px">${liveQ.map(q => `<li>${esc(q.text)}${publishedOrigin(q)}</li>`).join('')}</ol>`
    : `<span class="sub">No questions.</span>`;
  $('#pubTPill').textContent = `${liveT.length} clauses`;
  $('#pubTerms').innerHTML = liveT.length
    ? `<ol style="margin:6px 0;padding-left:20px">${liveT.map(t => `<li>${esc(t.text)}${publishedOrigin(t)}</li>`).join('')}</ol>`
    : `<span class="sub">No terms.</span>`;

  // Responses — tracked here, but only from actually ingested bundles.
  const received = Object.values(s.intake).filter(st => st?.normalized);
  const hasData = received.length > 0;
  const reviewBtn = $('#reviewRespBtn'), analystBtn = $('#analystBtn');
  if (!hasData) {
    $('#respPill').textContent = 'Waiting for responses';
    $('#trackingBody').innerHTML = `<div class="empty"><b>No vendor responses yet.</b><br>
      <span class="sub">Share the RFx with vendors through your own channel, then load each response under Settings → Demo data.</span></div>`;
    for (const b of [reviewBtn, analystBtn]) { b.disabled = true; b.title = 'Available after the first vendor response is loaded'; }
  } else {
    $('#respPill').textContent = `${received.length} received · reviewing`;
    $('#trackingBody').innerHTML = `<div class="kv"><b>Responses in</b><span>${received.map(st => esc(st.vendorName || st.vendorId)).join(', ')}</span></div>`;
    for (const b of [reviewBtn, analystBtn]) { b.disabled = false; b.title = ''; }
  }
}

function deleteRfx() {
  const r = store.get().rfx;
  if (r) openDeleteModal({ kind: 'live', id: r.internal_id, active: true });
}

function openDeleteModal(target) {
  const s = store.get();
  let title, detail;
  if (target.kind === 'draft') {
    if (!s.draft) return;
    title = s.draft.rfx.title || 'Untitled draft';
    detail = 'its draft content and buyer conversation';
  } else if (target.kind === 'completed') {
    const x = (s.completed || []).find(p => p.completedAt === target.completedAt);
    if (!x) return;
    title = x.title;
    detail = 'its award record and linked response and review data';
  } else {
    const p = target.active ? captureLive(s) : (s.otherLive || []).find(x => x.rfx?.internal_id === target.id);
    if (!p || p.rfx.internal_id !== target.id) return;
    title = p.rfx.title;
    detail = 'its loaded response records, buyer checks, review outcomes, and analyst conversation';
  }
  deleteTarget = target;
  $('#deleteRfxModal h2').textContent = `Delete ${target.kind === 'draft' ? 'draft' : 'RFx'}?`;
  $('#deleteRfxText').innerHTML = `This permanently removes <b>${esc(title)}</b> and ${detail} from the shared workspace. Demo seed files and uploaded vendor-file bytes are not deleted; links from this RFx are removed. This cannot be undone.`;
  $('#deleteRfxConfirm').textContent = target.kind === 'draft' ? 'Delete this draft' : 'Delete this RFx';
  $('#deleteRfxCancel').textContent = 'Cancel';
  $('#deleteRfxModal').classList.add('show');
}

function confirmDeleteRfx() {
  if (!deleteTarget) return;
  let deleted = false;
  store.update(s => { deleted = deleteProject(s, deleteTarget); });
  $('#deleteRfxModal').classList.remove('show');
  deleteTarget = null;
  toast(deleted ? 'RFx removed from the shared workspace.' : 'RFx changed. Nothing was deleted.');
  go('s-home');
}

function setConfirm(id, status) {
  store.update(s => {
    const c = s.confirmations.find(x => x.id === id);
    if (!c) return;
    // Confirming a proposed part mapping promotes its staged value into
    // comparable totals; until then it stays out.
    if (c.kind === 'part_match' && status === 'confirmed') {
      const intake = s.intake[c.vendorId];
      if (intake && confirmPartMatch(intake.normalized, id)) {
        toast('Mapping confirmed — the line now counts in the comparison.');
        return;
      }
    }
    c.status = status;
  });
}
function rejectMapping(id) {
  store.update(s => {
    const c = s.confirmations.find(x => x.id === id);
    if (!c || c.kind !== 'part_match') return;
    c.status = 'rejected';
    const intake = s.intake[c.vendorId];
    const rec = intake?.normalized.lines.find(l => l.rfx_sl === c.evidence.rfx_sl);
    if (rec) {
      rec.matched = 'unmatched';
      rec.normalized_inr_incl_gst = null;
      rec.flags.push({ kind: 'rejected', text: 'Buyer rejected the proposed part-number mapping — excluded from comparison' });
    }
  });
  toast('Mapping rejected — the line is excluded from the comparison.');
}

// ---------- 6 · analysis ----------
const SAMPLE_QUESTIONS = [
  'Which lines have the largest price spread?',
  'Show the lowest quoted price on a line',
];

function renderAnalysis() {
  const s = store.get();
  const r = s.rfx;

  // chat
  const msgs = displayMessages(s.analyst.messages);
  $('#analystChat').innerHTML = msgs.length ? msgs.map(m =>
    `<div class="msg ${m.role === 'user' ? 'buyer' : 'bot'}"><span class="who">${m.role === 'user' ? 'Buyer' : 'Analyst'}</span>${renderChatText(m.content)}</div>`).join('')
    : `<div class="empty">Ask anything about the responses — cheapest on the common set, a single line's spread, what still needs your check.</div>`;
  $('#analystChat').scrollTop = $('#analystChat').scrollHeight;
  const all = comparedNormalized();
  const prompts = all.length === 1
    ? [`What is ${all[0].vendorName}'s quoted-line total?`, `Which RFx lines did ${all[0].vendorName} not quote?`]
    : all.length > 1 ? SAMPLE_QUESTIONS : [];
  $('#sampleChips').innerHTML = prompts.map(q => `<button class="chip" data-chip="${esc(q)}">${esc(q)}</button>`).join('');
  $$('#sampleChips [data-chip]').forEach(b => b.addEventListener('click', () => sendAnalystText(b.dataset.chip)));

  $('#analysisSub').textContent = r
    ? `${esc(r.title)} · ${rfxIdLine(r)}`
    : '';

  if (!all.length) {
    $('#priceDenom').textContent = 'no responses';
    $('#priceBars').innerHTML = `<div class="empty">No responses read yet.</div>`;
    $('#priceNote').textContent = '';
    $('#techReview').innerHTML = `<div class="empty">No responses read yet.</div>`;
    $('#gapsPill').textContent = '0 open';
    $('#gapsList').innerHTML = `<div class="empty">No response evidence to review yet.</div>`;
    $('#analysisChecksCard').hidden = true;
    $('#awardStatus').textContent = 'Award review pending';
    $('#awardPill').textContent = 'No proposal';
    $('#awardAllocations').innerHTML = '<div class="empty">Load responses before building an award allocation.</div>';
    $('#confirmAward').disabled = true;
    $('#cmpTable thead').innerHTML = '';
    $('#cmpTable tbody').innerHTML = '';
    return;
  }

  // price comparison — bars over the common set
  const { commonLines, totals } = lowestOnCommonSet(all);
  $('#priceDenom').textContent = all.length === 1 ? `${commonLines} quoted lines` : `${commonLines}-line common set`;
  const max = Math.max(...totals.map(t => t.total));
  const pendingPart = s.confirmations.filter(c => c.status === 'pending' && c.kind === 'part_match').length;
  $('#priceBars').innerHTML = all.length === 1
    ? totals.map(t => `<div class="single-total"><span>${esc(t.vendorName)} · quoted-line total</span><b>${fmt(t.total)}</b></div>`).join('')
    : totals.map((t, i) => `<div class="bar-row${i === 0 ? ' lowest' : ''}">
      <div>${i + 1}. ${esc(t.vendorName)}</div>
      <div class="bar"><i style="width:${Math.round(100 * t.total / max)}%"></i></div>
      <div class="num">${fmt(t.total)}</div></div>`).join('');
  const caveats = [];
  for (const n of all) {
    if (n.lines.some(l => /ex[- ]?works/i.test(String(l.quoted_basis || ''))) || /ex[- ]?works/i.test(JSON.stringify(n.meta || {}))) caveats.push(`${n.vendorName}: ex-works; freight extra, so delivered totals are not fully like-for-like`);
  }
  const gstOpen = s.confirmations.some(c => c.status === 'pending' && c.kind === 'gst_basis');
  if (gstOpen) caveats.push(`GST treatment unconfirmed on some lines (treated as incl. GST)`);
  $('#priceNote').textContent =
    (all.length === 1
      ? `Shown in rupees for the ${commonLines} lines quoted by this vendor; this is not a tender total.`
      : 'Prices are compared only across the line items quoted by every response received so far.') +
    (pendingPart ? ` ${pendingPart} proposed part match${pendingPart > 1 ? 'es' : ''} await${pendingPart > 1 ? '' : 's'} your confirmation and stay${pendingPart > 1 ? '' : 's'} out of these totals.` : '') +
    (caveats.length ? ` ${caveats.join('; ')}.` : '');

  renderVendorReview(s, r, all);
  renderAward(s, r, all);

  // Buyer confirmations are actionable decisions; evidence gaps are missing
  // or incomplete response material. Keep their counts and lists separate.
  const open = s.confirmations.filter(c => c.status === 'pending' && s.intake[c.vendorId]?.normalized);
  $('#analysisChecksCard').hidden = !open.length;
  if (open.length) {
    $('#analysisChecksPill').textContent = `${open.length} pending`;
    $('#analysisChecksList').innerHTML = `<p class="sub">These confirmations can be resolved on the response review page.</p><button class="btn sm ghost" data-checksgo>Review checks</button>`;
    $('#analysisChecksList [data-checksgo]').addEventListener('click', () => go('s-intake'));
  }
  const gaps = [];
  for (const n of all) {
    const st = s.intake[n.vendorId];
    for (const gap of responseEvidenceGaps(st, r)) {
      const detail = gap.lineNumbers
        ? `${gap.kind === 'unquoted_lines' ? 'RFx lines not quoted' : 'Prices unreadable on lines'}: ${compactRanges(gap.lineNumbers)}`
        : gap.detail;
      gaps.push({ id: n.vendorId, vendor: n.vendorName, detail });
    }
  }
  $('#gapsPill').textContent = `${gaps.length} evidence gaps`;
  $('#gapsList').innerHTML = gaps.length ? gaps.map(g => `<div class="gapitem"><div class="rowhead"><div><b>${esc(g.vendor)}</b><div class="sub">${esc(g.detail)}</div></div>
      <button class="btn sm ghost" data-gapview="${esc(g.id)}">Inspect evidence</button></div></div>`).join('')
    : `<div class="empty">No evidence gaps identified in the loaded responses.</div>`;
  $$('#gapsList [data-gapview]').forEach(b => b.addEventListener('click', () => showResponse(b.dataset.gapview)));

  renderAllLines(s, r, all, commonLines, totals);
}

const QUAL_LABEL = { not_reviewed: 'Not reviewed', in_review: 'In review', needs_clarification: 'Needs clarification', technically_cleared: 'Technically cleared', not_cleared: 'Not cleared' };
function vendorGaps(st, r, q) {
  return qualificationGapCount(st, r, q);
}
function renderVendorReview(s, r, all) {
  const proposedCount = Object.values(s.qualification).filter(q => q?.proposal && q.proposal.responseVersion === q.responseVersion).length;
  $('#reviewProposalBatch').hidden = !proposedCount || s.award?.status === 'awarded';
  $('#reviewProposalBatch').textContent = `Review ${proposedCount} proposed outcome${proposedCount === 1 ? '' : 's'}`;
  $('#techReview').innerHTML = `<div class="hscroll"><table class="review-table"><thead><tr><th>Vendor</th><th>Quoted lines</th><th>Questions answered</th><th>Compliance deviations</th><th>Issues flagged</th><th>Buyer outcome</th><th></th></tr></thead><tbody>${all.map(n => {
    const st = s.intake[n.vendorId], d = deterministicEvidence(st, r);
    const q = s.qualification[n.vendorId] || { status: 'not_reviewed', rationale: '', history: [] };
    const gaps = vendorGaps(st, r, q);
    const findings = q.evidenceReview?.findings || [];
    const deviations = q.reviewState === 'loading' ? 'Reviewing…' : q.reviewState === 'error' ? 'Review unavailable' : q.reviewState === 'complete' ? findings.filter(f => f.kind === 'answer_conflict' || f.kind === 'term_conflict').length : 'Not reviewed';
    const issueCount = d.missingLines.length + d.missingQuestions.length + findings.length;
    return `<tr><td><b>${esc(n.vendorName)}</b></td><td>${quotedLineCount(n)}/${r.lines.length}</td><td>${d.answerCount}/${d.answerTotal}</td><td>${deviations}</td><td>${issueCount}</td><td><span class="pill ${q.status === 'technically_cleared' ? 'p-ok' : q.status === 'not_cleared' ? 'p-flag' : 'p-mut'}">${esc(QUAL_LABEL[q.status] || 'Not reviewed')}</span></td><td><button class="btn sm ghost" data-expand-review="${esc(n.vendorId)}">Review</button></td></tr>
      <tr class="review-detail" id="review-detail-${esc(n.vendorId)}"><td colspan="7">${reviewDetailHtml(n, st, r, q, d, gaps)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
  $$('#techReview [data-expand-review]').forEach(b => b.addEventListener('click', () => {
    const el = $(`#review-detail-${CSS.escape(b.dataset.expandReview)}`); el.classList.toggle('open'); b.textContent = el.classList.contains('open') ? 'Close review' : 'Review';
  }));
  $$('#techReview [data-record-outcome]').forEach(b => b.addEventListener('click', () => recordOutcome(b.dataset.vendor)));
  $$('#techReview [data-evidence-review]').forEach(b => b.addEventListener('click', () => startEvidenceReview(b.dataset.vendor)));
  $$('#techReview [data-source]').forEach(b => b.addEventListener('click', () => showResponse(b.dataset.source)));
  $$('#techReview [data-use-proposal]').forEach(b => b.addEventListener('click', () => useOutcomeProposal(b.dataset.vendor)));
}
function reviewDetailHtml(n, st, r, q, d, gaps) {
  const answers = matchedAnswerSet(st.answers, r.questions);
  const missingLines = d.missingLines.map(l => `<li>Line ${esc(l.sl)} · ${esc(l.part || 'Part not listed')} — ${esc(l.description || 'Description unavailable')}</li>`).join('') || '<li>None identified.</li>';
  const missingQuestions = d.missingQuestions.map(x => `<li>${esc(x.id)}: ${esc(x.text)}<br>Answer: —</li>`).join('') || '<li>None identified.</li>';
  const answerList = answers.matched.map(x => `<li><b>${esc(x.question.id)} · ${esc(x.question.text)}</b><br>${esc(x.answer)}</li>`).join('') || '<li>No matched non-empty answers.</li>';
  const findings = q.evidenceReview?.findings || [];
  const findingHtml = findings.length ? findings.map(f => {
    const term = (r.terms || []).find(t => String(t.id) === String(f.term_id));
    const question = (r.questions || []).find(x => String(x.id) === String(f.question_id));
    return `<li><b>${esc(f.summary)}</b> — ${esc(f.reason)}${term ? `<br><span class="sub">Published term: ${esc(term.sentence || term.text || term.title)}</span>` : ''}${question ? `<br><span class="sub">Question: ${esc(question.text)}</span>` : ''}<br><span class="sub">Vendor response: “${esc(f.evidence_excerpt)}”</span></li>`;
  }).join('') : q.reviewState === 'complete' ? '<li>No deviations identified in stored response evidence.</li>' : q.reviewState === 'loading' ? '<li>Evidence review is running; results are not available yet.</li>' : q.reviewState === 'error' ? '<li>Review unavailable; no conclusion can be drawn from the missing result.</li>' : '<li>Evidence review has not run.</li>';
  const conf = store.get().confirmations.filter(c => c.vendorId === n.vendorId && c.status === 'pending');
  const terms = conf.map(c => `<li>${esc(c.title)} — ${esc(c.detail)}</li>`).join('') || '<li>No pending material confirmations.</li>';
  const status = q.status || 'not_reviewed';
  const locked = store.get().award?.status === 'awarded';
  return `<div class="review-detail-inner">
    <div class="review-evidence-grid"><section><h3>Missing RFx lines</h3><ul>${missingLines}</ul></section><section><h3>Missing questionnaire answers</h3><ul>${missingQuestions}</ul></section>
      <section><h3>Matched answers</h3><ul class="answer-list">${answerList}</ul></section><section><h3>Published terms and material checks</h3><ul>${terms}</ul></section>
      <section><h3>Evidence review findings</h3><ul>${findingHtml}</ul>${q.reviewState === 'loading' ? '<p>Reviewing stored evidence…</p>' : q.reviewState === 'error' ? `<p class="error">${esc(q.reviewError || 'Evidence review failed.')}</p><button class="btn sm ghost" data-evidence-review data-vendor="${esc(n.vendorId)}" ${locked ? 'disabled' : ''}>Retry evidence review</button>` : q.reviewState !== 'complete' ? `<p class="sub">Evidence analysis has not run for this response.</p><button class="btn sm ghost" data-evidence-review data-vendor="${esc(n.vendorId)}" ${locked ? 'disabled' : ''}>Analyze evidence</button>` : ''}</section>
      <section><h3>Source</h3><p class="sub">Original response files are available for verification.</p><button class="btn sm ghost" data-source="${esc(n.vendorId)}">View response files</button></section></div>
    <div class="outcome-form"><h3>Record buyer outcome</h3>${q.proposal ? `<div class="banner"><b>Analyst suggestion:</b> ${esc(QUAL_LABEL[q.proposal.status] || q.proposal.status)} — ${esc(q.proposal.rationale)}. This is not recorded yet. <button class="btn sm ghost" data-use-proposal data-vendor="${esc(n.vendorId)}" ${locked ? 'disabled' : ''}>Review suggestion</button></div>` : ''}<div class="controls"><label>Outcome <select data-outcome="${esc(n.vendorId)}" ${locked ? 'disabled' : ''}>${QUALIFICATION_STATUSES.map(x => `<option value="${x}"${status === x ? ' selected' : ''}>${QUAL_LABEL[x]}</option>`).join('')}</select></label><label>Rationale <textarea data-rationale="${esc(n.vendorId)}" rows="2" ${locked ? 'disabled' : ''}>${esc(q.rationale || '')}</textarea></label></div>
      ${gaps ? `<div class="banner warn"><b>${q.reviewState === 'loading' ? 'Evidence review is still running.' : q.reviewState === 'error' ? 'Evidence review is unavailable.' : q.reviewState !== 'complete' ? 'Evidence review has not run.' : `${gaps} evidence gaps are identified.`}</b> Clearing this vendor requires an explicit override reason.<label class="check"><input type="checkbox" data-override-check="${esc(n.vendorId)}" ${q.overrideReason ? 'checked' : ''} ${locked ? 'disabled' : ''}> I have reviewed the gaps and want to clear this vendor</label><textarea data-override="${esc(n.vendorId)}" rows="2" placeholder="Required override reason" ${locked ? 'disabled' : ''}>${esc(q.overrideReason || '')}</textarea></div>` : ''}
      ${q.history?.length ? `<details><summary>Previous decisions (${q.history.length})</summary>${q.history.map(h => `<p>${esc(QUAL_LABEL[h.status] || h.status)} · ${esc(h.rationale || '')} · ${esc(h.reason || '')}</p>`).join('')}</details>` : ''}
      <button class="btn sm" data-record-outcome data-vendor="${esc(n.vendorId)}" ${locked ? 'disabled' : ''}>Record outcome</button></div>
  </div>`;
}
function recordOutcome(vendorId) {
  const q = $(`[data-outcome="${CSS.escape(vendorId)}"]`)?.value;
  const rationale = $(`[data-rationale="${CSS.escape(vendorId)}"]`)?.value.trim();
  const gaps = vendorGaps(store.get().intake[vendorId], store.get().rfx, store.get().qualification[vendorId]);
  const override = $(`[data-override="${CSS.escape(vendorId)}"]`)?.value.trim() || '';
  const checked = $(`[data-override-check="${CSS.escape(vendorId)}"]`)?.checked;
  if (q === 'technically_cleared' && gaps && !checked) { toast('Confirm that you reviewed the evidence gaps.'); return; }
  const error = validateQualificationTransition({ status: q, rationale, overrideReason: override, gapCount: gaps, awardStatus: store.get().award?.status });
  if (error) { toast(error); return; }
  store.update(s => { applyQualificationTransition(s, vendorId, { status: q, rationale, overrideReason: override }); });
  toast('Buyer outcome recorded.');
}
function useOutcomeProposal(vendorId) {
  const proposal = store.get().qualification[vendorId]?.proposal;
  if (!proposal) return;
  const detail = $(`#review-detail-${CSS.escape(vendorId)}`);
  detail?.classList.add('open');
  const status = $(`[data-outcome="${CSS.escape(vendorId)}"]`), rationale = $(`[data-rationale="${CSS.escape(vendorId)}"]`);
  if (status) status.value = proposal.status;
  if (rationale) rationale.value = proposal.rationale;
  toast('Suggestion copied into the buyer review form. Record it only after your review.');
}
function openProposalBatch() {
  const s = store.get();
  const proposals = Object.entries(s.qualification).filter(([id, q]) => q?.proposal && q.proposal.responseVersion === q.responseVersion && s.intake[id]?.normalized);
  if (!proposals.length) return;
  $('#proposalBatchBody').innerHTML = `<div class="hscroll"><table class="review-table"><thead><tr><th>Use</th><th>Vendor</th><th>Proposed outcome</th><th>Rationale</th></tr></thead><tbody>${proposals.map(([id, q]) => {
    const gaps = vendorGaps(s.intake[id], s.rfx, q);
    return `<tr><td><input type="checkbox" data-batch-include="${esc(id)}" checked></td><td>${esc(s.intake[id].vendorName)}</td><td>${esc(QUAL_LABEL[q.proposal.status] || q.proposal.status)}</td><td><textarea data-batch-rationale="${esc(id)}" rows="2">${esc(q.proposal.rationale)}</textarea>${q.proposal.status === 'technically_cleared' && gaps ? `<div class="banner warn"><b>${q.reviewState === 'loading' ? 'Evidence review is still running.' : q.reviewState === 'error' ? 'Evidence review is unavailable.' : q.reviewState !== 'complete' ? 'Evidence review has not run.' : `${gaps} evidence gaps.`}</b> Clearing needs an explicit override reason.<label class="check"><input type="checkbox" data-batch-override-check="${esc(id)}"> Confirm gap override</label><textarea data-batch-override="${esc(id)}" rows="2" placeholder="Required override reason"></textarea></div>` : ''}</td></tr>`;
  }).join('')}</tbody></table></div>`;
  $('#proposalModal').classList.add('show');
}
function applyProposalBatch() {
  const s0 = store.get();
  const selected = $$('#proposalBatchBody [data-batch-include]:checked').map(cb => cb.dataset.batchInclude);
  if (!selected.length) { toast('Select at least one proposed outcome.'); return; }
  const edits = [];
  for (const id of selected) {
    const q = s0.qualification[id], proposal = q?.proposal;
    if (!proposal || proposal.responseVersion !== q.responseVersion) { toast('A response changed. Reopen the proposed outcomes.'); return; }
    const rationale = $(`[data-batch-rationale="${CSS.escape(id)}"]`)?.value.trim();
    const gaps = vendorGaps(s0.intake[id], s0.rfx, q);
    const overrideReason = $(`[data-batch-override="${CSS.escape(id)}"]`)?.value.trim() || '';
    const checked = $(`[data-batch-override-check="${CSS.escape(id)}"]`)?.checked;
    if (!rationale) { toast(`Add a rationale for ${s0.intake[id].vendorName}.`); return; }
    if (proposal.status === 'technically_cleared' && gaps && (!checked || !overrideReason)) { toast(`Review and explain the gap override for ${s0.intake[id].vendorName}.`); return; }
    edits.push({ id, status: proposal.status, rationale, gaps, overrideReason });
  }
  store.update(s => {
    for (const edit of edits) {
      const q = s.qualification[edit.id], history = [...(q.history || [])];
      if (q.status && q.status !== 'not_reviewed') history.push({ status: q.status, rationale: q.rationale, updatedAt: q.updatedAt });
      s.qualification[edit.id] = { ...q, status: edit.status, rationale: edit.rationale, unresolvedGapCount: edit.gaps,
        overrideReason: edit.status === 'technically_cleared' && edit.gaps ? edit.overrideReason : '', history,
        updatedAt: new Date().toISOString(), proposal: null };
    }
    if (s.award?.status === 'proposed') s.award = null;
  });
  $('#proposalModal').classList.remove('show');
  toast(`${edits.length} buyer outcome${edits.length === 1 ? '' : 's'} recorded.`);
}
async function startEvidenceReview(vendorId) {
  if (needKey()) return;
  try { await runEvidenceReview({ store, settings: store.get().settings }, vendorId); toast('Evidence review saved for buyer review.'); }
  catch (e) { toast(`Evidence review failed: ${e.message || e}`); }
}
function queueEvidenceReview(vendorId) {
  runEvidenceReview({ store, settings: store.get().settings }, vendorId).catch(() => {});
}
function queuePendingEvidenceReviews() {
  if (!store.get().settings.apiKey) return;
  for (const [id, st] of Object.entries(store.get().intake)) {
    const q = store.get().qualification[id];
    if (st?.normalized && !q?.evidenceReview && q?.reviewState !== 'loading') queueEvidenceReview(id);
  }
}

function buildAward() {
  const s = store.get(), r = s.rfx;
  if (!r || s.award?.status === 'awarded') return;
  const loaded = Object.values(s.intake).filter(x => x?.normalized);
  const included = s.award?.includedVendorIds || [];
  const proposal = buildAwardProposal(r, loaded, s.qualification, s.award?.assignments && Object.fromEntries(Object.entries(s.award.assignments).map(([sl, a]) => [sl, a.vendorId])), s.confirmations, included);
  store.update(st => { st.award = { ...proposal, status: 'proposed', includedVendorIds: included, rationale: st.award?.rationale || '' }; });
  renderAward(store.get(), r, comparedNormalized());
}
function renderAward(s, r, all) {
  if (!r || !$('#awardCard')) return;
  $('#awardStatus').textContent = s.award?.status === 'awarded' ? 'RFx awarded' : s.award?.status === 'proposed' ? 'Proposed award' : 'Award review pending';
  $('#awardPill').textContent = s.award?.status === 'proposed' ? `${s.award.clearedVendorIds.length} cleared · ${Object.values(s.award.assignments).filter(a => a.vendorId).length}/${r.lines.length} lines assigned` : 'No proposal';
  const proposal = s.award?.status === 'proposed' ? s.award : null;
  if (!proposal) { $('#awardAllocations').innerHTML = '<div class="empty">Record technical outcomes, then build a line-level allocation from cleared vendors.</div>'; $('#confirmAward').disabled = true; return; }
  const eligible = all.filter(v => s.qualification[v.vendorId]?.status === 'technically_cleared');
  const included = proposal.includedVendorIds || [];
  const selectors = eligible.map(v => `<label class="check"><input type="checkbox" data-award-include="${esc(v.vendorId)}"${included.includes(v.vendorId) ? ' checked' : ''}> Include ${esc(v.vendorName)}</label>`).join('') || '<span class="sub">Record a technically cleared outcome before selecting vendors.</span>';
  const rows = r.lines.map(l => {
    const a = proposal.assignments[l.sl];
    const opts = (a?.candidates || []).map(c => `<option value="${esc(c.vendorId)}"${a.vendorId === c.vendorId ? ' selected' : ''}>${esc(c.vendorName)} · ${fmt(c.price)}</option>`).join('');
    return `<tr><td>${esc(l.sl)}</td><td>${esc(l.official_part_number || l.catalog_ref || '')} · ${esc(l.description || '')}</td><td>${a?.vendorId ? `<select data-award-line="${esc(l.sl)}"><option value="">Unassigned</option>${opts}</select>` : '<span class="sub">Unassigned</span>'}</td><td class="num">${a?.price != null ? fmt(a.price) : '—'}</td></tr>`;
  }).join('');
  const totals = Object.entries(proposal.totals).map(([id, total]) => `<span class="pill p-info">${esc(all.find(v => v.vendorId === id)?.vendorName || id)} · ${fmt(total)}</span>`).join(' ');
  const gapBlock = proposal.clearedVendorIds.some(id => (s.qualification[id]?.unresolvedGapCount || 0) > 0 && !s.qualification[id]?.overrideReason?.trim());
  const reviewPending = proposal.reviewPendingVendorIds.length > 0;
  const usedVendorIds = new Set(Object.values(proposal.assignments).filter(a => a.vendorId).map(a => a.vendorId));
  proposal.zeroAssignmentVendorIds = (proposal.includedVendorIds || []).filter(id => !usedVendorIds.has(id));
  const noEmptyIncludes = proposal.zeroAssignmentVendorIds.length === 0;
  const recomputed = proposal.complete && proposal.pendingChecks.length === 0 && !gapBlock && !reviewPending && noEmptyIncludes && included.length > 0;
  proposal.canAward = recomputed;
  $('#awardAllocations').innerHTML = `<div class="btnrow award-includes">${selectors}</div><div class="hscroll"><table class="review-table"><thead><tr><th>Line</th><th>Requirement</th><th>Assigned vendor</th><th>Total for line</th></tr></thead><tbody>${rows}</tbody></table></div><div class="btnrow" style="margin-top:8px">${totals || '<span class="sub">No vendors included</span>'}</div>${!proposal.complete ? '<p class="error">Every RFx line must be assigned before award.</p>' : ''}${proposal.pendingChecks.length ? `<p class="error">Resolve material buyer confirmations for lines ${proposal.pendingChecks.join(', ')} before award.</p>` : ''}${gapBlock ? '<p class="error">A rationale is required for every cleared vendor with evidence gaps.</p>' : ''}${reviewPending ? '<p class="error">Review is incomplete for an included vendor; record an explicit buyer override before award.</p>' : ''}${!noEmptyIncludes ? `<p class="error">Remove vendors with no assigned lines: ${proposal.zeroAssignmentVendorIds.map(id => esc(all.find(v => v.vendorId === id)?.vendorName || id)).join(', ')}.</p>` : ''}`;
  $('#confirmAward').disabled = !recomputed;
  $$('#awardAllocations [data-award-include]').forEach(cb => cb.addEventListener('change', () => changeAwardInclusion(cb.dataset.awardInclude, cb.checked)));
  $$('#awardAllocations [data-award-line]').forEach(sel => sel.addEventListener('change', () => updateAwardAssignment(Number(sel.dataset.awardLine), sel.value)));
}
function updateAwardAssignment(sl, vendorId) {
  store.update(s => {
    if (!s.award || s.award.status !== 'proposed') return;
    const a = s.award.assignments[sl];
    const candidate = a?.candidates.find(c => c.vendorId === vendorId);
    s.award.assignments[sl] = { ...a, vendorId: candidate?.vendorId || null, price: candidate?.price ?? null };
    s.award.complete = Object.values(s.award.assignments).every(x => x.vendorId);
    s.award.totals = {};
    for (const x of Object.values(s.award.assignments)) if (x.vendorId) s.award.totals[x.vendorId] = (s.award.totals[x.vendorId] || 0) + x.price;
    s.award.pendingChecks = [];
    for (const [lineSl, assignment] of Object.entries(s.award.assignments)) if (assignment.vendorId) {
      if (s.confirmations.some(c => c.status === 'pending' && c.vendorId === assignment.vendorId && Number(c.evidence?.rfx_sl) === Number(lineSl))) s.award.pendingChecks.push(Number(lineSl));
    }
    const usedVendors = new Set(Object.values(s.award.assignments).filter(x => x.vendorId).map(x => x.vendorId));
    const zeroIncluded = s.award.includedVendorIds.some(id => !usedVendors.has(id));
    s.award.zeroAssignmentVendorIds = s.award.includedVendorIds.filter(id => !usedVendors.has(id));
    s.award.canAward = s.award.complete && !s.award.pendingChecks.length && !zeroIncluded && s.award.includedVendorIds.length > 0;
  });
}
function changeAwardInclusion(vendorId, included) {
  const s = store.get();
  const ids = new Set(s.award?.includedVendorIds || []);
  if (included) ids.add(vendorId); else ids.delete(vendorId);
  store.update(st => { st.award.includedVendorIds = [...ids]; });
  buildAward();
}
function openAwardConfirmation() {
  const s = store.get(), a = s.award;
  $('#awardModal .rowhead h2').textContent = 'Confirm RFx award';
  $('#awardCancel').textContent = 'Cancel'; $('#awardCancel').dataset.completed = 'false';
  $('#awardRationale').parentElement.hidden = false; $('#awardConfirmButton').hidden = false;
  $('#awardSuccess').hidden = true; $('#awardSuccess').textContent = '';
  if (!a?.canAward || !a.complete) { toast('Resolve the award blockers before confirming.'); return; }
  const counts = {};
  for (const x of Object.values(a.assignments)) if (x.vendorId) counts[x.vendorId] = (counts[x.vendorId] || 0) + 1;
  $('#awardConfirmSummary').innerHTML = `<p>Confirm this allocation across ${Object.keys(a.assignments).length} RFx lines?</p>${Object.entries(a.totals).map(([id, total]) => `<p>${esc(s.intake[id]?.vendorName || id)}: <b>${counts[id] || 0} lines · ${fmt(total)}</b></p>`).join('')}`;
  $('#awardModal').classList.add('show');
}
function confirmAward() {
  const rationale = $('#awardRationale').value.trim();
  if (!rationale) { toast('Enter an award rationale before confirming.'); return; }
  const before = store.get();
  if (!before.rfx || !before.award?.complete) { toast('The allocation changed. Review it before confirming.'); return; }
  const fresh = buildAwardProposal(before.rfx, Object.values(before.intake).filter(x => x?.normalized), before.qualification,
    Object.fromEntries(Object.entries(before.award.assignments || {}).map(([sl, a]) => [sl, a.vendorId])), before.confirmations, before.award.includedVendorIds || []);
  const assignedStillValid = Object.entries(before.award.assignments || {}).every(([sl, old]) => !!old.vendorId && !!fresh.assignments[sl]?.candidates?.some(c => c.vendorId === old.vendorId));
  const pendingAtCommit = Object.entries(before.award.assignments || {}).some(([sl, a]) => a.vendorId && before.confirmations.some(c => c.status === 'pending' && c.vendorId === a.vendorId && Number(c.evidence?.rfx_sl) === Number(sl)));
  if (!assignedStillValid || pendingAtCommit || !fresh.complete || fresh.pendingChecks.length || fresh.reviewPendingVendorIds.length || fresh.zeroAssignmentVendorIds.length) { toast('The allocation is no longer eligible. Review the updated blockers.'); buildAward(); return; }
  const awardedTitle = before.rfx.title;
  const finalAllocation = Object.entries(fresh.totals).map(([id, total]) => ({ vendorName: before.intake[id]?.vendorName || id, lines: Object.values(fresh.assignments).filter(a => a.vendorId === id).length, total }));
  let committed = false;
  store.update(s => {
    const current = buildAwardProposal(s.rfx, Object.values(s.intake).filter(x => x?.normalized), s.qualification,
      Object.fromEntries(Object.entries(s.award?.assignments || {}).map(([sl, a]) => [sl, a.vendorId])), s.confirmations, s.award?.includedVendorIds || []);
    // Revalidate assignments and material confirmations at commit time.
    const preservedAssignments = Object.fromEntries(Object.entries(s.award?.assignments || {}).map(([sl, a]) => [sl, a.vendorId]));
    let validAssignments = true;
    for (const [sl, a] of Object.entries(current.assignments)) {
      const requested = preservedAssignments[sl];
      const candidate = a.candidates.find(c => c.vendorId === requested);
      if (requested && candidate) { a.vendorId = candidate.vendorId; a.price = candidate.price; }
      else validAssignments = false;
    }
    const pending = Object.entries(current.assignments).some(([sl, a]) => a.vendorId && s.confirmations.some(c => c.status === 'pending' && c.vendorId === a.vendorId && Number(c.evidence?.rfx_sl) === Number(sl)));
    const complete = Object.values(current.assignments).every(a => a.vendorId);
    const gapsUnjustified = current.clearedVendorIds.some(id => (s.qualification[id]?.unresolvedGapCount || 0) > 0 && !s.qualification[id]?.overrideReason?.trim());
    if (!validAssignments || !complete || pending || current.reviewPendingVendorIds.length || current.zeroAssignmentVendorIds.length || gapsUnjustified || !current.clearedVendorIds.length) return;
    s.award = { ...current, assignments: current.assignments, status: 'proposed', rationale: '' };
    const finished = { id: s.rfx.id, title: s.rfx.title, lineCount: s.rfx.lines.length,
      vendorCount: Object.keys(s.award.totals).length, completedAt: new Date().toISOString(),
      rfx: s.rfx, intake: s.intake, confirmations: s.confirmations, qualification: s.qualification,
      award: { ...s.award, status: 'awarded', rationale, awardedAt: new Date().toISOString() } };
    s.completed = [...(s.completed || []), finished];
    s.rfx = null; s.intake = {}; s.confirmations = []; s.qualification = {}; s.award = null; s.compare = { vendorIds: [] };
    committed = true;
  });
  if (!committed) { toast('The allocation changed. Review it before confirming.'); return; }
  $('#awardSuccess').innerHTML = `<b>RFx awarded.</b> ${esc(awardedTitle)} has moved to Completed.`;
  $('#awardSuccess').hidden = false;
  $('#awardStatus').textContent = 'RFx awarded';
  $('#awardModal .rowhead h2').textContent = 'RFx awarded';
  $('#awardCancel').textContent = 'Return to pipeline'; $('#awardCancel').dataset.completed = 'true';
  $('#awardRationale').parentElement.hidden = true; $('#awardConfirmButton').hidden = true;
  $('#awardConfirmSummary').innerHTML = `<div class="banner"><b>${esc(awardedTitle)}</b> has been awarded and moved to Completed.</div><h3>Final allocation</h3>${finalAllocation.map(a => `<p>${esc(a.vendorName)}: ${a.lines} lines · ${fmt(a.total)}</p>`).join('')}<p><b>Buyer rationale:</b> ${esc(rationale)}</p>`;
  toast('RFx awarded. Review the confirmation before returning to the pipeline.');
}

function setVendorPickerOpen(open) {
  const trigger = $('#vendorPickerTrigger'), pop = $('#vendorPickerPop');
  if (!trigger || !pop) return;
  pop.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
}

function renderAllLines(s, r, received, commonLines, totals) {
  const loadedIds = received.map(n => n.vendorId);
  let selectedIds = (s.compare.vendorIds || []).filter(id => loadedIds.includes(id));
  // A new response joins an existing explicit comparison; a legacy empty
  // selection is initialized once to all currently loaded responses.
  if (!selectedIds.length && loadedIds.length) selectedIds = loadedIds;
  if (JSON.stringify(selectedIds) !== JSON.stringify(s.compare.vendorIds || [])) {
    store.update(st => { st.compare.vendorIds = selectedIds; });
    return;
  }
  const all = received.filter(n => selectedIds.includes(n.vendorId));
  const tableComparison = all.length ? lowestOnCommonSet(all) : { commonLines: 0, totals: [] };
  commonLines = tableComparison.commonLines;
  totals = tableComparison.totals;
  const cheap = cheapestPerLine(all);
  const q = ($('#lineSearch').value || '').toLowerCase();
  const issuesOnly = $('#issuesOnly').checked;

  // Compact accessible vendor multiselect for the table's common-set totals.
  const picker = $('#vendorPicker');
  picker.classList.add('vendor-picker');
  const wasOpen = $('#vendorPickerPop') && !$('#vendorPickerPop').hidden;
  picker.innerHTML = `<button type="button" id="vendorPickerTrigger" class="vendor-picker-trigger" aria-expanded="${wasOpen}" aria-controls="vendorPickerOptions" ${received.length ? '' : 'disabled'}>Vendors (${all.length} selected)<span aria-hidden="true"> ▾</span></button>
    <div id="vendorPickerPop" class="vendor-picker-popover" ${wasOpen ? '' : 'hidden'}>
      <div class="vendor-picker-actions"><span class="sub">Choose vendors for this table</span><button type="button" class="btn sm ghost" data-vp-all ${all.length === received.length ? 'disabled aria-disabled="true"' : ''}>Select all</button></div>
      <div id="vendorPickerOptions" class="vendor-picker-options" role="group" aria-label="Vendors included in table comparison">${received.map(n =>
      `<label class="vendor-picker-option"><input type="checkbox" data-vp="${esc(n.vendorId)}"${selectedIds.includes(n.vendorId) ? ' checked' : ''}>${esc(n.vendorName)}</label>`).join('') || '<span class="vendor-picker-empty">No vendor responses loaded</span>'}</div>
    </div>`;
  $('#vendorPickerTrigger').addEventListener('click', () => setVendorPickerOpen($('#vendorPickerPop').hidden));
  $$('#vendorPicker [data-vp]').forEach(cb => cb.addEventListener('change', () => {
    const ids = $$('#vendorPicker [data-vp]').filter(x => x.checked).map(x => x.dataset.vp);
    if (!ids.length) {
      cb.checked = true;
      toast('Keep at least one vendor selected.');
      return;
    }
    store.update(s2 => { s2.compare.vendorIds = ids; });
  }));
  $('#vendorPicker [data-vp-all]')?.addEventListener('click', () => {
    store.update(s2 => { s2.compare.vendorIds = [...loadedIds]; });
  });

  const head = `<tr><th>Line</th><th>Part · qty · delivery</th>${all.map(n => {
    const disclosure = cmpMode === 'comparable' ? conversionDisclosure(n, s.settings) : '';
    return `<th class="num"><span class="vendor-head">${esc(n.vendorName)}${disclosure}</span></th>`;
  }).join('')}<th>Evidence / coverage</th></tr>`;
  const body = r.lines.map(rl => {
    if (q && !(rl.description + ' ' + (rl.official_part_number || '') + ' ' + (rl.catalog_ref || '')).toLowerCase().includes(q)) return '';
    const cells = all.map(n => {
      const l = n.lines.find(x => x.rfx_sl === rl.sl);
      if (!l || l.normalized_inr_incl_gst == null) {
        const staged = l?.matched === 'proposed';
        return `<td class="num cmp-missing">${staged ? '<span class="staged" title="Staged — awaiting your confirmation">staged</span>' : '—'}</td>`;
      }
      const isCheap = cheap[rl.sl]?.vendorId === n.vendorId;
      const val = cmpMode === 'comparable'
        ? fmt(l.normalized_inr_incl_gst)
        : `${l.quoted_price} ${l.quoted_currency || ''}`.trim() + (l.quoted_basis ? ` <span class="sub">(${esc(l.quoted_basis)})</span>` : '');
      const actionable = l.flags.some(isActionablePriceFlag);
      const flagMark = actionable ? ` <span class="price-flag" title="Review this line" aria-label="Review this line">⚑</span>` : '';
      const exactConversion = cmpMode === 'comparable' && conversionRulesVary(n) && l.normalization_steps?.length
        ? conversionCellDisclosure(l, s.settings) : '';
      return `<td class="num${isCheap && cmpMode === 'comparable' && all.length > 1 ? ' cmp-cheap' : ''}"><button class="linklike" data-src="${n.vendorId}|${rl.sl}">${val}</button>${exactConversion}${flagMark}</td>`;
    }).join('');
    const covCount = all.filter(n => (n.lines.find(x => x.rfx_sl === rl.sl)?.normalized_inr_incl_gst != null)).length;
    const evCell = `<td><span class="sub">${covCount}/${all.length} quoted</span></td>`;
    const rowHtml = `<tr><td>${rl.sl}</td><td>${esc(rl.official_part_number || rl.catalog_ref || '—')}<br><span class="sub">${rl.quantity_nos} nos · ${esc(rl.delivery_location || '')}</span></td>${cells}${evCell}</tr>`;
    if (issuesOnly) {
      const hasIssue = all.some(n => {
        const l = n.lines.find(x => x.rfx_sl === rl.sl);
        return !l || l.normalized_inr_incl_gst == null || l.flags.some(isActionablePriceFlag);
      });
      return hasIssue ? rowHtml : '';
    }
    return rowHtml;
  }).join('');
  const foot = `<tr><td colspan="2"><b>${all.length === 1 ? `Quoted-line total (${commonLines} lines)` : `Total (${commonLines}-line common set)`}</b></td>${all.map(n => {
    const t = totals.find(t => t.vendorId === n.vendorId);
    const isLow = all.length > 1 && totals[0]?.vendorId === n.vendorId;
    return `<td class="num${isLow ? ' cmp-cheap' : ''}"><b>${t ? fmt(t.total) : '—'}</b></td>`;
  }).join('')}<td></td></tr>`;
  $('#cmpTable thead').innerHTML = head;
  $('#cmpTable tbody').innerHTML = body + foot;
  $$('#cmpTable [data-src]').forEach(b => b.addEventListener('click', () => showResponse(b.dataset.src.split('|')[0])));
}

function conversionSignature(line) { return (line.normalization_steps || []).join('|') || 'none'; }
function conversionRulesVary(normalized) {
  const signatures = new Set(normalized.lines.filter(l => l.quoted_price != null).map(conversionSignature));
  return signatures.size > 1;
}
function conversionDisclosure(normalized, settings) {
  const priced = normalized.lines.filter(l => l.quoted_price != null && l.normalized_inr_incl_gst != null);
  if (!priced.length) return '';
  const detail = conversionRuleText(normalized, settings);
  return `<details class="conversion-info"><summary aria-label="Conversion rule for ${esc(normalized.vendorName)}" title="${esc(detail)}">ⓘ</summary><span role="tooltip">${esc(detail)}</span></details>`;
}
function conversionCellDisclosure(line, settings) {
  const detail = comparableCalculation(line, settings);
  return `<details class="conversion-cell"><summary aria-label="Show line ${line.rfx_sl} conversion" title="${esc(detail)}">ⓘ</summary><span role="tooltip">${esc(detail)}</span></details>`;
}

async function sendAnalystText(text) {
  if (!text || needKey()) return;
  const input = $('#analystInput');
  input.value = '';
  const chat = $('#analystChat');
  chat.insertAdjacentHTML('beforeend', `<div class="msg buyer"><span class="who">Buyer</span>${renderChatText(text)}</div>`);
  chat.insertAdjacentHTML('beforeend', `<div class="msg bot thinking"><span class="who">Analyst</span>…</div>`);
  chat.scrollTop = chat.scrollHeight;
  try {
    await runAnalystTurn({ store, settings: store.get().settings }, text);
  } catch (err) {
    store.update(s => { s.analyst.messages.push({ role: 'assistant', content: `I couldn't answer that (${err.message}). Try again.` }); });
  }
  renderAnalysis();
}

// ---------- dispatcher ----------
function renderScreen(id) {
  ({ 's-home': renderHome, 's-draft': renderDraft, 's-review': renderReview,
     's-published': renderPublished, 's-intake': renderIntake, 's-analysis': renderAnalysis })[id]?.();
}

document.body.classList.add('auth-locked');
let cloudClient;
const authError = $('#authError');
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const button = $('#authSubmit'); button.disabled = true; authError.textContent = '';
  try {
    const { error } = await cloudClient.auth.signInWithPassword({ email: $('#authEmail').value.trim(), password: $('#authPassword').value });
    if (error) throw error;
  } catch (err) { authError.textContent = err.message; }
  finally { button.disabled = false; }
});
$('#authSignout').addEventListener('click', () => cloudClient.auth.signOut());
$('#headerSignout').addEventListener('click', () => cloudClient.auth.signOut());
connectSharedWorkspace().then(async client => {
  cloudClient = client;
  const { data: { session } } = await client.auth.getSession();
  if (session) {
    $('#authForm').hidden = true;
    try { await boot(client); }
    catch (err) { authError.textContent = err.message; $('#authForm').hidden = false; $('#authSignout').hidden = false; }
  }
  client.auth.onAuthStateChange(async (event, sessionNow) => {
    // Supabase emits INITIAL_SESSION with null for a signed-out visitor.
    // Reload only for an explicit sign-out; otherwise the login page loops.
    if (event === 'SIGNED_OUT') { location.reload(); return; }
    if (!sessionNow) return;
    if (!store) {
      $('#authForm').hidden = true;
      try { await boot(client); } catch (err) { authError.textContent = err.message; $('#authForm').hidden = false; }
    }
  });
}).catch(err => {
  authError.textContent = err.message;
  $('#authForm').hidden = false;
  if (cloudClient) $('#authSignout').hidden = false;
});
