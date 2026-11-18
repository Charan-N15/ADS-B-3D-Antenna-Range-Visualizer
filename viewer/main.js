// range3d viewer: altitude-resolved coverage envelope over a live traffic scene.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  loadEnvelope, buildGrid, summarize, cellRecord, rangeAt, topAltitudeFt,
} from './envelope.js';
import {
  buildGround, buildEnvelopeSurface, buildContourRings, buildHorizonSurface,
  buildCellHighlight, AircraftLayer, TrailLayer,
} from './layers.js';
import { loadBasemap, buildBasemapDisc } from './basemap.js';
import { altitudeCss, LEGEND_ALTITUDES } from './altitude.js';
import {
  loadSettings, saveSettings, clearSettings, mergeSettings,
} from './settings.js';
import { SliceView } from './slice.js';
import { TAR1090_PATH } from './config.js';
import { initTypes, typeOf, shapeFor } from './types.js';
import { LabelLayer, DEFAULT_LABEL_FIELDS, labelLines } from './labels.js';
import { PLANE_PX } from './shapes.js';
import {
  loadHeatmap, buildTubeTexture, buildHeatVolume, summarizeHeat, hitsForBusiest,
} from './heat.js';

const params = new URLSearchParams(location.search);
const ENVELOPE_URL = params.get('envelope') || 'state/envelope.json';
const HEAT_URL = params.get('heatmap') || 'state/heatmap';
// Where the "return to 2D" link goes, and where live traffic is read from. Both
// hang off one path so they cannot drift apart: a receiver that serves tar1090
// from somewhere else breaks both or neither. config.js holds the installed
// location; the trailing slash is forced so ?tar1090=/adsbx works too.
const TAR1090_URL = (params.get('tar1090') || TAR1090_PATH).replace(/\/?$/, '/');
const AIRCRAFT_URL = params.get('aircraft') || `${TAR1090_URL}data/aircraft.json`;
initTypes(TAR1090_URL);
const ENVELOPE_REFRESH_MS = 60000;
// The collector rewrites the heatmap every five minutes; no point asking sooner.
const HEAT_REFRESH_MS = 300000;
// The map is always drawn at full strength; the darkened tiles carry no glare.
const MAP_OPACITY = 1;
const AIRCRAFT_REFRESH_MS = 1000;
const CONTOUR_ALTITUDES = [2000, 5000, 10000, 20000, 30000, 40000];

/** The highest altitude the collector keeps, and so the top of the filter. */
const ALT_TOP_FT = 53000;

const el = (id) => document.getElementById(id);

const DEFAULT_UI = {
  view: 'orbit',
  layers: {
    envelope: true, contours: true, horizon: false, ground: true,
    basemap: true, footprint: true, aircraft3d: true,
    heat: false, labels: false, trails: false,
  },
  labelFields: { ...DEFAULT_LABEL_FIELDS },
  heatBusiestPct: 30,
  extendHorizon: false,
  altMinFt: 0,
  altMaxFt: ALT_TOP_FT,
  exag: 8,
  curvature: true,
  colorByAlt: true,
  smoothDeg: 7,
  minHits: 1,
  planeScale: 1,
  closure: true,
  rxAltFt: 100,
  sliceAz: 0,
  sliceSpread: 5,
  section: 'layers',
  panelCollapsed: false,
};

// Saved settings are a convenience, never a requirement: if storage is unreadable
// this is simply the defaults.
const savedSettings = loadSettings();
const hasSavedSettings = savedSettings !== null;
const ui = mergeSettings(DEFAULT_UI, savedSettings);

// Live traffic was saved as `aircraft` up to v1.1 and as `aircraft3d` after,
// when a 2D layer sat beside it; the 2D layer has gone but the name stays, so
// views saved since carry over. mergeSettings drops keys it does not know, so
// without this a v1.1 view with traffic switched off would come back with it on.
if (savedSettings && savedSettings.layers
    && typeof savedSettings.layers.aircraft === 'boolean'
    && savedSettings.layers.aircraft3d === undefined) {
  ui.layers.aircraft3d = savedSettings.layers.aircraft;
}

// Extend to top is hidden while the horizon is off, so a view saved before that
// with it on and the horizon off would come back with curvature switched off
// and nothing on screen saying why.
if (!ui.layers.horizon) ui.extendHorizon = false;

// The filter topped out at 50,000 ft before the bands went higher, so a view saved
// then with it wide open would now hide everything above 50,000.
if (savedSettings && [50000, 60000].includes(savedSettings.altMaxFt)) ui.altMaxFt = ALT_TOP_FT;

let doc = null;        // raw envelope state
let model = null;      // gridded form
let maxRangeNm = 100;
let contacts = [];

// ---------------------------------------------------------------- three.js setup

