// Saved view settings.
//
// Everything lives in this viewer's own localStorage, so settings are per browser
// and per device and never leave the machine. That is the right scope: what one
// person likes looking at says nothing about what anyone else wants, and the
// collector's data is the only thing worth sharing.
//
// localStorage can be absent or throw outright — private windows, blocked site data,
// some kiosk configurations — so every access is guarded and the viewer is expected
// to work perfectly well when it fails.

const KEY = 'range3d.settings.v1';

/** Returns the saved settings object, or null if there are none or storage is unusable. */
export function loadSettings() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

/** Persists the settings object. Returns true if it actually stuck. */
export function saveSettings(settings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
    return true;
  } catch (err) {
    return false;
  }
}

/** Forgets saved settings. Returns true if storage was reachable. */
export function clearSettings() {
  try {
    window.localStorage.removeItem(KEY);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Merges saved values onto defaults, one level deep so `layers` merges rather than
 * replaces. Unknown keys are dropped: a settings blob written by a newer version
 * must never introduce state this build does not understand.
 */
export function mergeSettings(defaults, saved) {
  if (!saved) return defaults;
  const out = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = saved[key];
    if (value === undefined) continue;
    const base = defaults[key];
    if (base && typeof base === 'object' && !Array.isArray(base)) {
      out[key] = { ...base };
      for (const sub of Object.keys(base)) {
        if (typeof saved[key][sub] === typeof base[sub]) {
          out[key][sub] = saved[key][sub];
        }
      }
    } else if (typeof value === typeof base) {
      out[key] = value;
    }
  }
  return out;
}
