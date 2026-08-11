// -----------------------------------------------------------------------------
// STORAGE ADAPTER — provides the exact same interface the app used on the
// old artifact platform (window.storage.get / .set), but backed by the
// Supabase database instead. The rest of the app is completely unaware
// anything changed: same function names, same return shapes, same error
// behaviour (throws on genuine failure, which the app's existing retry
// logic already handles).
//
// Table: public.plp_storage (key text primary key, value text, updated_at)
// -----------------------------------------------------------------------------
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabaseConfig.js";

const REST = `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/plp_storage`;

const HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

// Matches the old platform's shape: resolves to { key, value, shared } when
// the key exists, or null when it has never been written.
async function get(key, _shared) {
  const url = `${REST}?select=value&key=eq.${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Storage read failed (${res.status})`);
  const rows = await res.json();
  if (!rows.length) return null;
  return { key, value: rows[0].value, shared: true };
}

// Upsert: inserts the row if it's new, overwrites the value if it exists.
async function set(key, value, _shared) {
  const res = await fetch(REST, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch { /* ignore */ }
    throw new Error(`Storage write failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return { key, value, shared: true };
}

// Atomic compare-and-swap: updates `key` to newValue ONLY if its current
// value is still exactly expectedValue — the database itself enforces this
// in one operation, so two tabs racing to save can never both win. Returns
// true if the swap happened, false if someone else changed the value first.
// Used by the app's stale-write protection (see REV_KEY in App.jsx).
async function compareAndSwap(key, expectedValue, newValue) {
  const url = `${REST}?key=eq.${encodeURIComponent(key)}&value=eq.${encodeURIComponent(expectedValue)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...HEADERS, Prefer: "return=representation" },
    body: JSON.stringify({ value: newValue, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Storage update failed (${res.status})`);
  const rows = await res.json();
  return rows.length > 0;
}

// The app never deletes or lists keys, but the old interface had these, so
// they exist for completeness. Deletes are blocked by the database's access
// rules on purpose — see the table setup SQL.
async function del(_key, _shared) {
  throw new Error("Deleting storage keys is intentionally disabled.");
}
async function list(prefix = "", _shared) {
  const url = `${REST}?select=key${prefix ? `&key=like.${encodeURIComponent(prefix)}*` : ""}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Storage list failed (${res.status})`);
  const rows = await res.json();
  return { keys: rows.map((r) => r.key), prefix, shared: true };
}

export const storage = { get, set, delete: del, list, compareAndSwap };
