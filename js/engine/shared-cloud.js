const TABLE = 'shared_workspace';
const ROW_ID = '00000000-0000-0000-0000-000000000001';
const ORIGINALS_BUCKET = 'vendor-originals';

export async function connectSharedWorkspace() {
  const cfg = window.AERCHAIN_SUPABASE;
  if (!cfg?.url || !cfg?.publishableKey || cfg.url.includes('YOUR_PROJECT') || cfg.publishableKey.includes('YOUR_')) {
    throw new Error('Configure supabase-config.js before signing in.');
  }
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const client = createClient(cfg.url, cfg.publishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

export async function loadWorkspace(client) {
  const { data, error } = await client.from(TABLE).select('state, revision, updated_at').eq('id', ROW_ID).single();
  if (error) throw error;
  if (!data) throw new Error('No shared workspace row is available to this account. Check the configured owner UID and setup.sql.');
  return { ...data, revision: Number(data.revision) || 0 };
}

export async function saveWorkspace(client, state, revision) {
  // Compare-and-swap revision: a stale browser cannot silently overwrite newer work.
  const { data, error } = await client.from(TABLE).update({ state, revision: revision + 1, updated_at: new Date().toISOString() })
    .eq('id', ROW_ID).eq('revision', revision).select('revision').maybeSingle();
  if (error) throw error;
  if (!data) return { conflict: true };
  return { conflict: false, revision: Number(data.revision) || revision + 1 };
}

export async function uploadOriginal(client, userId, vendorId, file) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${userId}/${vendorId}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await client.storage.from(ORIGINALS_BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw error;
  return path;
}

export async function downloadOriginal(client, path) {
  const { data, error } = await client.storage.from(ORIGINALS_BUCKET).download(path);
  if (error) throw error;
  return data;
}