const sceneCanvas = el('scene');
const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true });
renderer.setClearColor(0x0c0c0c, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
camera.position.set(0, -140, 90);

const controls = new OrbitControls(camera, sceneCanvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.98;

const aircraftLayer = new AircraftLayer();
aircraftLayer.planeScale = ui.planeScale;
scene.add(aircraftLayer.group);

const trailLayer = new TrailLayer();
scene.add(trailLayer.group);

const labelLayer = new LabelLayer(el('labels'));

const slice = new SliceView(el('slice'));
const raycaster = new THREE.Raycaster();

let groundGroup = null;
let envelopeGroup = null;
let contourGroup = null;
let horizonGroup = null;
let footprintGroup = null;
let basemap = null;      // loaded tiles and texture, built once
let basemapMesh = null;  // rebuilt whenever the projection changes
let heat = null;         // the collector's heatmap, refetched every few minutes
let heatVolumeTex = null;   // the routes as tubes in a 3D texture
let heatVolumeKey = null;
let heatVolume = null;   // the counts in the air, at the heights flown
let selectedCell = null; // { az, band } clicked on the envelope, or null
let cellHighlight = null;

function viewOpts() {
  return {
    rxAltFt: ui.rxAltFt,
    exag: ui.exag,
    curvature: ui.curvature,
    colorByAlt: ui.colorByAlt,
    altMinFt: ui.altMinFt,
    altMaxFt: ui.altMaxFt,
  };
}

/** True when the altitude filter is showing everything. */
function altFilterIsOpen() {
  return ui.altMinFt <= 0 && ui.altMaxFt >= ALT_TOP_FT;
}

/** Live traffic inside the altitude window. */
function visibleContacts() {
  if (altFilterIsOpen()) return contacts;
  return contacts.filter(
    (c) => c.altFt >= ui.altMinFt && c.altFt <= ui.altMaxFt);
}

function renderAltitudeLegend() {
  const list = el('altLegend');
  list.innerHTML = '';
  for (const altFt of LEGEND_ALTITUDES) {
    const item = document.createElement('li');
    const chip = document.createElement('i');
    chip.style.background = altitudeCss(altFt);
    const label = document.createElement('span');
    label.textContent = altFt === 0 ? 'sfc' : `${altFt / 1000}k`;
    item.append(chip, label);
    list.append(item);
  }
  el('altLegendGroup').hidden = !ui.colorByAlt;
}

function disposeGroup(group) {
  if (!group) return;
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
  scene.remove(group);
}

function rebuildScene() {
  if (!model) return;
  const opts = viewOpts();

  // The tile texture is shared and expensive; disposing materials here never
  // touches it, so the map is composed once and reprojected cheaply.
  disposeGroup(groundGroup);
  disposeGroup(envelopeGroup);
  disposeGroup(contourGroup);
  disposeGroup(footprintGroup);
  disposeGroup(horizonGroup);
  disposeGroup(basemapMesh);
  basemapMesh = null;

  groundGroup = buildGround(maxRangeNm, opts);
  envelopeGroup = buildEnvelopeSurface(model, opts);
  contourGroup = buildContourRings(model, CONTOUR_ALTITUDES, opts);
  footprintGroup = buildContourRings(model, CONTOUR_ALTITUDES, opts, true);
  horizonGroup = buildHorizonSurface(
    maxRangeNm, opts, ui.extendHorizon ? topAltitudeFt(model) : 0);
  scene.add(groundGroup, envelopeGroup, contourGroup, footprintGroup,
    horizonGroup);

  if (basemap && doc?.rx?.lat != null) {
    const radius = Math.min(maxRangeNm, basemap.meta.radiusNm);
    basemapMesh = buildBasemapDisc(basemap, doc.rx, radius, opts, MAP_OPACITY);
    scene.add(basemapMesh);
  }
  rebuildHeat();
  updateCellHighlight();
  applyLayerVisibility();
  // Re-filtered here as well as on each poll, because changing the altitude
  // window has to take effect without waiting for the next second of data.
  updateTraffic();
}

/** Puts the current traffic, and where it has been, into the scene. */
function updateTraffic() {
  const shown = visibleContacts();
  const opts = viewOpts();
  aircraftLayer.setContacts(shown);
  aircraftLayer.update(opts);
  // Each trail ends at the aircraft itself, not at the last point kept.
  trailLayer.update(shown.map((c) => [...(trails.get(c.hex) || []), c]), opts);
}

function applyLayerVisibility() {
  if (groundGroup) groundGroup.visible = ui.layers.ground;
  if (envelopeGroup) envelopeGroup.visible = ui.layers.envelope;
  if (cellHighlight) cellHighlight.visible = ui.layers.envelope;
  if (contourGroup) contourGroup.visible = ui.layers.contours;
  if (horizonGroup) horizonGroup.visible = ui.layers.horizon;
  if (footprintGroup) footprintGroup.visible = ui.layers.footprint;
  if (basemapMesh) basemapMesh.visible = ui.layers.basemap;
  if (heatVolume) heatVolume.visible = ui.layers.heat;
  aircraftLayer.setVisibility(ui.layers.aircraft3d);
  trailLayer.setVisibility(ui.layers.aircraft3d && ui.layers.trails);
}

function rebuildHeat() {
  disposeGroup(heatVolume);
  heatVolume = null;
  if (!heat) return;
  // The tubes depend on the data, on which routes are busy enough to show, and
  // on the exaggeration, which sets how tall a round tube is in feet. The
  // altitude window and colour mode are applied by the shader, so they rebuild
  // nothing.
  const minHits = hitsForBusiest(heat, ui.heatBusiestPct);
  const key = `${heat.meta.updated}|${minHits}|${ui.exag}`;
  if (heatVolumeKey !== key) {
    if (heatVolumeTex) heatVolumeTex.dispose();
    heatVolumeTex = buildTubeTexture(heat, { minHits, exag: ui.exag });
    heatVolumeKey = key;
  }
  heatVolume = buildHeatVolume(heatVolumeTex, viewOpts());
  if (heatVolume) {
    heatVolume.visible = ui.layers.heat;
    scene.add(heatVolume);
  }
}

/**
 * Rebuilt from the surface each time, rather than kept, because anything that
 * moves the surface (exaggeration, curvature, a new envelope) moves the cell.
 */
function updateCellHighlight() {
  disposeGroup(cellHighlight);
  cellHighlight = null;
  if (!selectedCell || !envelopeGroup) return;
  cellHighlight = buildCellHighlight(envelopeGroup.userData.mesh,
    selectedCell.az, selectedCell.band);
  if (!cellHighlight) return;
  cellHighlight.visible = ui.layers.envelope;
  scene.add(cellHighlight);
}

async function initBasemap() {
  try {
    basemap = await loadBasemap();
    el('attribution').textContent = basemap.meta.attribution || '';
    rebuildScene();
  } catch (err) {
    // No tiles is not a failure worth shouting about; the scope works without them.
    el('attribution').textContent = '';
    console.warn('basemap unavailable:', err.message);
    el('layerBasemap').disabled = true;
  }
}

// ------------------------------------------------------------------------ data

function computeMaxRange(m) {
  let best = 0;
  for (let i = 0; i < m.grid.length; i++) if (m.grid[i] > best) best = m.grid[i];
  return Math.max(50, Math.ceil(best / 25) * 25);
}

function rebuildModel() {
  if (!doc) return;
  model = buildGrid(doc, {
    minHits: ui.minHits, closure: ui.closure, smoothDeg: ui.smoothDeg,
  });
  maxRangeNm = computeMaxRange(model);
  slice.maxRangeNm = maxRangeNm;
  renderStats();
  rebuildScene();
}

async function refreshEnvelope(first) {
  try {
    doc = await loadEnvelope(ENVELOPE_URL);
    // The collector's configured antenna height is the installation's truth, but a
    // setting this browser explicitly saved was a deliberate choice, so it wins.
    // RESET gets you back to whatever the collector says.
    if (first && !hasSavedSettings && typeof doc.rx?.altFt === 'number') {
      ui.rxAltFt = doc.rx.altFt;
      el('rxAlt').value = String(doc.rx.altFt);
    }
    rebuildModel();
    if (first) frameCamera();
    setStatus(null);
  } catch (err) {
    setStatus(`envelope: ${err.message}`, true);
  }
}

async function refreshHeat() {
  try {
    heat = await loadHeatmap(HEAT_URL);
    rebuildHeat();
    renderHeatStats();
  } catch (err) {
    // A collector older than the heatmap, or a new one that has not saved yet.
    // Everything else works without it, so this is no reason for the status line.
    console.info(`heat footprint unavailable: ${err.message}`);
    if (!heat) el('heatGroup').hidden = true;
  }
}

/**
 * Seconds of track history a turn rate is fitted over. Track arrives in steps,
 * so the change between two polls jitters; a line through several seconds of it
 * does not, and this is still short enough to catch a turn as it starts.
 */
const TURN_WINDOW_S = 8;
const trackHistory = new Map();   // hex -> [{ t, track }], oldest first

/**
 * Degrees per second the aircraft's track is turning, positive to the right.
 * Most receivers never hear a bank angle or turn rate reported, so it is worked
 * out here from how the track changes, as the slope of a straight line fitted
 * through the window. Zero until there is enough history to fit.
 */
function turnRate(hex, now, track) {
  if (typeof track !== 'number') {
    trackHistory.delete(hex);
    return 0;
  }
  let history = trackHistory.get(hex);
  if (!history) trackHistory.set(hex, history = []);
  if (!history.length || history[history.length - 1].t < now) history.push({ t: now, track });
  while (history[0].t < now - TURN_WINDOW_S) history.shift();
  if (history.length < 3 || now - history[0].t < TURN_WINDOW_S / 2) return 0;

  // Unwrapped so a turn through north does not read as 359 degrees at once.
  let unwrapped = 0;
  let prev = history[0].track;
  let sumT = 0;
  let sumA = 0;
  const points = history.map(({ t, track: a }) => {
    unwrapped += ((a - prev + 540) % 360) - 180;
    prev = a;
    sumT += t;
    sumA += unwrapped;
    return [t, unwrapped];
  });
  const meanT = sumT / points.length;
  const meanA = sumA / points.length;
  let num = 0;
  let den = 0;
  for (const [t, a] of points) {
    num += (t - meanT) * (a - meanA);
    den += (t - meanT) * (t - meanT);
  }
  return den > 0 ? num / den : 0;
}

/**
 * A trail keeps a new point once the aircraft has moved this far, climbed or
 * descended this much, or this many seconds have passed. An airliner lays a
 * point every couple of seconds, which is smooth at any zoom, while a parked or
 * loitering one does not pile up thousands of points in one place.
 */
const TRAIL_STEP_NM = 0.25;
const TRAIL_STEP_FT = 200;
const TRAIL_STEP_S = 30;

/** How far back a trail reaches, in seconds. Infinity keeps all of it. */
const TRAIL_MAX_AGE_S = Infinity;

const trails = new Map();   // hex -> [{ t, az, rangeNm, altFt }], oldest first

function polarXY(p) {
  const a = p.az * Math.PI / 180;
  return [p.rangeNm * Math.sin(a), p.rangeNm * Math.cos(a)];
}

/**
 * Adds this poll's positions to the trails. An aircraft that has dropped off
 * the feed takes its whole trail with it.
 */
function recordTrails(now, list) {
  const heard = new Set();
  for (const c of list) {
    heard.add(c.hex);
    let trail = trails.get(c.hex);
    if (!trail) trails.set(c.hex, trail = []);
    const last = trail[trail.length - 1];
    let keep = !last;
    if (last) {
      const [x0, y0] = polarXY(last);
      const [x1, y1] = polarXY(c);
      keep = Math.hypot(x1 - x0, y1 - y0) >= TRAIL_STEP_NM
        || Math.abs(c.altFt - last.altFt) >= TRAIL_STEP_FT
        || now - last.t >= TRAIL_STEP_S;
    }
    if (keep) trail.push({ t: now, az: c.az, rangeNm: c.rangeNm, altFt: c.altFt });
    while (trail.length && trail[0].t < now - TRAIL_MAX_AGE_S) trail.shift();
  }
  for (const hex of trails.keys()) {
    if (!heard.has(hex)) trails.delete(hex);
  }
}

async function refreshAircraft() {
  try {
    const resp = await fetch(AIRCRAFT_URL, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const snapshot = await resp.json();
    const out = [];
    for (const ac of snapshot.aircraft || []) {
      if (ac.lat === undefined || ac.r_dst === undefined || ac.r_dir === undefined) {
        continue;
      }
      let alt = typeof ac.alt_geom === 'number' ? ac.alt_geom : ac.alt_baro;
      if (typeof alt !== 'number') continue;
      const info = typeOf(ac.hex);
      out.push({
        hex: ac.hex,
        flight: (ac.flight || '').trim(),
        az: ac.r_dir,
        rangeNm: ac.r_dst,
        altFt: alt,
        track: typeof ac.track === 'number' ? ac.track : null,
        turnRate: turnRate(ac.hex, snapshot.now, ac.track),
        vs: typeof ac.geom_rate === 'number' ? ac.geom_rate
          : typeof ac.baro_rate === 'number' ? ac.baro_rate : null,
        gs: typeof ac.gs === 'number' ? ac.gs : null,
        shape: shapeFor(ac.category, info),
        // For the label. Flight levels are pressure altitude, so it is the
        // barometric reading there, where the scene places by the geometric.
        type: info ? info.type : null,
        squawk: ac.squawk || null,
        labelAltFt: typeof ac.alt_baro === 'number' ? ac.alt_baro : alt,
        rssi: typeof ac.rssi === 'number' ? ac.rssi : null,
        onGround: ac.alt_baro === 'ground',
      });
    }
    contacts = out;
    // Forget aircraft that have not been heard for a while.
    for (const [hex, history] of trackHistory) {
      if (history[history.length - 1].t < snapshot.now - 60) trackHistory.delete(hex);
    }
    recordTrails(snapshot.now, out);
    updateTraffic();
    // One dropped poll should not leave an error up once traffic is flowing again.
    if (el('status').textContent.startsWith('traffic:')) setStatus(null);
  } catch (err) {
    setStatus(`traffic: ${err.message} from ${AIRCRAFT_URL}`, true);
  }
}

// -------------------------------------------------------------------- readouts

function fmtTime(epochSec) {
  if (!epochSec) return '—';
  const d = new Date(epochSec * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function defList(target, rows) {
  target.innerHTML = '';
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    target.append(dt, dd);
  }
}

function renderStats() {
  if (!model) return;
  const s = summarize(model, ui.minHits);
  const days = Math.max(0, (s.updated - s.created) / 86400);
  // How long it has been collecting sits under the heading rather than in the
  // list: none of the other numbers mean anything without it.
  el('collectedSince').textContent = `Collected over ${days.toFixed(1)} days`;
  defList(el('stats'), [
    ['cells', `${s.filled} / ${s.cells}`],
    ['bearings', `${s.bearings} / 360`],
    ['positions', s.samples.toLocaleString()],
    ['max range', `${s.maxRangeNm.toFixed(1)} nm`],
    ['at', `${String(s.maxRangeAz).padStart(3, '0')}° / ${s.maxRangeAltFt.toLocaleString()} ft`],
    ['updated', fmtTime(s.updated)],
  ]);
}

function renderHeatStats() {
  if (!heat) return;
  const s = summarizeHeat(heat);
  const days = Math.max(0, (s.updated - s.created) / 86400);
  el('heatGroup').hidden = false;
  // Once the window is full it slides, and "collected over" stops growing.
  el('heatSince').textContent = s.windowWeeks && days >= (s.windowWeeks - 1) * 7
    ? `The last ${s.windowWeeks} weeks`
    : `Collected over ${days.toFixed(1)} days`;
  defList(el('heatStats'), [
    [s.unit, s.count.toLocaleString()],
    ['cells', `${s.lit.toLocaleString()} / ${heat.cells.toLocaleString()}`],
    ['updated', fmtTime(s.updated)],
  ]);
}

function setStatus(text, isError) {
  const node = el('status');
  if (!text) {
    const shown = visibleContacts().length;
    node.textContent = altFilterIsOpen()
      ? `${contacts.length} contacts`
      : `${shown} of ${contacts.length} contacts`;
    node.classList.remove('error');
    return;
  }
  node.textContent = text;
  node.classList.toggle('error', Boolean(isError));
}

function showPick(az, band) {
  const group = el('pickGroup');
  const cell = cellRecord(model, az, band);
  const lo = model.edges[band], hi = model.edges[band + 1];
  const rows = [
    ['bearing', `${String(az).padStart(3, '0')}°`],
    ['band', `${lo.toLocaleString()}–${hi.toLocaleString()} ft`],
    ['closed range', `${rangeAt(model, az, band).toFixed(1)} nm`],
  ];
  if (cell) {
    rows.push(['raw range', `${cell.d.toFixed(1)} nm`]);
    rows.push(['hits', String(cell.n)]);
    if (cell.rec) {
      rows.push(['set by', cell.rec.flight || cell.rec.hex || 'outline']);
      rows.push(['altitude', `${cell.rec.alt.toLocaleString()} ft ${cell.rec.src}`]);
      if (cell.rec.rssi !== undefined) rows.push(['rssi', `${cell.rec.rssi} dBFS`]);
      rows.push(['when', fmtTime(cell.rec.t)]);
    }
  } else {
    rows.push(['raw range', 'no contact in this band']);
  }
  defList(el('pick'), rows);
  // The cell's own altitude colour, on its panel and on the Info button.
  const colour = altitudeCss(lo);
  group.style.setProperty('--pick', colour);
  el('infoButton').style.setProperty('--pick', colour);
  group.hidden = false;
}

/**
 * While a selected cell's details are out of sight, the Info button takes the
 * cell's colour, with a short pulse when a new cell is picked, so there is
 * something to find there without a badge sitting on the rail.
 */
function updatePickNotice(fresh = false) {
  const button = el('infoButton');
  const waiting = Boolean(selectedCell) && (ui.section !== 'info' || ui.panelCollapsed);
  if (fresh) button.classList.remove('waiting');
  if (waiting && fresh) void button.offsetWidth;   // restarts the pulse
  button.classList.toggle('waiting', waiting);
}

// ----------------------------------------------------------------------- views

function frameCamera() {
  // Far enough out that the whole envelope fits in a 50-degree field, and low
  // enough that the stack of altitude rings reads as a stack rather than a target.
  const d = maxRangeNm;
  camera.position.set(0, -d * 2.0, d * 1.1);
  controls.target.set(0, 0, maxRangeNm * 0.12);
  controls.update();
}

/** Shows one rail section in the panel and lights its rail button. */
function showSection(name) {
  // Settings saved by an earlier build can name a section that has since been
  // merged away; without this the panel would come up blank.
  if (!document.querySelector(`#panel section[data-sect="${name}"]`)) {
    name = 'layers';
  }
  ui.section = name;
  for (const node of document.querySelectorAll('#panel section')) {
    node.hidden = node.dataset.sect !== name;
  }
  for (const button of document.querySelectorAll('.rail-btn.sect')) {
    button.classList.toggle('on', button.dataset.sect === name);
  }
  updatePickNotice();
}

function setPanelCollapsed(collapsed) {
  ui.panelCollapsed = collapsed;
  el('panel').classList.toggle('collapsed', collapsed);
  const toggle = el('panelToggle');
  toggle.innerHTML = collapsed ? '&#8250;' : '&#8249;';
  toggle.title = collapsed ? 'Show the panel' : 'Collapse the panel';
  updatePickNotice();
  // The stage is a flex sibling, so it has just changed width.
  resize();
}

function setView(name) {
  ui.view = name;
  for (const button of document.querySelectorAll('button.view')) {
    button.classList.toggle('on', button.dataset.view === name);
  }
  const isSlice = name === 'slice';
  el('slice').hidden = !isSlice;
  sceneCanvas.hidden = isSlice;
  el('sliceControls').hidden = !isSlice;
  el('hint').hidden = isSlice;
  el('labels').hidden = isSlice;

  // The bearing and spread controls live in the view section, so switching to
  // slice without opening it would hide the only controls that view has.
  if (isSlice) {
    if (ui.panelCollapsed) setPanelCollapsed(false);
    showSection('view');
  }

  if (name === 'top') {
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, maxRangeNm * 2.1);
    controls.target.set(0, 0, 0);
    controls.update();
  } else if (name === 'orbit') {
    camera.up.set(0, 0, 1);
    frameCamera();
  }
  resize();
  if (isSlice) drawSlice();
}

function drawSlice() {
  const window = ui.sliceSpread;
  const inWindow = contacts.filter((c) => {
    const diff = Math.abs(((c.az - ui.sliceAz + 540) % 360) - 180);
    return 180 - diff <= window;
  });
  slice.draw({
    model,
    azDeg: ui.sliceAz,
    spreadDeg: window,
    rxAltFt: ui.rxAltFt,
    contacts: inWindow,
    colorByAlt: ui.colorByAlt,
  });
}

function resize() {
  const rect = el('stage').getBoundingClientRect();
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / Math.max(1, rect.height);
  camera.updateProjectionMatrix();
  labelLayer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
  if (ui.view === 'slice') drawSlice();
}

function animate() {
  requestAnimationFrame(animate);
  if (ui.view === 'slice') return;
  controls.update();
  aircraftLayer.fitToView(camera, sceneCanvas.clientHeight);
  renderer.render(scene, camera);
  const showLabels = ui.layers.labels && ui.layers.aircraft3d;
  labelLayer.draw(showLabels ? aircraftLayer : null, camera, ui.labelFields,
    PLANE_PX * ui.planeScale);
}

// --------------------------------------------------------------------- labels

/** A made-up aircraft, so the preview shows every field even with no traffic. */
const LABEL_SAMPLE = {
  hex: 'a1b2c3', flight: 'UAL1234', type: 'B738', labelAltFt: 35000, vs: -1200,
  rangeNm: 62, rssi: -18.4,
};

/** Puts the chosen label fields onto the strip's buttons and the preview box. */
function renderLabelFields() {
  for (const button of document.querySelectorAll('#labelFields button')) {
    const on = Boolean(ui.labelFields[button.dataset.field]);
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }
  const lines = labelLines(LABEL_SAMPLE, ui.labelFields);
  const box = el('labelPreviewBox');
  box.textContent = lines.join('\n');
  box.hidden = !lines.length;
  el('labelPreviewEmpty').hidden = lines.length > 0;
}


// ------------------------------------------------------------------------- UI

function onDataOptionChange() {
  rebuildModel();
  if (ui.view === 'slice') drawSlice();
}

function onViewOptionChange() {
  rebuildScene();
  if (ui.view === 'slice') drawSlice();
}

function bindCheckbox(id, apply) {
  el(id).addEventListener('change', (ev) => apply(ev.target.checked));
}

/**
 * The heat's slider stops, as the busiest share of routes shown. Finer at the
 * busy end, where a few percent is the difference between one approach and all
 * of them.
 */
const HEAT_PCT_STEPS = [1, 2, 5, 10, 15, 20, 30, 40, 50, 75, 100];

/** The slider stop nearest a saved share. */
function heatPctStep(pct) {
  let best = 0;
  HEAT_PCT_STEPS.forEach((v, i) => {
    if (Math.abs(v - pct) < Math.abs(HEAT_PCT_STEPS[best] - pct)) best = i;
  });
  return best;
}

function bindRange(id, outId, format, apply) {
  const input = el(id);
  const out = el(outId);
  const handle = () => {
    const value = Number(input.value);
    out.innerHTML = format(value);
    apply(value);
  };
  input.addEventListener('input', handle);
  out.innerHTML = format(Number(input.value));
}

/**
 * Pushes the restored settings into the controls. Dispatching the events the
 * controls already listen for means there is exactly one code path from a control
 * to the view, whether a person moved it or a saved setting did.
 *
 * Safe to run before any data has loaded: the rebuilds it triggers return early
 * while there is no model.
 */
function applyUiToControls() {
  const checkboxes = {
    layerEnvelope: ui.layers.envelope,
    layerContours: ui.layers.contours,
    layerHorizon: ui.layers.horizon,
    layerAircraft3d: ui.layers.aircraft3d,
    layerGround: ui.layers.ground,
    layerBasemap: ui.layers.basemap,
    layerFootprint: ui.layers.footprint,
    layerHeat: ui.layers.heat,
    layerLabels: ui.layers.labels,
    layerTrails: ui.layers.trails,
    // Before extendHorizon, which switches it off: restoring them the other way
    // round would let curvature undo the extension it was meant to accompany.
    curvature: ui.curvature,
    extendHorizon: ui.extendHorizon,
    closure: ui.closure,
    colorByAlt: ui.colorByAlt,
  };
  for (const [id, value] of Object.entries(checkboxes)) {
    const node = el(id);
    if (node.checked !== value) {
      node.checked = value;
      node.dispatchEvent(new Event('change'));
    }
  }

  const ranges = {
    planeSize: Math.round(ui.planeScale * 100),
    exag: ui.exag,
    smooth: ui.smoothDeg,
    hits: ui.minHits,
    heatPct: heatPctStep(ui.heatBusiestPct),
    sliceAz: ui.sliceAz,
    sliceSpread: ui.sliceSpread,
  };
  for (const [id, value] of Object.entries(ranges)) {
    const node = el(id);
    node.value = String(value);
    node.dispatchEvent(new Event('input'));
  }

  el('rxAlt').value = String(ui.rxAltFt);
  el('altMin').value = String(ui.altMinFt);
  el('altMax').value = String(ui.altMaxFt);
  el('altLegendGroup').hidden = !ui.colorByAlt;
  renderLabelFields();
  showSection(ui.section);
  setPanelCollapsed(ui.panelCollapsed);
}

function note(text) {
  const node = el('settingsNote');
  node.textContent = text;
  window.clearTimeout(note.timer);
  note.timer = window.setTimeout(() => { node.textContent = ''; }, 4000);
}

// Curvature setting from before the extended horizon switched it off, so that
// turning the extension back off returns the view to where it was.
let curvatureBeforeExtend = null;

function wireUi() {
  el('backTo2d').href = TAR1090_URL;

  for (const button of document.querySelectorAll('button.view')) {
    button.addEventListener('click', () => setView(button.dataset.view));
  }

  for (const button of document.querySelectorAll('.rail-btn.sect')) {
    button.addEventListener('click', () => {
      // Picking a section while the panel is hidden should bring it back,
      // rather than silently switching something nobody can see.
      if (ui.panelCollapsed) setPanelCollapsed(false);
      showSection(button.dataset.sect);
    });
  }

  el('panelToggle').addEventListener('click', () => {
    setPanelCollapsed(!ui.panelCollapsed);
  });

  bindCheckbox('layerEnvelope', (v) => { ui.layers.envelope = v; applyLayerVisibility(); });
  bindCheckbox('layerContours', (v) => { ui.layers.contours = v; applyLayerVisibility(); });
  // Extending the horizon only means anything while the horizon is showing, so
  // it appears with it. Unlike the heat threshold it is not kept while hidden:
  // it switches curvature off, and that should never be left off out of sight.
  bindCheckbox('layerHorizon', (v) => {
    ui.layers.horizon = v;
    el('extendHorizonRow').hidden = !v;
    if (!v && ui.extendHorizon) {
      el('extendHorizon').checked = false;
      el('extendHorizon').dispatchEvent(new Event('change'));
    }
    applyLayerVisibility();
  });
  bindCheckbox('layerAircraft3d', (v) => { ui.layers.aircraft3d = v; applyLayerVisibility(); });
  bindCheckbox('layerTrails', (v) => { ui.layers.trails = v; applyLayerVisibility(); });
  // The label fields only mean anything while labels are showing, so they open
  // out under the switch, the same as the heat's threshold below.
  bindCheckbox('layerLabels', (v) => {
    ui.layers.labels = v;
    el('labelsBody').hidden = !v;
  });
  for (const button of document.querySelectorAll('#labelFields button')) {
    button.addEventListener('click', () => {
      const field = button.dataset.field;
      ui.labelFields = { ...ui.labelFields, [field]: !ui.labelFields[field] };
      renderLabelFields();
    });
  }
  bindCheckbox('layerGround', (v) => { ui.layers.ground = v; applyLayerVisibility(); });
  bindCheckbox('layerBasemap', (v) => { ui.layers.basemap = v; applyLayerVisibility(); });
  bindCheckbox('layerFootprint', (v) => {
    ui.layers.footprint = v; applyLayerVisibility();
  });
  // The heat's threshold only means anything while the heat is showing, so its
  // slider sits under the switch and appears with it. Switched off and on again,
  // it comes back at the same setting.
  bindCheckbox('layerHeat', (v) => {
    ui.layers.heat = v;
    el('heatBody').hidden = !v;
    applyLayerVisibility();
  });
  // Curvature and the extended horizon cannot both be meaningful. With curvature
  // on, on-screen height is altitude minus the earth's drop at that range, so two
  // points at the same altitude but different ranges draw at different heights —
  // and the extended horizon exists precisely to be compared by altitude. Worse,
  // the ground falls away faster than the line-of-sight floor climbs, so the
  // surface sinks instead of rising. They are therefore mutually exclusive, and
  // turning the extension off restores whatever curvature was set before.
  bindCheckbox('extendHorizon', (v) => {
    ui.extendHorizon = v;
    if (v && ui.curvature) {
      curvatureBeforeExtend = ui.curvature;
      ui.curvature = false;
      el('curvature').checked = false;
    } else if (!v && curvatureBeforeExtend !== null) {
      ui.curvature = curvatureBeforeExtend;
      el('curvature').checked = ui.curvature;
      curvatureBeforeExtend = null;
    }
    onViewOptionChange();
  });

  const applyAltFilter = () => {
    let lo = Number(el('altMin').value);
    let hi = Number(el('altMax').value);
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = ALT_TOP_FT;
    // Crossed values would otherwise filter everything away and look like a bug.
    if (lo > hi) [lo, hi] = [hi, lo];
    ui.altMinFt = Math.max(0, Math.min(ALT_TOP_FT, lo));
    ui.altMaxFt = Math.max(0, Math.min(ALT_TOP_FT, hi));
    el('altMin').value = String(ui.altMinFt);
    el('altMax').value = String(ui.altMaxFt);
    onViewOptionChange();
    setStatus(null);
  };
  el('altMin').addEventListener('change', applyAltFilter);
  el('altMax').addEventListener('change', applyAltFilter);
  el('altReset').addEventListener('click', () => {
    el('altMin').value = '0';
    el('altMax').value = String(ALT_TOP_FT);
    applyAltFilter();
  });

  bindRange('planeSize', 'planeSizeOut', (v) => `${v}%`, (v) => {
    ui.planeScale = v / 100;
    aircraftLayer.planeScale = ui.planeScale;
  });

  bindCheckbox('curvature', (v) => {
    ui.curvature = v;
    // Asking for curvature back is a deliberate choice, so it wins and the
    // extension stands down rather than silently fighting it.
    if (v && ui.extendHorizon) {
      ui.extendHorizon = false;
      el('extendHorizon').checked = false;
      curvatureBeforeExtend = null;
    }
    onViewOptionChange();
  });
  bindCheckbox('colorByAlt', (v) => {
    ui.colorByAlt = v;
    el('altLegendGroup').hidden = !v;
    onViewOptionChange();
  });
  bindCheckbox('closure', (v) => { ui.closure = v; onDataOptionChange(); });

  bindRange('exag', 'exagOut', (v) => `${v}&times;`, (v) => {
    ui.exag = v; onViewOptionChange();
  });
  bindRange('smooth', 'smoothOut', (v) => `${v}&deg;`, (v) => {
    ui.smoothDeg = v; onDataOptionChange();
  });
  bindRange('hits', 'hitsOut', (v) => String(v), (v) => {
    ui.minHits = v; onDataOptionChange();
  });
  bindRange('heatPct', 'heatPctOut', (v) => (HEAT_PCT_STEPS[v] === 100 ? 'all' : `top ${HEAT_PCT_STEPS[v]}%`), (v) => {
    ui.heatBusiestPct = HEAT_PCT_STEPS[v];
    rebuildHeat();
  });
  bindRange('sliceAz', 'azOut', (v) => `${String(v).padStart(3, '0')}&deg;`, (v) => {
    ui.sliceAz = v; if (ui.view === 'slice') drawSlice();
  });
  bindRange('sliceSpread', 'spreadOut', (v) => `&plusmn;${v}&deg;`, (v) => {
    ui.sliceSpread = v; if (ui.view === 'slice') drawSlice();
  });

  el('rxAlt').addEventListener('change', (ev) => {
    ui.rxAltFt = Number(ev.target.value) || 0;
    onViewOptionChange();
  });

  // Click, not drag: orbiting past the surface should not select a cell.
  let downAt = null;
  sceneCanvas.addEventListener('pointerdown', (ev) => {
    downAt = { x: ev.clientX, y: ev.clientY };
  });
  sceneCanvas.addEventListener('pointerup', (ev) => {
    if (!downAt || !envelopeGroup) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    downAt = null;
    if (moved > 4) return;
    const rect = sceneCanvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const mesh = envelopeGroup.userData.mesh;
    const hits = raycaster.intersectObject(mesh, false);
    if (!hits.length) {
      el('pickGroup').hidden = true;
      selectedCell = null;
      updateCellHighlight();
      updatePickNotice();
      return;
    }
    const { vertexAz, vertexBand } = mesh.userData;
    const vertex = hits[0].face.a;
    selectedCell = { az: vertexAz[vertex], band: vertexBand[vertex] };
    showPick(selectedCell.az, selectedCell.band);
    updateCellHighlight();
    updatePickNotice(true);
  });

  el('saveSettings').addEventListener('click', () => {
    note(saveSettings(ui)
      ? 'saved to this browser'
      : 'could not save: storage is blocked');
  });

  el('resetSettings').addEventListener('click', () => {
    clearSettings();
    window.location.reload();
  });

  window.addEventListener('resize', resize);
}

// ----------------------------------------------------------------------- start

wireUi();
applyUiToControls();
renderAltitudeLegend();
resize();
animate();
await refreshEnvelope(true);
setView(ui.view);
initBasemap();
refreshHeat();
await refreshAircraft();
setStatus(null);
setInterval(() => refreshEnvelope(false), ENVELOPE_REFRESH_MS);
setInterval(refreshHeat, HEAT_REFRESH_MS);
setInterval(async () => {
  await refreshAircraft();
  if (ui.view === 'slice') drawSlice();
  if (!el('status').classList.contains('error')) setStatus(null);
}, AIRCRAFT_REFRESH_MS);
