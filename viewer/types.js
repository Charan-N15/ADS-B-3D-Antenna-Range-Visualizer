// Aircraft types, and the silhouette each aircraft is drawn with.
//
// readsb's aircraft.json carries no type designator: tar1090 looks types up in
// the browser, from a database it ships beside its own page. This reads that same
// database, the same way: hex -> type designator from a tree of shards, then
// designator -> ICAO description ("L2J": landplane, 2 engines, jet) and wake
// category from one table. Nothing from it is copied into this project; it is
// read at runtime from the receiver's own tar1090.
//
// When the database cannot be found, or does not know an aircraft, the shape
// falls back to the ADS-B emitter category most aircraft broadcast themselves.

/** Emitter category -> shape, for aircraft the database cannot place. */
const BY_CATEGORY = {
  A1: 'piston', A2: 'bizjet', A3: 'airliner', A4: 'airliner', A5: 'heavy',
  A6: 'fighter', A7: 'helicopter', B1: 'glider', B2: 'balloon', B4: 'piston',
  B6: 'drone',
};

let database = null;            // Promise<string|null>: the database folder URL
let typeTable = null;           // Promise<object|null>: designator -> {desc, wtc}
const shards = new Map();       // shard key -> Promise<object|null>
const resolved = new Map();     // hex -> {type, desc, wtc} | null
const pending = new Set();

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** tar1090 names its database folder after a hash and writes that into its page. */
async function findDatabase(tar1090Url) {
  const page = new URL(tar1090Url, location.href);
  const resp = await fetch(page);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const match = /databaseFolder\s*=\s*["']([^"']+)["']/.exec(await resp.text());
  if (!match) throw new Error('no databaseFolder in the tar1090 page');
  return new URL(`${match[1]}/`, page).href;
}

/** Newer tar1090 keeps [name, desc, wtc]; older keeps {desc, wtc}. */
async function loadTypeTable(base) {
  for (const name of ['icao_aircraft_types2.js', 'icao_aircraft_types.js']) {
    try {
      const raw = await fetchJson(base + name);
      const table = {};
      for (const [designator, v] of Object.entries(raw)) {
        table[designator] = Array.isArray(v) ? { desc: v[1], wtc: v[2] } : v;
      }
      return table;
    } catch (err) {
      // try the other name
    }
  }
  throw new Error('no aircraft type table');
}

function shard(base, key) {
  if (!shards.has(key)) {
    shards.set(key, fetchJson(`${base}${key}.js`).catch(() => null));
  }
  return shards.get(key);
}

/** Walks the shard tree as tar1090 does: A.js, then A7.js, and so on. */
async function designatorFor(base, hex) {
  const id = hex.toUpperCase();
  for (let level = 1; level < id.length; level++) {
    const key = id.slice(0, level);
    const rest = id.slice(level);
    const data = await shard(base, key);
    if (!data) return null;
    if (rest in data) return data[rest][1] || null;
    if (!(data.children || []).includes(key + rest[0])) return null;
  }
  return null;
}

/** Starts reading tar1090's database. Safe to call once at startup. */
export function initTypes(tar1090Url) {
  database = findDatabase(tar1090Url).catch((err) => {
    console.info(`aircraft types unavailable, shapes from emitter category only: ${err.message}`);
    return null;
  });
  typeTable = database.then((base) => (base ? loadTypeTable(base) : null)).catch((err) => {
    console.info(`aircraft types unavailable: ${err.message}`);
    return null;
  });
}

/**
 * What the database says about an aircraft, or undefined while it is still being
 * looked up. Never waits: the first call starts the lookup, and a later refresh
 * picks the answer up.
 */
export function typeOf(hex) {
  if (resolved.has(hex)) return resolved.get(hex);
  // A leading ~ marks a non-ICAO address, which the database cannot hold.
  if (!database || !hex || hex[0] === '~' || pending.has(hex)) return undefined;
  pending.add(hex);
  Promise.all([database, typeTable])
    .then(async ([base, table]) => {
      const type = base && table ? await designatorFor(base, hex) : null;
      const info = type && table[type];
      resolved.set(hex, info ? { type, desc: info.desc, wtc: info.wtc } : null);
    })
    .catch(() => resolved.set(hex, null))
    .finally(() => pending.delete(hex));
  return undefined;
}

/**
 * The silhouette for an aircraft, from its ICAO description where known.
 * The description is kind, engine count, engine type: "L2J" is a landplane with
 * two jets, "H1T" a single-turbine helicopter. Wake category settles the size,
 * and the emitter category breaks the one tie the description cannot, a small
 * twin jet against an airliner, since both are "L2J" with medium wake.
 */
export function shapeFor(category, info) {
  if (info && info.desc && info.desc.length >= 3) {
    const [kind, engines, power] = info.desc;
    const wtc = info.wtc;
    if (kind === 'H' || kind === 'G') return 'helicopter';
    if (kind === 'B') return 'balloon';
    if (engines === '0') return 'glider';
    if (power === 'J') {
      if (engines === '4') return 'quad';
      if (wtc === 'H' || wtc === 'J') return 'heavy';
      if (wtc === 'L') return 'bizjet';
      if (engines === '1') return 'fighter';
      if (category === 'A1' || category === 'A2') return 'bizjet';
      if (category === 'A5') return 'heavy';
      if (category === 'A6') return 'fighter';
      return 'airliner';
    }
    if (power === 'T' || kind === 'T') return 'turboprop';
    if (power === 'P' || power === 'E') return 'piston';
    if (wtc === 'H' || wtc === 'J') return 'heavy';
  }
  return BY_CATEGORY[category] || 'generic';
}
