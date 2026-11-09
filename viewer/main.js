// range3d viewer: altitude-resolved coverage envelope over a live traffic scene.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  loadEnvelope, buildGrid, summarize, cellRecord, rangeAt, topAltitudeFt,
} from './envelope.js';
import {
  buildGround, buildEnvelopeSurface, buildContourRings, buildHorizonSurface,
  AircraftLayer,
} from './layers.js';
import { loadBasemap, buildBasemapDisc } from './basemap.js';
import { altitudeCss, LEGEND_ALTITUDES } from './altitude.js';
import {
  loadSettings, saveSettings, clearSettings, mergeSettings,
} from './settings.js';
import { SliceView } from './slice.js';
import { TAR1090_PATH } from './config.js';

const params = new URLSearchParams(location.search);
const ENVELOPE_URL = params.get('envelope') || 'state/envelope.json';
// Where the "return to 2D" link goes, and where live traffic is read from. Both
// hang off one path so they cannot drift apart: a receiver that serves tar1090
// from somewhere else breaks both or neither. config.js holds the installed
// location; the trailing slash is forced so ?tar1090=/adsbx works too.
const TAR1090_URL = (params.get('tar1090') || TAR1090_PATH).replace(/\/?$/, '/');
const AIRCRAFT_URL = params.get('aircraft') || `${TAR1090_URL}data/aircraft.json`;
const ENVELOPE_REFRESH_MS = 60000;
const AIRCRAFT_REFRESH_MS = 1000;
const CONTOUR_ALTITUDES = [2000, 5000, 10000, 20000, 30000, 40000];

const el = (id) => document.getElementById(id);

const DEFAULT_UI = {
  view: 'orbit',
  layers: {
    envelope: true, contours: true, horizon: false, ground: true,
    basemap: true, footprint: true, aircraft3d: true, aircraft2d: false,
  },
  mapOpacity: 1,
  extendHorizon: false,
  altMinFt: 0,
  altMaxFt: 50000,
  exag: 8,
  curvature: true,
  colorByAlt: true,
  smoothDeg: 7,
  minHits: 1,
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

// Up to v1.1 live traffic was one layer. mergeSettings drops keys it does not
// know, so without this a saved view with traffic switched off would come back
// with both halves on.
if (savedSettings && savedSettings.layers
    && typeof savedSettings.layers.aircraft === 'boolean'
    && savedSettings.layers.aircraft3d === undefined) {
  ui.layers.aircraft3d = savedSettings.layers.aircraft;
  ui.layers.aircraft2d = savedSettings.layers.aircraft;
}

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
scene.add(aircraftLayer.group);

const slice = new SliceView(el('slice'));
const raycaster = new THREE.Raycaster();

let groundGroup = null;
let envelopeGroup = null;
let contourGroup = null;
let horizonGroup = null;
let footprintGroup = null;
let basemap = null;      // loaded tiles and texture, built once
let basemapMesh = null;  // rebuilt whenever the projection changes

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
  return ui.altMinFt <= 0 && ui.altMaxFt >= 50000;
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
    basemapMesh = buildBasemapDisc(basemap, doc.rx, radius, opts, ui.mapOpacity);
    scene.add(basemapMesh);
  }
  applyLayerVisibility();
  // Re-filtered here as well as on each poll, because changing the altitude
  // window has to take effect without waiting for the next second of data.
  aircraftLayer.setContacts(visibleContacts());
  aircraftLayer.update(opts);
}

function applyLayerVisibility() {
  if (groundGroup) groundGroup.visible = ui.layers.ground;
  if (envelopeGroup) envelopeGroup.visible = ui.layers.envelope;
  if (contourGroup) contourGroup.visible = ui.layers.contours;
  if (horizonGroup) horizonGroup.visible = ui.layers.horizon;
  if (footprintGroup) footprintGroup.visible = ui.layers.footprint;
  if (basemapMesh) basemapMesh.visible = ui.layers.basemap;
  aircraftLayer.setVisibility(ui.layers.aircraft3d, ui.layers.aircraft2d);
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
      out.push({
        hex: ac.hex,
        flight: (ac.flight || '').trim(),
        az: ac.r_dir,
        rangeNm: ac.r_dst,
        altFt: alt,
      });
    }
    contacts = out;
    aircraftLayer.setContacts(visibleContacts());
    aircraftLayer.update(viewOpts());
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
  group.hidden = false;
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
}

function setPanelCollapsed(collapsed) {
  ui.panelCollapsed = collapsed;
  el('panel').classList.toggle('collapsed', collapsed);
  const toggle = el('panelToggle');
  toggle.innerHTML = collapsed ? '&#8250;' : '&#8249;';
  toggle.title = collapsed ? 'Show the panel' : 'Collapse the panel';
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
  if (ui.view === 'slice') drawSlice();
}

function animate() {
  requestAnimationFrame(animate);
  if (ui.view === 'slice') return;
  controls.update();
  renderer.render(scene, camera);
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
    layerAircraft2d: ui.layers.aircraft2d,
    layerGround: ui.layers.ground,
    layerBasemap: ui.layers.basemap,
    layerFootprint: ui.layers.footprint,
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
    mapOpacity: Math.round(ui.mapOpacity * 100),
    exag: ui.exag,
    smooth: ui.smoothDeg,
    hits: ui.minHits,
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
  bindCheckbox('layerHorizon', (v) => { ui.layers.horizon = v; applyLayerVisibility(); });
  bindCheckbox('layerAircraft3d', (v) => { ui.layers.aircraft3d = v; applyLayerVisibility(); });
  bindCheckbox('layerAircraft2d', (v) => { ui.layers.aircraft2d = v; applyLayerVisibility(); });
  bindCheckbox('layerGround', (v) => { ui.layers.ground = v; applyLayerVisibility(); });
  bindCheckbox('layerBasemap', (v) => { ui.layers.basemap = v; applyLayerVisibility(); });
  bindCheckbox('layerFootprint', (v) => {
    ui.layers.footprint = v; applyLayerVisibility();
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
    if (!Number.isFinite(hi)) hi = 50000;
    // Crossed values would otherwise filter everything away and look like a bug.
    if (lo > hi) [lo, hi] = [hi, lo];
    ui.altMinFt = Math.max(0, Math.min(50000, lo));
    ui.altMaxFt = Math.max(0, Math.min(50000, hi));
    el('altMin').value = String(ui.altMinFt);
    el('altMax').value = String(ui.altMaxFt);
    onViewOptionChange();
    setStatus(null);
  };
  el('altMin').addEventListener('change', applyAltFilter);
  el('altMax').addEventListener('change', applyAltFilter);
  el('altReset').addEventListener('click', () => {
    el('altMin').value = '0';
    el('altMax').value = '50000';
    applyAltFilter();
  });

  bindRange('mapOpacity', 'mapOpacityOut', (v) => `${v}%`, (v) => {
    ui.mapOpacity = v / 100;
    if (basemapMesh) basemapMesh.material.opacity = ui.mapOpacity;
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
    if (!hits.length) { el('pickGroup').hidden = true; return; }
    const { vertexAz, vertexBand } = mesh.userData;
    const vertex = hits[0].face.a;
    showPick(vertexAz[vertex], vertexBand[vertex]);
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
await refreshAircraft();
setStatus(null);
setInterval(() => refreshEnvelope(false), ENVELOPE_REFRESH_MS);
setInterval(async () => {
  await refreshAircraft();
  if (ui.view === 'slice') drawSlice();
  if (!el('status').classList.contains('error')) setStatus(null);
}, AIRCRAFT_REFRESH_MS);
