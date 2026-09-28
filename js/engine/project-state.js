// Keep one RFx in the existing screen state; park other published RFx here.
// This lets the established review screens operate on one selected RFx at a time.
const EMPTY_ANALYST = () => ({ messages: [] });

export function captureLive(s) {
  if (!s.rfx) return null;
  return {
    rfx: s.rfx,
    intake: s.intake,
    confirmations: s.confirmations,
    qualification: s.qualification,
    analyst: s.analyst,
    analystPendingOutcome: s.analystPendingOutcome || null,
    compare: s.compare,
    award: s.award,
  };
}

export function clearLive(s) {
  s.rfx = null;
  s.intake = {};
  s.confirmations = [];
  s.qualification = {};
  s.analyst = EMPTY_ANALYST();
  s.analystPendingOutcome = null;
  s.compare = { vendorIds: [] };
  s.award = null;
}

export function restoreLive(s, project) {
  clearLive(s);
  if (!project) return;
  s.rfx = project.rfx;
  s.intake = project.intake || {};
  s.confirmations = project.confirmations || [];
  s.qualification = project.qualification || {};
  s.analyst = project.analyst || EMPTY_ANALYST();
  s.analystPendingOutcome = project.analystPendingOutcome || null;
  s.compare = project.compare || { vendorIds: [] };
  s.award = project.award || null;
}

export function activateLive(s, parkedIndex) {
  const parked = s.otherLive || [];
  if (!Number.isInteger(parkedIndex) || parkedIndex < 0 || parkedIndex >= parked.length) return false;
  const selected = parked.splice(parkedIndex, 1)[0];
  const current = captureLive(s);
  if (current) parked.push(current);
  s.otherLive = parked;
  restoreLive(s, selected);
  return true;
}

export function deleteProject(s, target) {
  if (target?.kind === 'draft' && s.draft) {
    s.draft = null;
    return true;
  }
  if (target?.kind === 'live') {
    if (target.active && s.rfx?.internal_id === target.id) {
      clearLive(s);
      return true;
    }
    const index = (s.otherLive || []).findIndex(p => p.rfx?.internal_id === target.id);
    if (index >= 0) {
      s.otherLive.splice(index, 1);
      return true;
    }
  }
  if (target?.kind === 'completed') {
    const index = (s.completed || []).findIndex(p => p.completedAt === target.completedAt);
    if (index >= 0) {
      s.completed.splice(index, 1);
      return true;
    }
  }
  return false;
}
