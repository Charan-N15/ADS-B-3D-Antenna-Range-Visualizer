// range3d viewer: altitude-resolved coverage envelope over a live traffic scene.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  loadEnvelope, buildGrid, summarize, cellRecord, rangeAt,
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

const params = new URLSearchParams(location.search);
const ENVELOPE_URL = params.get('envelope') || 'state/envelope.json';
const AIRCRAFT_URL = params.get('aircraft') || '../tar1090/data/aircraft.json';
const ENVELOPE_REFRESH_MS = 60000;
const AIRCRAFT_REFRESH_MS = 1000;
const CONTOUR_ALTITUDES = [2000, 5000, 10000, 20000, 30000, 40000];

const el = (id) => document.getElementById(id);

const DEFAULT_UI = {
  view: 'orbit',
  layers: {
    envelope: true, contours: true, horizon: true, aircraft: true, ground: true,
    basemap: true,
  },
  mapOpacity: 0.75,
  exag: 8,
  curvature: true,
  colorByAlt: true,
  smoothDeg: 5,
  minHits: 2,
  closure: true,
  rxAltFt: 100,
  sliceAz: 0,
  sliceSpread: 5,
};

// Saved settings are a convenience, never a requirement: if storage is unreadable
// this is simply the defaults.
const savedSettings = loadSettings();
const hasSavedSettings = savedSettings !== null;
const ui = mergeSettings(DEFAULT_UI, savedSettings);

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
let basemap = null;      // loaded tiles and texture, built once
let basemapMesh = null;  // rebuilt whenever the projection changes

function viewOpts() {
  return {
    rxAltFt: ui.rxAltFt,
    exag: ui.exag,
    curvature: ui.curvature,
    colorByAlt: ui.colorByAlt,
  };
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
  disposeGroup(horizonGroup);
  disposeGroup(basemapMesh);
  basemapMesh = null;

  groundGroup = buildGround(maxRangeNm, opts);
  envelopeGroup = buildEnvelopeSurface(model, opts);
  contourGroup = buildContourRings(model, CONTOUR_ALTITUDES, opts);
  horizonGroup = buildHorizonSurface(maxRangeNm, opts);
  scene.add(groundGroup, envelopeGroup, contourGroup, horizonGroup);

  if (basemap && doc?.rx?.lat != null) {
    const radius = Math.min(maxRangeNm, basemap.meta.radiusNm);
    basemapMesh = buildBasemapDisc(basemap, doc.rx, radius, opts, ui.mapOpacity);
    scene.add(basemapMesh);
  }
  applyLayerVisibility();
  aircraftLayer.update(opts);
}

function applyLayerVisibility() {
  if (groundGroup) groundGroup.visible = ui.layers.ground;
  if (envelopeGroup) envelopeGroup.visible = ui.layers.envelope;
  if (contourGroup) contourGroup.visible = ui.layers.contours;
  if (horizonGroup) horizonGroup.visible = ui.layers.horizon;
  if (basemapMesh) basemapMesh.visible = ui.layers.basemap;
  aircraftLayer.group.visible = ui.layers.aircraft;
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
    aircraftLayer.setContacts(contacts);
    aircraftLayer.update(viewOpts());
  } catch (err) {
    setStatus(`traffic: ${err.message}`, true);
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
  defList(el('stats'), [
    ['cells', `${s.filled} / ${s.cells}`],
    ['bearings', `${s.bearings} / 360`],
    ['positions', s.samples.toLocaleString()],
    ['max range', `${s.maxRangeNm.toFixed(1)} nm`],
    ['at', `${String(s.maxRangeAz).padStart(3, '0')}° / ${s.maxRangeAltFt.toLocaleString()} ft`],
    ['collecting', `${days.toFixed(1)} d`],
    ['updated', fmtTime(s.updated)],
  ]);
}

function setStatus(text, isError) {
  const node = el('status');
  if (!text) {
    node.textContent = `${contacts.length} contacts`;
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
    layerAircraft: ui.layers.aircraft,
    layerGround: ui.layers.ground,
    layerBasemap: ui.layers.basemap,
    curvature: ui.curvature,
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
  el('altLegendGroup').hidden = !ui.colorByAlt;
}

function note(text) {
  const node = el('settingsNote');
  node.textContent = text;
  window.clearTimeout(note.timer);
  note.timer = window.setTimeout(() => { node.textContent = ''; }, 4000);
}

function wireUi() {
  for (const button of document.querySelectorAll('button.view')) {
    button.addEventListener('click', () => setView(button.dataset.view));
  }

  bindCheckbox('layerEnvelope', (v) => { ui.layers.envelope = v; applyLayerVisibility(); });
  bindCheckbox('layerContours', (v) => { ui.layers.contours = v; applyLayerVisibility(); });
  bindCheckbox('layerHorizon', (v) => { ui.layers.horizon = v; applyLayerVisibility(); });
  bindCheckbox('layerAircraft', (v) => { ui.layers.aircraft = v; applyLayerVisibility(); });
  bindCheckbox('layerGround', (v) => { ui.layers.ground = v; applyLayerVisibility(); });
  bindCheckbox('layerBasemap', (v) => { ui.layers.basemap = v; applyLayerVisibility(); });

  bindRange('mapOpacity', 'mapOpacityOut', (v) => `${v}%`, (v) => {
    ui.mapOpacity = v / 100;
    if (basemapMesh) basemapMesh.material.opacity = ui.mapOpacity;
  });

  bindCheckbox('curvature', (v) => { ui.curvature = v; onViewOptionChange(); });
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
