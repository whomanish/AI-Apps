// Tiny pub/sub store with pluggable persistence. DOM-free.
// The UI subscribes to slices; the engine mutates via actions.
// Persistence adapter: { load(), save(state) }. Browser passes a localStorage
// wrapper; Node tests pass an in-memory stub.

import { DEFAULT_SETTINGS } from './config.js';

export function createStore(persist) {
  const state = initialState();
  const subs = new Set();

  if (persist) {
    try {
      const saved = persist.load();
      if (saved) Object.assign(state, saved);
    } catch { /* corrupted save -> start fresh */ }
  }

  function get() { return state; }

  function set(patch) {
    Object.assign(state, patch);
    saveSoon();
    subs.forEach(fn => { try { fn(state); } catch {} });
  }

  // mutate nested state in place, then notify
  function update(fn) {
    fn(state);
    saveSoon();
    subs.forEach(s => { try { s(state); } catch {} });
  }

  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

  let timer = null;
  function saveSoon() {
    if (!persist) return;
    clearTimeout(timer);
    timer = setTimeout(() => { try { persist.save(pickPersisted(state)); } catch {} }, 250);
  }

  return { get, set, update, subscribe };
}

// Only buyer-owned, resumable state survives a refresh. API keys never persist.
function pickPersisted(s) {
  return {
    version: 2,
    settings: { ...s.settings, apiKey: '' },
    draft: s.draft,
    rfx: s.rfx,
    otherLive: s.otherLive || [],
    intake: s.intake,
    confirmations: s.confirmations,
    qualification: s.qualification,
    analystPendingOutcome: s.analystPendingOutcome || null,
    analyst: s.analyst || { messages: [] },
    compare: s.compare,
    award: s.award || null,
    completed: s.completed || [],
  };
}

export function initialState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    draft: null,        // { messages:[], historyChat:[], rfx:{...}, specConflict }
    rfx: null,          // published RFx: { id, title, lines[], terms[], questions[], header, publishedAt }
    otherLive: [],      // other published RFx snapshots; one selected RFx stays in rfx
    intake: {},         // vendorId -> { status, extracted[], normalized[], flags[], questionnaire, files, error }
    confirmations: [],  // buyer review queue items
    analyst: { messages: [] },
    analystPendingOutcome: null,
    compare: { vendorIds: [] },  // selected vendors for the comparison grid
    qualification: {},  // vendorId -> { status:'pending', rationale } (read-only in this build)
    award: null,        // buyer-confirmed allocation for the published RFx
    completed: [],      // retained read-only pipeline summaries
  };
}
