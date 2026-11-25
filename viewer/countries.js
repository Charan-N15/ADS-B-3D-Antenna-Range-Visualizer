// Country of registration, from the aircraft's ICAO address.
//
// Every 24-bit ICAO address is issued from a block assigned to one country, so
// the address alone says where an aircraft is registered. tar1090 already ships
// that table, and a flag image for each country, so both are read from the
// receiver's own tar1090 at runtime rather than copied here. If its table cannot
// be found, aircraft simply show no flag.

const RANGE = /start:\s*0x([0-9a-f]+)\s*,\s*end:\s*0x([0-9a-f]+)\s*,\s*country:\s*"([^"]*)"\s*,\s*country_code:\s*(?:"([a-z]{2})"|null)/gi;

let ranges = [];          // [{ start, end, name, code }], by start
let base = '';
const flags = new Map();  // country code -> Image

/**
 * Finds tar1090's address table, whose file name carries a version hash, from
 * tar1090's own page. The table is read as text and never run.
 */
export async function initCountries(tar1090Url) {
  base = tar1090Url;
  try {
    const page = await (await fetch(tar1090Url, { cache: 'no-cache' })).text();
    const match = page.match(/src="(flags[^"]*\.js)"/);
    if (!match) throw new Error('no flags script on the tar1090 page');
    const text = await (await fetch(new URL(match[1], new URL(tar1090Url, location.href)))).text();
    const found = [];
    for (const m of text.matchAll(RANGE)) {
      found.push({
        start: parseInt(m[1], 16), end: parseInt(m[2], 16), name: m[3], code: m[4] || null,
      });
    }
    ranges = found.sort((a, b) => a.start - b.start);
  } catch (err) {
    console.info(`country flags unavailable: ${err.message}`);
  }
}

/** { name, code } for an ICAO address, or null when it is in no country's block. */
export function countryOf(hex) {
  if (!hex || hex[0] === '~' || !ranges.length) return null;
  const n = parseInt(hex, 16);
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (n < r.start) hi = mid - 1;
    else if (n > r.end) lo = mid + 1;
    else return r;
  }
  return null;
}

/**
 * The flag for a country code, loading on first ask. Returns null until it has
 * loaded, so a label draws without it rather than waiting.
 */
export function flagImage(code) {
  if (!code) return null;
  let img = flags.get(code);
  if (!img) {
    img = new Image();
    img.src = `${base}flags/3x2/${code.toUpperCase()}.svg`;
    flags.set(code, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Where a flag image is, for the panel's preview. */
export function flagUrl(code) {
  return `${base}flags/3x2/${code.toUpperCase()}.svg`;
}
