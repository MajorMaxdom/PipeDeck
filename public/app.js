'use strict';

const WS_PORT  = 8765;
let   vuSegs      = parseInt(localStorage.getItem('pw-vu-segs') || '32');
let   vuPeakHold  = localStorage.getItem('pw-vu-peak-hold') !== 'false';
let   vuPeakHoldMs = parseInt(localStorage.getItem('pw-vu-peak-hold-ms') || '2000');
let   stereoMeters = localStorage.getItem('pw-stereo-meters') === 'true';
let vuBoost = parseFloat(localStorage.getItem('pw-vu-boost') || '1.13');
let smoothMute = localStorage.getItem('pw-smooth-mute') === 'true';
let appFilter  = '';
const vuPeakState = new WeakMap(); // vu element → { peak, timer }
const stripRemovalTimers = new Map(); // sink-input index → timeout id
const ZOOM_STEP = 0.1;
const ZOOM_MIN  = 0.4;
const ZOOM_MAX  = 2.5;

const sendTimers = {};
let currentSinks  = [];
let defaultSink   = '';
let sourceRoutes  = {};   // source_name -> sink_name
let channelNames  = {};   // "type:index" -> custom display name

let soloSet       = new Set();   // "type:index" strings currently soloed
let preSoloMutes  = {};          // "type:index" → boolean mute state before solo

let scenes = [];   // persisted scene list
let macros = [];   // persisted macro buttons

const SCENE_ICONS = ['🎮','🎵','🎙','🎧','📻','🎬','💼','🏠','📞','🔔','🎯','⭐','🎤','📺','🎹','🔴','🟢','🔵','🟡','🟠'];

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

let accentColor = localStorage.getItem('pw-accent') || '#00d4aa';
let stripWidth  = parseInt(localStorage.getItem('pw-strip-w') || '82');

const VIRTUAL_COLOR = '#7744cc';
const SINK_PALETTE  = [
  '#00d4aa',  // teal
  '#e07030',  // orange
  '#3090e0',  // blue
  '#60c040',  // green
  '#d4b820',  // yellow
  '#d040a0',  // pink
  '#e04030',  // red
  '#30c0d0',  // cyan
];

// ── Sink colors ───────────────────────────────────────────────────────────

const SINK_COLORS_KEY = 'pw-sink-colors';

function loadSinkColors() {
  try { return JSON.parse(localStorage.getItem(SINK_COLORS_KEY) || '{}'); }
  catch { return {}; }
}

function saveSinkColor(sinkIndex, color) {
  const map = loadSinkColors();
  map[sinkIndex] = color;
  localStorage.setItem(SINK_COLORS_KEY, JSON.stringify(map));
  schedSendSettings();
}

function getSinkColor(sinkIndex) {
  return loadSinkColors()[sinkIndex] || null;
}

function applyColorToStrip(strip, color) {
  strip.style.setProperty('--strip-color', color || 'transparent');
  const band = strip.querySelector('.color-band');
  if (band) band.style.background = color || 'transparent';
}

// Returns saved color, or VIRTUAL_COLOR if the sink is virtual, or null
function getEffectiveSinkColor(sinkIndex) {
  const saved = getSinkColor(sinkIndex);
  if (saved) return saved;
  const idx = parseInt(sinkIndex);
  const sinks = lastState ? lastState.sinks : [];
  const sink = sinks.find(s => s.index === idx);
  return (sink && sink.virtual) ? VIRTUAL_COLOR : null;
}

function applyColorsToAppStrips(sinkIndex) {
  const sinkColor = getEffectiveSinkColor(sinkIndex);
  document.querySelectorAll(`.strip[data-type="sink-input"][data-sink="${sinkIndex}"]`)
    .forEach(s => applyColorToStrip(s, getAppColor(s.dataset.appkey || '') || sinkColor));
}

// Populate a source-routing dropdown with virtual sinks
function fillSourceRouteSel(sel, currentRoute) {
  const prev = sel.value !== undefined ? sel.value : currentRoute;
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = '— no route —';
  sel.appendChild(none);
  (lastState ? lastState.sinks : []).filter(s => s.virtual).forEach(s => {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = shortLabel(sinkDisplayName(s));
    o.selected = s.name === (prev || currentRoute);
    sel.appendChild(o);
  });
  if (!sel.value) sel.value = '';
}

function refreshAllAppColors() {
  document.querySelectorAll('.strip[data-type="sink-input"]').forEach(s => {
    const appColor = getAppColor(s.dataset.appkey || '');
    const sinkColor = s.dataset.sink != null ? getEffectiveSinkColor(s.dataset.sink) : null;
    applyColorToStrip(s, appColor || sinkColor);
    const cp = s.querySelector('.color-pick');
    if (cp && appColor) cp.value = appColor;
  });
}

// ── App names (custom rename per app-name key) ────────────────────────────

const APP_NAMES_KEY = 'pw-app-names';

function loadAppNames() {
  try { return JSON.parse(localStorage.getItem(APP_NAMES_KEY) || '{}'); }
  catch { return {}; }
}

function saveAppName(appKey, name) {
  const map = loadAppNames();
  if (name) map[appKey] = name; else delete map[appKey];
  localStorage.setItem(APP_NAMES_KEY, JSON.stringify(map));
  schedSendSettings();
}

function getAppName(appKey) {
  if (!appKey) return null;
  return loadAppNames()[appKey] || null;
}

// ── App colors (per app-name, overrides sink color) ───────────────────────

const APP_COLORS_KEY = 'pw-app-colors';

function loadAppColors() {
  try { return JSON.parse(localStorage.getItem(APP_COLORS_KEY) || '{}'); }
  catch { return {}; }
}

function saveAppColor(appKey, color) {
  const map = loadAppColors();
  if (color) map[appKey] = color; else delete map[appKey];
  localStorage.setItem(APP_COLORS_KEY, JSON.stringify(map));
  schedSendSettings();
}

function getAppColor(appKey) {
  if (!appKey) return null;
  return loadAppColors()[appKey] || null;
}

// ── Server settings sync ──────────────────────────────────────────────────

let settingsApplied = false;
let settingsTimer   = null;

function sendSettings() {
  const panelWidths = {};
  for (const id of ['panel-inputs', 'panel-outputs', 'panel-media']) {
    const p = document.getElementById(id);
    if (p && p.style.width) panelWidths[id] = p.style.width;
  }
  const mediaTop = document.getElementById('media-top');
  send({
    type: 'save_settings',
    hidden_devices: [...getHidden()],
    ui: {
      zoom,
      vu_segs: vuSegs,
      vu_boost: vuBoost,
      smooth_mute: smoothMute,
      vu_peak_hold: vuPeakHold,
      vu_peak_hold_ms: vuPeakHoldMs,
      stereo_meters: stereoMeters,
      media_visible: mediaVisible,
      panel_widths: panelWidths,
      media_top_height: (mediaTop && mediaTop.style.height) || null,
      sink_colors: loadSinkColors(),
      app_colors: loadAppColors(),
      app_names: loadAppNames(),
      channel_names: channelNames,
      accent_color: accentColor,
      strip_width: stripWidth,
    },
  });
}

function schedSendSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(sendSettings, 300);
}

function applyServerSettings(settings) {
  if (settings.hidden_devices !== undefined) {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(settings.hidden_devices));
  }
  const ui = settings.ui || {};
  if (ui.zoom != null) {
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parseFloat(ui.zoom) || 1));
    localStorage.setItem('pw-zoom', zoom);
    applyZoom();
  }
  if (ui.vu_segs != null) {
    vuSegs = Math.max(8, Math.min(64, parseInt(ui.vu_segs) || 32));
    localStorage.setItem('pw-vu-segs', vuSegs);
  }
  if (ui.vu_boost != null) {
    vuBoost = Math.max(1.0, Math.min(4.0, parseFloat(ui.vu_boost) || 1.13));
    localStorage.setItem('pw-vu-boost', vuBoost);
  }
  if (ui.smooth_mute != null) {
    smoothMute = !!ui.smooth_mute;
    localStorage.setItem('pw-smooth-mute', smoothMute);
  }
  if (ui.vu_peak_hold != null) {
    vuPeakHold = !!ui.vu_peak_hold;
    localStorage.setItem('pw-vu-peak-hold', vuPeakHold);
  }
  if (ui.vu_peak_hold_ms != null) {
    vuPeakHoldMs = Math.max(200, Math.min(10000, parseInt(ui.vu_peak_hold_ms) || 2000));
    localStorage.setItem('pw-vu-peak-hold-ms', vuPeakHoldMs);
  }
  if (ui.stereo_meters != null) {
    stereoMeters = !!ui.stereo_meters;
    localStorage.setItem('pw-stereo-meters', stereoMeters);
  }
  if (ui.media_visible != null) {
    mediaVisible = !!ui.media_visible;
    localStorage.setItem('pw-media-visible', mediaVisible);
    applyMediaVisibility();
  }
  if (ui.sink_colors && Object.keys(ui.sink_colors).length > 0) {
    localStorage.setItem(SINK_COLORS_KEY, JSON.stringify(ui.sink_colors));
  }
  if (ui.app_colors && Object.keys(ui.app_colors).length > 0) {
    localStorage.setItem(APP_COLORS_KEY, JSON.stringify(ui.app_colors));
  }
  if (ui.app_names && Object.keys(ui.app_names).length > 0) {
    localStorage.setItem(APP_NAMES_KEY, JSON.stringify(ui.app_names));
  }
  const pw = ui.panel_widths || {};
  for (const id of ['panel-inputs', 'panel-outputs', 'panel-media']) {
    const w = pw[id];
    if (w) {
      const p = document.getElementById(id);
      if (p) { p.style.width = w; p.style.flexShrink = '0'; localStorage.setItem('pw-panel-' + id, w); }
    }
  }
  if (ui.media_top_height) {
    const el = document.getElementById('media-top');
    if (el) { el.style.height = ui.media_top_height; el.style.flexShrink = '0'; localStorage.setItem('pw-media-top-h', ui.media_top_height); }
  }
  if (ui.channel_names && typeof ui.channel_names === 'object') {
    channelNames = ui.channel_names;
  }
  if (ui.accent_color) {
    accentColor = ui.accent_color;
    localStorage.setItem('pw-accent', accentColor);
    applyAccentColor(accentColor);
  }
  if (ui.strip_width != null) {
    stripWidth = Math.max(60, Math.min(140, parseInt(ui.strip_width) || 82));
    localStorage.setItem('pw-strip-w', stripWidth);
    applyStripWidth(stripWidth);
  }
}

function hasServerSettings(settings) {
  if (!settings) return false;
  if (settings.hidden_devices && settings.hidden_devices.length > 0) return true;
  const ui = settings.ui || {};
  return ui.zoom != null || ui.vu_segs != null || ui.media_visible != null ||
         ui.panel_widths || ui.media_top_height ||
         (ui.sink_colors && Object.keys(ui.sink_colors).length > 0) ||
         (ui.channel_names && Object.keys(ui.channel_names).length > 0);
}

// ── Media panel visibility ────────────────────────────────────────────────

let mediaVisible = localStorage.getItem('pw-media-visible') !== 'false';

function applyMediaVisibility() {
  document.getElementById('panel-media').classList.toggle('collapsed', !mediaVisible);
  document.getElementById('rh-media').classList.toggle('collapsed', !mediaVisible);
  document.getElementById('toggle-media').classList.toggle('toggled', !mediaVisible);
  updateMobileTabVisibility();
}

function updateMobileTabVisibility() {
  document.querySelectorAll('.panel-tab').forEach(btn => {
    const panel = document.getElementById(btn.dataset.panel);
    if (panel) btn.style.display = panel.classList.contains('collapsed') ? 'none' : '';
  });
}

// ── Zoom ──────────────────────────────────────────────────────────────────

let zoom = parseFloat(localStorage.getItem('pw-zoom') || '1');

function applyZoom() {
  document.documentElement.style.setProperty('--zoom', zoom);
  document.getElementById('zoom-label').textContent = Math.round(zoom * 100) + '%';
}

function darkenHex(hex, factor) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  const h = n => Math.round(n*factor).toString(16).padStart(2,'0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function applyAccentColor(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-dim', darkenHex(hex, 0.55));
  accentColor = hex;
}

function applyStripWidth(px) {
  document.documentElement.style.setProperty('--strip-w', px + 'px');
  stripWidth = px;
}

function adjustZoom(d) {
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round((zoom + d) * 10) / 10));
  localStorage.setItem('pw-zoom', zoom);
  applyZoom();
  schedSendSettings();
}

// ── Panel resize ──────────────────────────────────────────────────────────

function initResize(handle, panel, panelOnLeft) {
  // panelOnLeft=true  → drag right widens the panel (panel is left of handle)
  // panelOnLeft=false → drag left  widens the panel (panel is right of handle)
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = panel.offsetWidth;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';

    function onMove(ev) {
      const delta = panelOnLeft ? ev.clientX - x0 : x0 - ev.clientX;
      const newW  = Math.max(90, Math.min(w0 + delta, window.innerWidth * 0.55 / zoom));
      panel.style.width      = newW + 'px';
      panel.style.flexShrink = '0';
    }
    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup',   onUp);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      localStorage.setItem('pw-panel-' + panel.id, panel.style.width);
      schedSendSettings();
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup',   onUp);
  });
}

// ── WebSocket ──────────────────────────────────────────────────────────────

let ws = null;

function connect() {
  setStatus('connecting');
  ws = new WebSocket(`ws://${window.location.hostname}:${WS_PORT}`);
  ws.addEventListener('open',    ()   => setStatus('connected'));
  ws.addEventListener('message', (ev) => onMsg(JSON.parse(ev.data)));
  ws.addEventListener('close',   ()   => { setStatus('disconnected'); setTimeout(connect, 2500); });
  ws.addEventListener('error',   ()   => ws.close());
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setStatus(s) {
  document.getElementById('status-dot').className    = 'status-dot ' + s;
  document.getElementById('status-label').textContent =
    s === 'connected' ? 'Connected' : s === 'connecting' ? 'Connecting…' : 'Disconnected — retrying…';
}

// ── Message routing ────────────────────────────────────────────────────────

function onMsg(msg) {
  if      (msg.type === 'state')  onState(msg);
  else if (msg.type === 'peaks')  onPeaks(msg.data);
  else if (msg.type === 'media')  onMedia(msg);
  else if (msg.type === 'sounds') renderSoundboard(msg.sounds);
}

// ── VU meter ───────────────────────────────────────────────────────────────

function mkVu() {
  const el = document.createElement('div');
  el.className = 'vu';
  for (let i = 0; i < vuSegs; i++) {
    const s = document.createElement('div');
    s.className = 'vu-seg';
    el.appendChild(s);
  }
  return el;
}

function rebuildAllStrips() {
  ['strips-sources', 'strips-sinkinputs', 'strips-sinks'].forEach(id => {
    const c = document.getElementById(id);
    if (c) c.innerHTML = '';
  });
  if (lastState) applyState(lastState);
}

function rebuildAllVu() {
  document.querySelectorAll('.vu').forEach(vu => {
    vu.innerHTML = '';
    for (let i = 0; i < vuSegs; i++) {
      const s = document.createElement('div');
      s.className = 'vu-seg';
      vu.appendChild(s);
    }
  });
}

function segColor(i, ylw, red) {
  return i >= red ? 'r' : i >= ylw ? 'y' : 'g';
}

function setVu(vu, level) {
  const segs = vu.children.length;
  const lit  = Math.round(Math.min(level * vuBoost, 100) / 100 * segs);
  const ylw  = Math.round(segs * 0.58);
  const red  = Math.round(segs * 0.83);

  let peakIdx = -1;
  if (vuPeakHold) {
    let st = vuPeakState.get(vu);
    if (!st) { st = { peak: 0, timer: null }; vuPeakState.set(vu, st); }
    if (lit >= st.peak) {
      st.peak = lit;
      clearTimeout(st.timer);
      st.timer = setTimeout(() => { st.peak = 0; }, vuPeakHoldMs);
    }
    if (st.peak > 0) peakIdx = st.peak - 1;
  }

  for (let i = 0; i < segs; i++) {
    const s = vu.children[i];
    if (i < lit)          s.className = 'vu-seg ' + segColor(i, ylw, red);
    else if (i === peakIdx) s.className = 'vu-seg pk ' + segColor(i, ylw, red);
    else                   s.className = 'vu-seg';
  }
}

function onPeaks(data) {
  for (const [key, peak] of Object.entries(data)) {
    let type, idx;
    if      (key.startsWith('sink-input-')) { type = 'sink-input'; idx = key.slice(11); }
    else if (key.startsWith('sink-'))        { type = 'sink';       idx = key.slice(5);  }
    else if (key.startsWith('source-'))      { type = 'source';     idx = key.slice(7);  }
    else continue;

    const strip = document.querySelector(`.strip[data-type="${type}"][data-index="${idx}"]`);
    if (!strip) continue;
    const vus = strip.querySelectorAll('.vu');
    if (Array.isArray(peak)) {
      if (vus[0]) setVu(vus[0], peak[0]);
      if (vus[1]) setVu(vus[1], peak[1]);
    } else {
      if (vus[0]) setVu(vus[0], peak);
      if (vus[1]) setVu(vus[1], peak);
    }
  }
}

// ── Volume send (debounced) ────────────────────────────────────────────────

function schedVol(type, index, vol) {
  const k = type + index;
  clearTimeout(sendTimers[k]);
  sendTimers[k] = setTimeout(() => send({ type: 'set_volume', target: type, index, volume: vol }), 40);
}

// ── Sink selector helpers ──────────────────────────────────────────────────

function shortLabel(str, max = 13) {
  if (!str) return '?';
  str = str.replace(/\s+(Analogue?s?\s+(Stereo|Mono)|Digital\s+Stereo|Analoges\s+Stereo)\s*$/i, '');
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function sinkDisplayName(sink) {
  return channelNames['sink:' + sink.index] || sink.description || sink.name;
}

function fillSelect(sel, activeSinkIdx) {
  // Preserve whatever the user has selected; only use activeSinkIdx as fallback
  const prev = sel.options.length > 0 ? parseInt(sel.value, 10) : activeSinkIdx;
  sel.innerHTML = '';
  for (const sink of currentSinks) {
    const o   = document.createElement('option');
    o.value   = sink.index;
    o.textContent = shortLabel(sinkDisplayName(sink));
    o.selected    = sink.index === prev;
    sel.appendChild(o);
  }
  // Fallback if nothing matched
  if (!sel.value) {
    const fb = [...sel.options].find(o => parseInt(o.value) === activeSinkIdx);
    if (fb) fb.selected = true;
  }
}

// ── Strip creation ─────────────────────────────────────────────────────────

function mkStrip(item, type, chNum) {
  const hw = type === 'sink' || type === 'source';

  const strip = document.createElement('div');
  strip.className       = 'strip';
  strip.dataset.index   = item.index;
  strip.dataset.type    = type;
  if (type === 'sink-input' && item.sink != null) strip.dataset.sink = item.sink;

  strip.tabIndex = 0;

  // Scroll wheel → adjust volume
  strip.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 2 : -2;
    const fdr = strip.querySelector('.fader');
    if (!fdr) return;
    const v = Math.max(0, Math.min(150, +fdr.value + delta));
    fdr.value = v;
    setVol(strip, v);
    schedVol(type, item.index, v);
  }, { passive: false });

  // Arrow keys + M when strip is focused
  strip.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1;
      const fdr = strip.querySelector('.fader');
      if (!fdr) return;
      const v = Math.max(0, Math.min(150, +fdr.value + (e.key === 'ArrowUp' ? step : -step)));
      fdr.value = v;
      setVol(strip, v);
      schedVol(type, item.index, v);
    }
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      const btn = strip.querySelector('.mute-btn');
      if (!btn) return;
      fadeMute(strip, btn, type, item.index, !btn.classList.contains('on'));
    }
  });

  // ── Color band ──────────────────────────────────────────
  const band = document.createElement('div');
  band.className = 'color-band';
  strip.appendChild(band);

  // ── Header ──────────────────────────────────────────────
  const hdr = document.createElement('div');
  hdr.className = 's-header';
  if (hw) {
    hdr.classList.add('hw');
    const topRow = document.createElement('div');
    topRow.className = 'ch-top-row';

    if (item.virtual) {
      const b = document.createElement('div');
      b.className = 'ch-badge ch-badge-virtual';
      b.textContent = 'V';
      topRow.appendChild(b);
    }

    if (type === 'sink') {
      // Auto-assign a palette colour on first encounter and persist it
      if (!getSinkColor(item.index)) {
        const auto = item.virtual
          ? VIRTUAL_COLOR
          : SINK_PALETTE[(chNum - 1) % SINK_PALETTE.length];
        saveSinkColor(item.index, auto);
      }
      const colorInput = document.createElement('input');
      colorInput.type      = 'color';
      colorInput.className = 'color-pick';
      colorInput.value     = getSinkColor(item.index);
      colorInput.addEventListener('input', () => {
        const c = colorInput.value;
        saveSinkColor(item.index, c);
        applyColorToStrip(strip, c);
        applyColorsToAppStrips(item.index);
      });
      topRow.appendChild(colorInput);
    }
    hdr.appendChild(topRow);

    const nameEl = document.createElement('div');
    nameEl.className = 'ch-name';
    nameEl.title     = item.description || item.name || '';
    const _nameKey = type + ':' + item.index;
    nameEl.textContent = channelNames[_nameKey] || shortLabel(item.description || item.name || '', 11);
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'ch-rename-input';
      inp.value = channelNames[_nameKey] || (item.description || item.name || '');
      inp.maxLength = 20;
      nameEl.replaceWith(inp);
      inp.select();
      const commit = () => {
        const val = inp.value.trim();
        if (val) channelNames[_nameKey] = val; else delete channelNames[_nameKey];
        nameEl.textContent = channelNames[_nameKey] || shortLabel(item.description || item.name || '', 11);
        inp.replaceWith(nameEl);
        schedSendSettings();
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
        if (ev.key === 'Escape') { inp.replaceWith(nameEl); }
      });
    });
    hdr.appendChild(nameEl);
  } else {
    const appKey = (item.appName || item.mediaName || '').toLowerCase();
    strip.dataset.appkey = appKey;

    const topRow = document.createElement('div');
    topRow.className = 'ch-top-row';
    const appColorInput = document.createElement('input');
    appColorInput.type = 'color';
    appColorInput.className = 'color-pick';
    appColorInput.value = getAppColor(appKey) || '#888888';
    appColorInput.addEventListener('input', () => {
      saveAppColor(appKey, appColorInput.value);
      applyColorToStrip(strip, appColorInput.value);
    });
    topRow.appendChild(appColorInput);
    hdr.appendChild(topRow);

    const rawAppName = item.appName || item.mediaName || 'Stream';
    const n = document.createElement('div');
    n.className   = 'app-name';
    n.title       = rawAppName;
    n.textContent = getAppName(appKey) || shortLabel(rawAppName, 10);
    n.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'ch-rename-input';
      inp.value = getAppName(appKey) || rawAppName;
      inp.maxLength = 20;
      n.replaceWith(inp);
      inp.select();
      const commit = () => {
        const val = inp.value.trim();
        saveAppName(appKey, val);
        n.textContent = getAppName(appKey) || shortLabel(rawAppName, 10);
        inp.replaceWith(n);
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
        if (ev.key === 'Escape') { inp.replaceWith(n); }
      });
    });
    hdr.appendChild(n);
  }
  strip.appendChild(hdr);

  // ── Body: VU + fader ────────────────────────────────────
  const body = document.createElement('div');
  body.className = 's-body';

  const vuCol = document.createElement('div');
  vuCol.className = stereoMeters ? 'vu-col stereo' : 'vu-col';
  const vu = mkVu();
  vuCol.appendChild(vu);
  if (stereoMeters) vuCol.appendChild(mkVu());
  body.appendChild(vuCol);

  const fw = document.createElement('div');
  fw.className = 'fader-wrap';
  const fader = document.createElement('input');
  fader.type      = 'range';
  fader.className = 'fader';
  fader.min = 0; fader.max = 150; fader.step = 1;
  fader.value = item.volume;
  fader.addEventListener('input', () => {
    const v = +fader.value;
    setVol(strip, v);
    schedVol(type, item.index, v);
  });
  fader.addEventListener('dblclick', () => {
    fader.value = 100;
    setVol(strip, 100);
    schedVol(type, item.index, 100);
  });
  // Double-tap for touch devices
  let _lastTap = 0;
  fader.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - _lastTap < 300) {
      e.preventDefault();
      fader.value = 100;
      setVol(strip, 100);
      schedVol(type, item.index, 100);
    }
    _lastTap = now;
  }, { passive: false });
  fw.appendChild(fader);
  body.appendChild(fw);
  strip.appendChild(body);

  // ── Footer: vol% / sink-sel / mute ──────────────────────
  const foot = document.createElement('div');
  foot.className = 's-footer';

  const volEl = document.createElement('div');
  volEl.className = 'vol-pct';
  foot.appendChild(volEl);

  if (type === 'sink-input') {
    const sel = document.createElement('select');
    sel.className = 'sink-sel';
    fillSelect(sel, item.sink);
    sel.addEventListener('change', (e) => {
      e.stopPropagation();
      const sinkIdx = parseInt(sel.value, 10);
      if (!isNaN(sinkIdx)) {
        strip.dataset.sink = sinkIdx;
        applyColorToStrip(strip, getEffectiveSinkColor(sinkIdx));
        send({ type: 'move_sink_input', index: item.index, sink: sinkIdx });
      }
    });
    foot.appendChild(sel);
  }

  if (type === 'source') {
    const routeSel = document.createElement('select');
    routeSel.className = 'sink-sel route-sel';
    fillSourceRouteSel(routeSel, sourceRoutes[item.name] || '');
    routeSel.addEventListener('change', (e) => {
      e.stopPropagation();
      const sinkName = routeSel.value;
      const targetSink = (lastState ? lastState.sinks : []).find(s => s.name === sinkName);
      const color = targetSink ? getEffectiveSinkColor(targetSink.index) : null;
      applyColorToStrip(strip, color);
      send({ type: 'route_source', source_name: item.name, sink_name: sinkName });
    });
    foot.appendChild(routeSel);
  }

  const muteBtn = document.createElement('button');
  muteBtn.type      = 'button';
  muteBtn.className = 'mute-btn';
  muteBtn.textContent = 'MUTE';
  // Read mute state from DOM (button class), not from stale item closure
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fadeMute(strip, muteBtn, type, item.index, !muteBtn.classList.contains('on'));
  });

  const btnRow = document.createElement('div');
  btnRow.className = 's-btn-row';

  const soloBtn = document.createElement('button');
  soloBtn.type = 'button';
  soloBtn.className = 'solo-btn';
  soloBtn.textContent = 'S';
  soloBtn.title = 'Solo';
  soloBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSolo(type, item.index, soloBtn);
  });
  btnRow.appendChild(soloBtn);
  btnRow.appendChild(muteBtn);
  foot.appendChild(btnRow);
  strip.appendChild(foot);

  // Apply initial state
  setVol(strip, item.volume);
  setVu(vu, 0);
  setMute(strip, muteBtn, item.mute);
  if (item.corked) strip.classList.add('corked');

  // Apply color
  if (type === 'sink') {
    const c = getEffectiveSinkColor(item.index);
    if (c) applyColorToStrip(strip, c);
  } else if (type === 'sink-input') {
    const appKey = (item.appName || item.mediaName || '').toLowerCase();
    const c = getAppColor(appKey) || (item.sink != null ? getEffectiveSinkColor(item.sink) : null);
    if (c) applyColorToStrip(strip, c);
  } else if (type === 'source') {
    const routedName = sourceRoutes[item.name] || '';
    if (routedName) {
      const targetSink = (lastState ? lastState.sinks : []).find(s => s.name === routedName);
      if (targetSink) applyColorToStrip(strip, getEffectiveSinkColor(targetSink.index));
    }
  }

  return strip;
}

function toggleSolo(type, index, soloBtn) {
  const key = type + ':' + index;
  if (soloSet.has(key)) {
    soloSet.delete(key);
    soloBtn.classList.remove('on');
  } else {
    soloSet.add(key);
    soloBtn.classList.add('on');
  }
  applySolo();
}

function applySolo() {
  if (soloSet.size === 0) {
    document.querySelectorAll('.strip').forEach(strip => {
      const key = strip.dataset.type + ':' + strip.dataset.index;
      if (key in preSoloMutes) {
        const btn = strip.querySelector('.mute-btn');
        if (btn) {
          setMute(strip, btn, preSoloMutes[key]);
          send({ type: 'set_mute', target: strip.dataset.type,
                 index: parseInt(strip.dataset.index), mute: preSoloMutes[key] });
        }
      }
    });
    preSoloMutes = {};
  } else {
    // Only affect strips whose type has at least one active solo
    const soloTypes = new Set([...soloSet].map(k => k.split(':')[0]));
    document.querySelectorAll('.strip').forEach(strip => {
      const type = strip.dataset.type;
      if (!soloTypes.has(type)) return;   // don't touch other panels
      const key  = type + ':' + strip.dataset.index;
      const btn  = strip.querySelector('.mute-btn');
      if (!btn) return;
      if (!(key in preSoloMutes)) preSoloMutes[key] = btn.classList.contains('on');
      const shouldMute = !soloSet.has(key);
      setMute(strip, btn, shouldMute);
      send({ type: 'set_mute', target: type,
             index: parseInt(strip.dataset.index), mute: shouldMute });
    });
  }
}

function setMute(strip, btn, muted) {
  strip.classList.toggle('muted', muted);
  btn.classList.toggle('on', muted);
}

function fadeMute(strip, btn, type, index, nowMuted) {
  if (!smoothMute) {
    setMute(strip, btn, nowMuted);
    send({ type: 'set_mute', target: type, index, mute: nowMuted });
    return;
  }
  const fader = strip.querySelector('.fader');
  if (!fader) {
    setMute(strip, btn, nowMuted);
    send({ type: 'set_mute', target: type, index, mute: nowMuted });
    return;
  }
  const STEPS = 8, DURATION = 160;
  if (nowMuted) {
    const startVol = +fader.value;
    strip.dataset.premutevol = startVol;
    let step = 0;
    const iv = setInterval(() => {
      step++;
      const v = Math.round(startVol * (1 - step / STEPS));
      fader.value = v; setVol(strip, v);
      send({ type: 'set_volume', target: type, index, volume: v });
      if (step >= STEPS) {
        clearInterval(iv);
        setMute(strip, btn, true);
        send({ type: 'set_mute', target: type, index, mute: true });
      }
    }, DURATION / STEPS);
  } else {
    setMute(strip, btn, false);
    send({ type: 'set_mute', target: type, index, mute: false });
    const targetVol = parseInt(strip.dataset.premutevol || '100', 10);
    let step = 0;
    const iv = setInterval(() => {
      step++;
      const v = Math.round(targetVol * (step / STEPS));
      fader.value = v; setVol(strip, v);
      send({ type: 'set_volume', target: type, index, volume: v });
      if (step >= STEPS) clearInterval(iv);
    }, DURATION / STEPS);
  }
}

function setVol(strip, vol) {
  const el = strip.querySelector('.vol-pct');
  if (el) { el.textContent = vol + '%'; el.classList.toggle('clip', vol > 100); }
}

// ── Label bars ─────────────────────────────────────────────────────────────

function updateLabels(barId, items) {
  const bar = document.getElementById(barId);
  if (!bar) return;
  bar.innerHTML = '';
  items.forEach((item, i) => {
    const d = document.createElement('div');
    d.className = 'ch-lbl';
    d.innerHTML = `<span class="ch-lbl-n">${i + 1}</span>`
                + `<span class="ch-lbl-d" title="${item.description || item.name || ''}">${item.description || item.name || '—'}</span>`;
    bar.appendChild(d);
  });
}

// ── Section render (diff-based) ─────────────────────────────────────────────

function renderSection(stripsId, items, type, labelsId) {
  const cont  = document.getElementById(stripsId);
  const empty = document.getElementById(stripsId.replace('strips-', 'empty-'));

  const existing = {};
  cont.querySelectorAll('.strip').forEach(el => { existing[el.dataset.index] = el; });

  const newSet = new Set(items.map(i => String(i.index)));

  // Remove gone strips; sink-inputs get a 1.5 s grace period so rapid
  // pause/play transitions don't flash the strip away.
  Object.keys(existing).forEach(k => {
    if (newSet.has(k)) return;
    if (type === 'sink-input') {
      if (!stripRemovalTimers.has(k)) {
        existing[k].classList.add('removing');
        stripRemovalTimers.set(k, setTimeout(() => {
          existing[k].remove();
          stripRemovalTimers.delete(k);
        }, 1500));
      }
    } else {
      existing[k].remove();
    }
  });

  items.forEach((item, pos) => {
    const key = String(item.index);
    // Cancel any pending removal if the stream reappeared
    if (stripRemovalTimers.has(key)) {
      clearTimeout(stripRemovalTimers.get(key));
      stripRemovalTimers.delete(key);
      if (existing[key]) existing[key].classList.remove('removing');
    }
    if (key in existing) {
      // ── Update existing strip in place ──
      const strip = existing[key];
      const fader = strip.querySelector('.fader');
      const muteBtn = strip.querySelector('.mute-btn');

      if (fader !== document.activeElement) {
        fader.value = item.volume;
        setVol(strip, item.volume);
      }
      // Refresh custom channel name if not currently being edited
      const nameEl2 = strip.querySelector('.ch-name');
      if (nameEl2) {
        const nk = type + ':' + item.index;
        nameEl2.textContent = channelNames[nk] || shortLabel(item.description || item.name || '', 11);
      }
      // Only update mute if it differs from DOM state (avoid overwriting user action mid-flight)
      const domMuted = muteBtn.classList.contains('on');
      if (domMuted !== item.mute) setMute(strip, muteBtn, item.mute);

      strip.classList.toggle('corked', !!item.corked);

      if (type === 'sink-input') {
        if (item.sink != null) {
          strip.dataset.sink = item.sink;
          const appKey = strip.dataset.appkey || '';
          applyColorToStrip(strip, getAppColor(appKey) || getEffectiveSinkColor(item.sink));
        }
        const sel = strip.querySelector('.sink-sel');
        if (sel) fillSelect(sel, item.sink);
        // Refresh custom app name if not currently being edited
        const appNameEl = strip.querySelector('.app-name');
        if (appNameEl) {
          const ak = strip.dataset.appkey || '';
          const raw = item.appName || item.mediaName || 'Stream';
          appNameEl.textContent = getAppName(ak) || shortLabel(raw, 10);
        }
      }

      if (type === 'source') {
        const routeSel = strip.querySelector('.route-sel');
        if (routeSel) fillSourceRouteSel(routeSel, sourceRoutes[item.name] || '');
        const routedName = sourceRoutes[item.name] || '';
        if (routedName) {
          const targetSink = (lastState ? lastState.sinks : []).find(s => s.name === routedName);
          if (targetSink) applyColorToStrip(strip, getEffectiveSinkColor(targetSink.index));
        } else {
          applyColorToStrip(strip, null);
        }
      }

      // Re-order if needed
      if (cont.children[pos] !== strip) cont.insertBefore(strip, cont.children[pos] || null);
    } else {
      cont.insertBefore(mkStrip(item, type, pos + 1), cont.children[pos] || null);
    }
  });

  if (empty) empty.classList.toggle('on', items.length === 0);
  if (labelsId) updateLabels(labelsId, items);
}

// ── Settings ────────────────────────────────────────────────────────────────

const HIDDEN_KEY = 'pw-hidden';
let lastState = null;

function getHidden() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); }
  catch { return new Set(); }
}
function setHidden(set) {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set]));
  schedSendSettings();
}

let settingsTab = localStorage.getItem('pw-settings-tab') || 'display';

function openSettings() {
  if (!lastState) return;
  const body = document.getElementById('settings-body');
  const hidden = getHidden();
  body.innerHTML = '';

  // ── Tab bar ──────────────────────────────────────────────────────────────
  const tabBar = document.getElementById('settings-tabs');
  tabBar.innerHTML = '';
  [
    ['display',  'Display'],
    ['inputs',   'Inputs'],
    ['outputs',  'Outputs'],
    ['routing',  'Auto Routing'],
    ['virtual',  'Virtual Outputs'],
    ['backup',   'Backup & Restore'],
  ].forEach(([id, label]) => {
    const btn = document.createElement('button');
    btn.className = 'settings-tab' + (id === settingsTab ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      settingsTab = id;
      localStorage.setItem('pw-settings-tab', settingsTab);
      openSettings();
    });
    tabBar.appendChild(btn);
  });

  // ── Helper: device visibility section ────────────────────────────────────
  function buildDeviceSection(title, items) {
    if (!items.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:11px;color:var(--text-dim);padding:8px 0;';
      empty.textContent = 'No devices found.';
      body.appendChild(empty);
      return;
    }
    const sec = document.createElement('div');
    sec.className = 'settings-section';
    const h = document.createElement('div');
    h.className = 'settings-section-title'; h.textContent = title;
    sec.appendChild(h);
    items.forEach(item => {
      const lbl = document.createElement('label');
      lbl.className = 'settings-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !hidden.has(item.name);
      cb.addEventListener('change', () => {
        const h2 = getHidden();
        if (cb.checked) h2.delete(item.name); else h2.add(item.name);
        setHidden(h2);
        if (lastState) applyState(lastState);
      });
      lbl.appendChild(cb);
      const txt = document.createElement('span');
      txt.textContent = item.description || item.name || 'Unknown';
      lbl.appendChild(txt);
      sec.appendChild(lbl);
    });
    body.appendChild(sec);
  }

  // ── DISPLAY tab ──────────────────────────────────────────────────────────
  if (settingsTab === 'display') {
    const dsec = document.createElement('div');
    dsec.className = 'settings-section';
    const dh = document.createElement('div');
    dh.className = 'settings-section-title'; dh.textContent = 'Meters';
    dsec.appendChild(dh);

    // VU sensitivity
    const bstRow = document.createElement('div');
    bstRow.className = 'settings-row settings-slider-row';
    const bstLbl = document.createElement('span'); bstLbl.textContent = 'VU sensitivity';
    const bstVal = document.createElement('span');
    bstVal.className = 'settings-slider-val'; bstVal.textContent = vuBoost.toFixed(2) + '×';
    const bstSlider = document.createElement('input');
    bstSlider.type = 'range'; bstSlider.min = '1.0'; bstSlider.max = '4.0'; bstSlider.step = '0.05';
    bstSlider.value = vuBoost; bstSlider.className = 'settings-slider';
    bstSlider.addEventListener('input', () => {
      vuBoost = parseFloat(bstSlider.value);
      localStorage.setItem('pw-vu-boost', vuBoost);
      bstVal.textContent = vuBoost.toFixed(2) + '×';
      schedSendSettings();
    });
    bstRow.appendChild(bstLbl); bstRow.appendChild(bstSlider); bstRow.appendChild(bstVal);
    dsec.appendChild(bstRow);

    // VU segments
    const vuRow = document.createElement('div');
    vuRow.className = 'settings-row settings-slider-row';
    const vuLbl = document.createElement('span'); vuLbl.textContent = 'VU segments';
    const vuVal = document.createElement('span');
    vuVal.className = 'settings-slider-val'; vuVal.textContent = vuSegs;
    const vuSlider = document.createElement('input');
    vuSlider.type = 'range'; vuSlider.min = 8; vuSlider.max = 64; vuSlider.step = 4;
    vuSlider.value = vuSegs; vuSlider.className = 'settings-slider';
    vuSlider.addEventListener('input', () => { vuVal.textContent = vuSlider.value; });
    vuSlider.addEventListener('change', () => {
      vuSegs = parseInt(vuSlider.value);
      localStorage.setItem('pw-vu-segs', vuSegs);
      rebuildAllVu(); schedSendSettings();
    });
    vuRow.appendChild(vuLbl); vuRow.appendChild(vuSlider); vuRow.appendChild(vuVal);
    dsec.appendChild(vuRow);

    // VU peak hold
    const pkRow = document.createElement('label');
    pkRow.className = 'settings-row';
    const pkCb = document.createElement('input');
    pkCb.type = 'checkbox'; pkCb.checked = vuPeakHold;
    pkCb.addEventListener('change', () => {
      vuPeakHold = pkCb.checked;
      localStorage.setItem('pw-vu-peak-hold', vuPeakHold);
      pkTimeRow.style.display = vuPeakHold ? '' : 'none';
      if (!vuPeakHold) {
        document.querySelectorAll('.vu').forEach(vu => {
          const st = vuPeakState.get(vu);
          if (st) { clearTimeout(st.timer); st.peak = 0; }
        });
      }
      schedSendSettings();
    });
    const pkLbl = document.createElement('span'); pkLbl.textContent = 'VU peak hold';
    pkRow.appendChild(pkCb); pkRow.appendChild(pkLbl);
    dsec.appendChild(pkRow);

    const pkTimeRow = document.createElement('div');
    pkTimeRow.className = 'settings-row settings-row-indent';
    pkTimeRow.style.display = vuPeakHold ? '' : 'none';
    const pkTimeLbl = document.createElement('span'); pkTimeLbl.textContent = 'Hold time';
    const pkTimeValLbl = document.createElement('span');
    pkTimeValLbl.className = 'settings-val';
    pkTimeValLbl.textContent = (vuPeakHoldMs / 1000).toFixed(1) + ' s';
    const pkTimeSlider = document.createElement('input');
    pkTimeSlider.type = 'range'; pkTimeSlider.min = '200'; pkTimeSlider.max = '10000'; pkTimeSlider.step = '100';
    pkTimeSlider.value = vuPeakHoldMs; pkTimeSlider.className = 'settings-slider';
    pkTimeSlider.addEventListener('input', () => {
      vuPeakHoldMs = parseInt(pkTimeSlider.value);
      localStorage.setItem('pw-vu-peak-hold-ms', vuPeakHoldMs);
      pkTimeValLbl.textContent = (vuPeakHoldMs / 1000).toFixed(1) + ' s';
      schedSendSettings();
    });
    pkTimeRow.appendChild(pkTimeLbl); pkTimeRow.appendChild(pkTimeSlider); pkTimeRow.appendChild(pkTimeValLbl);
    dsec.appendChild(pkTimeRow);

    // Stereo meters
    const stRow = document.createElement('label');
    stRow.className = 'settings-row';
    const stCb = document.createElement('input');
    stCb.type = 'checkbox'; stCb.checked = stereoMeters;
    stCb.addEventListener('change', () => {
      stereoMeters = stCb.checked;
      localStorage.setItem('pw-stereo-meters', stereoMeters);
      schedSendSettings(); rebuildAllStrips();
    });
    const stLbl = document.createElement('span'); stLbl.textContent = 'Stereo VU meters (L/R)';
    stRow.appendChild(stCb); stRow.appendChild(stLbl);
    dsec.appendChild(stRow);

    body.appendChild(dsec);

    // Appearance
    const asec = document.createElement('div');
    asec.className = 'settings-section';
    const ah = document.createElement('div');
    ah.className = 'settings-section-title'; ah.textContent = 'Appearance';
    asec.appendChild(ah);

    // Smooth mute
    const smRow = document.createElement('label');
    smRow.className = 'settings-row';
    const smCb = document.createElement('input');
    smCb.type = 'checkbox'; smCb.checked = smoothMute;
    smCb.addEventListener('change', () => {
      smoothMute = smCb.checked;
      localStorage.setItem('pw-smooth-mute', smoothMute);
      schedSendSettings();
    });
    const smLbl = document.createElement('span'); smLbl.textContent = 'Smooth mute fade (~160 ms)';
    smRow.appendChild(smCb); smRow.appendChild(smLbl);
    asec.appendChild(smRow);

    // Accent color
    const acRow = document.createElement('div');
    acRow.className = 'settings-row';
    const acLbl = document.createElement('span');
    acLbl.textContent = 'Accent color'; acLbl.style.flex = '1';
    const acPick = document.createElement('input');
    acPick.type = 'color'; acPick.value = accentColor;
    acPick.style.cssText = 'width:32px;height:22px;padding:0;border:none;cursor:pointer;background:none;';
    acPick.addEventListener('input', () => {
      applyAccentColor(acPick.value);
      localStorage.setItem('pw-accent', accentColor);
      schedSendSettings();
    });
    acRow.appendChild(acLbl); acRow.appendChild(acPick);
    asec.appendChild(acRow);

    // Strip width
    const swRow = document.createElement('div');
    swRow.className = 'settings-row settings-slider-row';
    const swLbl = document.createElement('span'); swLbl.textContent = 'Strip width';
    const swVal = document.createElement('span');
    swVal.className = 'settings-slider-val'; swVal.textContent = stripWidth + 'px';
    const swSlider = document.createElement('input');
    swSlider.type = 'range'; swSlider.min = 60; swSlider.max = 140; swSlider.step = 4;
    swSlider.value = stripWidth; swSlider.className = 'settings-slider';
    swSlider.addEventListener('input', () => { swVal.textContent = swSlider.value + 'px'; });
    swSlider.addEventListener('change', () => {
      applyStripWidth(parseInt(swSlider.value));
      localStorage.setItem('pw-strip-w', stripWidth);
      schedSendSettings();
    });
    swRow.appendChild(swLbl); swRow.appendChild(swSlider); swRow.appendChild(swVal);
    asec.appendChild(swRow);

    body.appendChild(asec);

    // Keyboard shortcuts
    const ksec = document.createElement('div');
    ksec.className = 'settings-section';
    const kh = document.createElement('div');
    kh.className = 'settings-section-title'; kh.textContent = 'Keyboard Shortcuts';
    ksec.appendChild(kh);
    [
      ['Scroll wheel on strip',    'Adjust volume ±2%'],
      ['↑ / ↓ on focused strip',   'Volume ±1%'],
      ['Shift + ↑ / ↓',            'Volume ±5%'],
      ['M on focused strip',       'Toggle mute'],
      ['Double-click fader',       'Snap to 100%'],
      ['Double-click channel name','Rename hardware channel'],
      ['Double-click app name',    'Rename application'],
      ['Space (no input focused)', 'Media play / pause'],
    ].forEach(([key, desc]) => {
      const row = document.createElement('div');
      row.className = 'settings-row settings-kb-row';
      const k = document.createElement('span');
      k.className = 'settings-kb-key'; k.textContent = key;
      const d = document.createElement('span');
      d.className = 'settings-kb-desc'; d.textContent = desc;
      row.appendChild(k); row.appendChild(d);
      ksec.appendChild(row);
    });
    body.appendChild(ksec);

  // ── INPUTS tab ───────────────────────────────────────────────────────────
  } else if (settingsTab === 'inputs') {
    buildDeviceSection('Hardware Inputs', lastState.sources);

  // ── OUTPUTS tab ──────────────────────────────────────────────────────────
  } else if (settingsTab === 'outputs') {
    buildDeviceSection('Hardware Outputs', lastState.sinks);

  // ── AUTO ROUTING tab ─────────────────────────────────────────────────────
  } else if (settingsTab === 'routing') {
    const arsec = document.createElement('div');
    arsec.className = 'settings-section';
    const arh = document.createElement('div');
    arh.className = 'settings-section-title'; arh.textContent = 'Auto-Routing Rules';
    arsec.appendChild(arh);

    const arDesc = document.createElement('div');
    arDesc.style.cssText = 'font-size:10px;color:var(--text-dim);margin-bottom:8px;line-height:1.5;';
    arDesc.textContent = 'When a new app stream opens whose name contains the match text, it is automatically routed to the chosen output.';
    arsec.appendChild(arDesc);

    let autoRoutes = (lastState.settings && lastState.settings.auto_routes) ? [...lastState.settings.auto_routes] : [];

    const addArRow = document.createElement('div');
    addArRow.className = 'settings-add-row';

    function renderAutoRoutes() {
      arsec.querySelectorAll('.ar-rule-row').forEach(r => r.remove());
      autoRoutes.forEach((rule, i) => {
        const row = document.createElement('div');
        row.className = 'settings-row ar-rule-row';
        row.style.cssText = 'justify-content:space-between;gap:6px;';
        const matchSpan = document.createElement('span');
        matchSpan.style.cssText = 'flex:1;color:var(--accent);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        matchSpan.textContent = '"' + rule.match + '" → ' + shortLabel(rule.sink_name, 16);
        const delBtn = document.createElement('button');
        delBtn.className = 'settings-del-btn'; delBtn.textContent = '🗑'; delBtn.title = 'Delete rule';
        delBtn.addEventListener('click', () => {
          autoRoutes.splice(i, 1);
          send({ type: 'save_settings', auto_routes: autoRoutes });
          renderAutoRoutes();
        });
        row.appendChild(matchSpan); row.appendChild(delBtn);
        arsec.insertBefore(row, addArRow);
      });
    }

    const arMatchIn = document.createElement('input');
    arMatchIn.type = 'text'; arMatchIn.placeholder = 'App name contains…';
    arMatchIn.className = 'settings-text-input';
    const arSinkSel = document.createElement('select');
    arSinkSel.className = 'settings-loop-sel';
    (lastState.sinks || []).forEach(s => {
      const o = document.createElement('option');
      o.value = s.name; o.textContent = shortLabel(sinkDisplayName(s), 18);
      arSinkSel.appendChild(o);
    });
    const arAddBtn = document.createElement('button');
    arAddBtn.className = 'settings-add-btn'; arAddBtn.textContent = '+ Add Rule';
    arAddBtn.addEventListener('click', () => {
      const match = arMatchIn.value.trim();
      if (!match || !arSinkSel.value) return;
      autoRoutes.push({ match, sink_name: arSinkSel.value });
      send({ type: 'save_settings', auto_routes: autoRoutes });
      arMatchIn.value = '';
      renderAutoRoutes();
    });
    addArRow.appendChild(arMatchIn); addArRow.appendChild(arSinkSel); addArRow.appendChild(arAddBtn);
    arsec.appendChild(addArRow);
    renderAutoRoutes();
    body.appendChild(arsec);

  // ── VIRTUAL OUTPUTS tab ───────────────────────────────────────────────────
  } else if (settingsTab === 'virtual') {
    const vsec = document.createElement('div');
    vsec.className = 'settings-section';
    const vh = document.createElement('div');
    vh.className = 'settings-section-title'; vh.textContent = 'Virtual Outputs';
    vsec.appendChild(vh);

    (lastState.virtualSinks || []).forEach(vs => {
      const row = document.createElement('div');
      row.className = 'settings-row settings-vs-row';
      const info = document.createElement('span');
      info.style.flex = '1';
      info.textContent = vs.display_name + (vs.loopback_sink ? ' → ' + shortLabel(vs.loopback_sink, 18) : '');
      row.appendChild(info);
      const del = document.createElement('button');
      del.className = 'settings-del-btn'; del.textContent = '🗑'; del.title = 'Delete virtual output';
      del.addEventListener('click', () => {
        send({ type: 'delete_virtual_sink', sink_name: vs.sink_name });
        row.remove();
      });
      row.appendChild(del);
      vsec.appendChild(row);
    });

    const addRow = document.createElement('div');
    addRow.className = 'settings-add-row';
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.placeholder = 'Name…'; nameIn.className = 'settings-text-input';
    const loopSel = document.createElement('select');
    loopSel.className = 'settings-loop-sel';
    const noneOpt = document.createElement('option');
    noneOpt.value = ''; noneOpt.textContent = '(no loopback)';
    loopSel.appendChild(noneOpt);
    (lastState.sinks || []).filter(s => !s.virtual).forEach(s => {
      const o = document.createElement('option');
      o.value = s.name; o.textContent = shortLabel(sinkDisplayName(s), 16);
      loopSel.appendChild(o);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'settings-add-btn'; addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => {
      const name = nameIn.value.trim();
      if (!name) return;
      send({ type: 'create_virtual_sink', name, loopback_sink: loopSel.value });
      nameIn.value = '';
    });
    addRow.appendChild(nameIn); addRow.appendChild(loopSel); addRow.appendChild(addBtn);
    vsec.appendChild(addRow);
    body.appendChild(vsec);

  // ── BACKUP & RESTORE tab ─────────────────────────────────────────────────
  } else if (settingsTab === 'backup') {
    const bksec = document.createElement('div');
    bksec.className = 'settings-section';
    const bkh = document.createElement('div');
    bkh.className = 'settings-section-title'; bkh.textContent = 'Backup & Restore';
    bksec.appendChild(bkh);

    const bkRow = document.createElement('div');
    bkRow.className = 'settings-row settings-backup-row';

    const dlBtn = document.createElement('a');
    dlBtn.href = '/api/backup';
    dlBtn.download = 'pipedeck-backup.zip';
    dlBtn.className = 'settings-action-btn';
    dlBtn.textContent = '⬇ Download backup';
    bkRow.appendChild(dlBtn);

    const restoreInput = document.createElement('input');
    restoreInput.type = 'file'; restoreInput.accept = '.zip'; restoreInput.style.display = 'none';
    const restoreStatus = document.createElement('span');
    restoreStatus.className = 'settings-backup-status';

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button'; restoreBtn.className = 'settings-action-btn';
    restoreBtn.textContent = '⬆ Restore backup';
    restoreBtn.addEventListener('click', () => restoreInput.click());
    restoreInput.addEventListener('change', async () => {
      const file = restoreInput.files[0];
      if (!file) return;
      restoreStatus.textContent = 'Uploading…'; restoreStatus.style.color = 'var(--text)';
      try {
        const res = await fetch('/api/restore', { method: 'POST', body: file,
          headers: { 'Content-Type': 'application/zip', 'Content-Length': file.size } });
        const json = await res.json();
        if (json.ok) {
          restoreStatus.textContent = '✓ Restored'; restoreStatus.style.color = 'var(--accent)';
        } else {
          restoreStatus.textContent = '✗ ' + (json.error || 'failed'); restoreStatus.style.color = '#e05050';
        }
      } catch {
        restoreStatus.textContent = '✗ Upload failed'; restoreStatus.style.color = '#e05050';
      }
      restoreInput.value = '';
      setTimeout(() => { restoreStatus.textContent = ''; }, 4000);
    });
    bkRow.appendChild(restoreBtn); bkRow.appendChild(restoreInput);
    bksec.appendChild(bkRow); bksec.appendChild(restoreStatus);
    body.appendChild(bksec);
  }

  document.getElementById('settings-overlay').classList.remove('hidden');
}

// ── Media controls ──────────────────────────────────────────────────────────

let currentMediaPlayer = '';

function onMedia(data) {
  currentMediaPlayer = data.player || '';
  document.getElementById('media-player').textContent = data.player ? '[' + data.player + ']' : '';
  document.getElementById('media-title').textContent  = data.title  || 'Nothing playing';
  document.getElementById('media-artist').textContent = data.artist || '';
  document.getElementById('mc-play').textContent = data.status === 'Playing' ? '⏸' : '▶';
}

// ── Soundboard ───────────────────────────────────────────────────────────────

function fillSbSinkSel(sinks) {
  const sel = document.getElementById('sb-sink');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  sinks.forEach(s => {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = shortLabel(sinkDisplayName(s));
    o.selected = s.name === prev;
    sel.appendChild(o);
  });
}

function renderSoundboard(sounds) {
  if (Array.isArray(sounds)) sounds = sounds.length ? {'': sounds} : {};
  const grid = document.getElementById('sb-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const folders = Object.keys(sounds);
  if (folders.length === 0) {
    grid.innerHTML = '<div class="sb-empty">Drop .mp3 / .wav files<br>into <code>sounds/</code></div>';
    return;
  }
  const showHdrs = folders.length > 1 || (folders.length === 1 && folders[0] !== '');
  folders.forEach(folder => {
    if (showHdrs && folder !== '') {
      const hdr = document.createElement('div');
      hdr.className = 'sb-folder-hdr';
      hdr.textContent = folder;
      grid.appendChild(hdr);
    }
    sounds[folder].forEach(name => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'sb-btn';
      btn.textContent = name.replace(/\.[^.]+$/, '');
      btn.title = (folder ? folder + '/' : '') + name;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sb-btn.active').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        send({ type: 'play_sound', file: name, folder,
               sink: document.getElementById('sb-sink').value });
      });
      grid.appendChild(btn);
    });
  });
}

// ── Scenes ──────────────────────────────────────────────────────────────────

function captureScene() {
  if (!lastState) return null;
  return {
    sinks:   lastState.sinks.map(s   => ({ index: s.index,  volume: s.volume, mute: s.mute })),
    sources: lastState.sources.map(s => ({ index: s.index,  volume: s.volume, mute: s.mute })),
    routes:  { ...sourceRoutes },
  };
}

function applyScene(scene) {
  const st = scene.state;
  (st.sinks || []).forEach(s => {
    send({ type: 'set_volume', target: 'sink',   index: s.index, volume: s.volume });
    send({ type: 'set_mute',   target: 'sink',   index: s.index, mute:   s.mute   });
  });
  (st.sources || []).forEach(s => {
    send({ type: 'set_volume', target: 'source', index: s.index, volume: s.volume });
    send({ type: 'set_mute',   target: 'source', index: s.index, mute:   s.mute   });
  });
  Object.entries(st.routes || {}).forEach(([srcName, sinkName]) => {
    send({ type: 'route_source', source_name: srcName, sink_name: sinkName });
  });
}

function saveScenes() {
  send({ type: 'save_settings', scenes });
  renderSceneButtons();
}

function renderSceneButtons() {
  const container = document.getElementById('scene-btns');
  if (!container) return;
  container.innerHTML = '';
  scenes.forEach(scene => {
    const btn = document.createElement('button');
    btn.className = 'zoom-btn scene-btn';
    btn.title     = scene.name;
    btn.textContent = scene.icon;
    btn.addEventListener('click', () => applyScene(scene));
    container.appendChild(btn);
  });
}

function openScenesManager() {
  const body = document.getElementById('scenes-body');
  body.innerHTML = '';

  // ── Saved scenes ──
  if (scenes.length > 0) {
    const listSec = document.createElement('div');
    listSec.className = 'settings-section';
    const lh = document.createElement('div');
    lh.className = 'settings-section-title'; lh.textContent = 'Saved Scenes';
    listSec.appendChild(lh);

    scenes.forEach(scene => {
      const row = document.createElement('div');
      row.className = 'scene-list-row';

      const iconEl = document.createElement('span');
      iconEl.className = 'scene-list-icon'; iconEl.textContent = scene.icon;

      const nameEl = document.createElement('span');
      nameEl.className = 'scene-list-name'; nameEl.textContent = scene.name;

      const applyBtn = document.createElement('button');
      applyBtn.className = 'scene-apply-btn'; applyBtn.textContent = '▶ Apply';
      applyBtn.addEventListener('click', () => {
        applyScene(scene);
        document.getElementById('scenes-overlay').classList.add('hidden');
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'settings-del-btn'; delBtn.textContent = '🗑';
      delBtn.title = 'Delete scene';
      delBtn.addEventListener('click', () => {
        scenes = scenes.filter(s => s.id !== scene.id);
        saveScenes();
        openScenesManager();
      });

      row.appendChild(iconEl); row.appendChild(nameEl);
      row.appendChild(applyBtn); row.appendChild(delBtn);
      listSec.appendChild(row);
    });
    body.appendChild(listSec);
  }

  // ── New scene ──
  const newSec = document.createElement('div');
  newSec.className = 'settings-section';
  const nh = document.createElement('div');
  nh.className = 'settings-section-title'; nh.textContent = 'Save Current State as Scene';
  newSec.appendChild(nh);

  // Icon picker
  const iconLabel = document.createElement('div');
  iconLabel.style.cssText = 'font-size:10px;color:var(--text-dim);margin-bottom:4px;';
  iconLabel.textContent = 'Choose icon:';
  newSec.appendChild(iconLabel);

  let pickedIcon = SCENE_ICONS[0];
  const iconGrid = document.createElement('div');
  iconGrid.className = 'scene-icon-grid';
  SCENE_ICONS.forEach((emoji, i) => {
    const opt = document.createElement('button');
    opt.type = 'button'; opt.className = 'scene-icon-opt';
    opt.textContent = emoji;
    if (i === 0) opt.classList.add('picked');
    opt.addEventListener('click', () => {
      iconGrid.querySelectorAll('.scene-icon-opt').forEach(o => o.classList.remove('picked'));
      opt.classList.add('picked');
      pickedIcon = emoji;
    });
    iconGrid.appendChild(opt);
  });
  newSec.appendChild(iconGrid);

  // Name input + save button
  const addRow = document.createElement('div');
  addRow.className = 'settings-add-row';
  const nameIn = document.createElement('input');
  nameIn.type = 'text'; nameIn.placeholder = 'Scene name…';
  nameIn.className = 'settings-text-input';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'settings-add-btn'; saveBtn.textContent = '+ Save';
  saveBtn.addEventListener('click', () => {
    const name = nameIn.value.trim();
    if (!name) return;
    const st = captureScene();
    if (!st) return;
    scenes.push({ id: genId(), name, icon: pickedIcon, state: st });
    saveScenes();
    nameIn.value = '';
    openScenesManager();
  });
  addRow.appendChild(nameIn); addRow.appendChild(saveBtn);
  newSec.appendChild(addRow);
  body.appendChild(newSec);

  document.getElementById('scenes-overlay').classList.remove('hidden');
}

// ── Default sink switcher ────────────────────────────────────────────────────

function renderDefaultSinkSwitcher() {}

// ── Macros ──────────────────────────────────────────────────────────────────

const ACTION_TYPES = [
  ['scene',            'Recall scene'],
  ['default_sink',     'Set default output'],
  ['mute_sink',        'Toggle mute: output'],
  ['mute_source',      'Toggle mute: input'],
  ['move_app_to_sink', 'Move app to output'],
  ['media_play_pause', 'Media: Play / Pause'],
  ['media_next',       'Media: Next'],
  ['media_prev',       'Media: Previous'],
];

const macroToggleStates = new Map(); // id → boolean (runtime, not persisted)

function saveMacros() {
  send({ type: 'save_settings', macros });
}

function executeSingleAction(a) {
  switch (a.action) {
    case 'scene': {
      const sc = scenes.find(s => s.id === a.param);
      if (sc) applyScene(sc);
      break;
    }
    case 'default_sink':
      if (a.param) send({ type: 'set_default_sink', sink_name: a.param });
      break;
    case 'mute_sink': {
      const sink = lastState && lastState.sinks.find(s => s.name === a.param);
      if (sink) send({ type: 'set_mute', target: 'sink', index: sink.index, mute: !sink.mute });
      break;
    }
    case 'mute_source': {
      const src = lastState && lastState.sources.find(s => s.name === a.param);
      if (src) send({ type: 'set_mute', target: 'source', index: src.index, mute: !src.mute });
      break;
    }
    case 'move_app_to_sink': {
      if (!a.param || !a.param2 || !lastState) break;
      const si = lastState.sinkInputs.find(
        s => (s.appName || s.mediaName || '').toLowerCase() === a.param
      );
      const sink = lastState.sinks.find(s => s.name === a.param2);
      if (si && sink) send({ type: 'move_sink_input', index: si.index, sink: sink.index });
      break;
    }
    case 'media_play_pause':
      send({ type: 'media_cmd', action: 'play-pause', player: currentMediaPlayer }); break;
    case 'media_next':
      send({ type: 'media_cmd', action: 'next',       player: currentMediaPlayer }); break;
    case 'media_prev':
      send({ type: 'media_cmd', action: 'previous',   player: currentMediaPlayer }); break;
  }
}

function fireActions(actions, parallel) {
  if (!actions || !actions.length) return;
  if (parallel) {
    actions.forEach(a => executeSingleAction(a));
  } else {
    let cumDelay = 0;
    actions.forEach((a, i) => {
      setTimeout(() => executeSingleAction(a), cumDelay);
      if (i < actions.length - 1) cumDelay += (actions[i + 1].delay || 0);
    });
  }
}

function executeMacro(macro, phase) {
  // phase: 'on' | 'off'  (for momentary/toggle; defaults to 'on')
  const actions    = macro.actions    || (macro.action ? [{ action: macro.action, param: macro.param || '', delay: 0 }] : []);
  const offActions = macro.offActions || [];
  const list = (phase === 'off') ? offActions : actions;
  const par  = (phase === 'off') ? !!macro.offParallel : !!macro.parallel;
  fireActions(list, par);
}

let _editingMacroId = null;

function buildParamRow(actionObj) {
  const type = actionObj.action;
  const needsParam = ['scene', 'default_sink', 'mute_sink', 'mute_source', 'move_app_to_sink'].includes(type);
  if (!needsParam) return null;

  function makeRow(labelText, value, onChange, buildOptions) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const lbl = document.createElement('span');
    lbl.style.cssText = 'min-width:50px;font-size:10px;color:var(--text-dim);flex-shrink:0;';
    lbl.textContent = labelText;
    const sel = document.createElement('select');
    sel.className = 'settings-loop-sel'; sel.style.flex = '1';
    buildOptions(sel);
    sel.addEventListener('change', () => onChange(sel.value));
    if (!value && sel.options.length) onChange(sel.options[0].value);
    row.appendChild(lbl); row.appendChild(sel);
    return row;
  }

  if (type === 'move_app_to_sink') {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    wrap.appendChild(makeRow('App', actionObj.param, v => { actionObj.param = v; },
      sel => {
        const apps = lastState ? lastState.sinkInputs : [];
        if (!apps.length) {
          const o = document.createElement('option'); o.textContent = '(no apps active)'; sel.appendChild(o);
        }
        apps.forEach(si => {
          const appKey = (si.appName || si.mediaName || '').toLowerCase();
          const o = document.createElement('option');
          o.value = appKey;
          o.textContent = shortLabel(getAppName(appKey) || si.appName || si.mediaName || 'Stream', 24);
          o.selected = actionObj.param === appKey;
          sel.appendChild(o);
        });
      }
    ));
    wrap.appendChild(makeRow('Output', actionObj.param2, v => { actionObj.param2 = v; },
      sel => {
        (lastState ? lastState.sinks : []).forEach(s => {
          const o = document.createElement('option');
          o.value = s.name; o.textContent = shortLabel(sinkDisplayName(s), 24); o.selected = actionObj.param2 === s.name;
          sel.appendChild(o);
        });
      }
    ));
    return wrap;
  }

  const row = document.createElement('div');
  row.className = 'settings-row';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'min-width:50px;font-size:10px;color:var(--text-dim);flex-shrink:0;';
  lbl.textContent = type === 'scene' ? 'Scene' : type === 'mute_source' ? 'Input' : 'Output';
  const sel = document.createElement('select');
  sel.className = 'settings-loop-sel'; sel.style.flex = '1';

  if (type === 'scene') {
    if (!scenes.length) {
      const o = document.createElement('option'); o.textContent = '(no scenes saved)'; sel.appendChild(o);
    }
    scenes.forEach(sc => {
      const o = document.createElement('option');
      o.value = sc.id; o.textContent = sc.icon + ' ' + sc.name; o.selected = actionObj.param === sc.id;
      sel.appendChild(o);
    });
  } else if (type === 'default_sink' || type === 'mute_sink') {
    (lastState ? lastState.sinks : []).forEach(s => {
      const o = document.createElement('option');
      o.value = s.name; o.textContent = shortLabel(sinkDisplayName(s), 26); o.selected = actionObj.param === s.name;
      sel.appendChild(o);
    });
  } else if (type === 'mute_source') {
    (lastState ? lastState.sources : []).forEach(s => {
      const o = document.createElement('option');
      o.value = s.name; o.textContent = shortLabel(s.description || s.name, 26); o.selected = actionObj.param === s.name;
      sel.appendChild(o);
    });
  }

  sel.addEventListener('change', () => { actionObj.param = sel.value; });
  // Sync initial param if not yet set
  if (!actionObj.param && sel.options.length) actionObj.param = sel.options[0].value;

  row.appendChild(lbl); row.appendChild(sel);
  return row;
}

function openMacroCfg(macroId) {
  _editingMacroId = macroId;
  const macro = macros.find(m => m.id === macroId);
  if (!macro) return;

  const toArr = src => src ? src.map(a => ({ ...a }))
    : macro.action ? [{ action: macro.action, param: macro.param || '', delay: 0 }]
    : [{ action: 'scene', param: '', delay: 0 }];

  let editLabel      = macro.label || 'Macro';
  let editMode       = macro.mode || 'normal';
  let editColor      = macro.color || '#2a2a38';
  let editActions    = toArr(macro.actions);
  let editParallel   = !!macro.parallel;
  let editOffActions = (macro.offActions || []).map(a => ({ ...a }));
  let editOffPar     = !!macro.offParallel;

  function makeActionCards(list, isParallelRef, setParallel, onAddClick) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex'; wrap.style.flexDirection = 'column'; wrap.style.gap = '6px';

    // Parallel checkbox
    const parRow = document.createElement('div');
    parRow.className = 'settings-row';
    const parCb = document.createElement('input');
    parCb.type = 'checkbox'; parCb.checked = isParallelRef();
    parCb.addEventListener('change', () => { setParallel(parCb.checked); rebuildBody(); });
    const parLbl = document.createElement('span');
    parLbl.textContent = 'In parallel';
    parRow.appendChild(parCb); parRow.appendChild(parLbl);
    wrap.appendChild(parRow);

    list.forEach((actionObj, idx) => {
      const card = document.createElement('div');
      card.className = 'macro-action-card';

      const typeRow = document.createElement('div');
      typeRow.className = 'settings-row';
      const typeSel = document.createElement('select');
      typeSel.className = 'settings-loop-sel'; typeSel.style.flex = '1';
      ACTION_TYPES.forEach(([val, lbl]) => {
        const o = document.createElement('option');
        o.value = val; o.textContent = lbl; o.selected = actionObj.action === val;
        typeSel.appendChild(o);
      });
      typeSel.addEventListener('change', () => { actionObj.action = typeSel.value; actionObj.param = ''; rebuildBody(); });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button'; removeBtn.className = 'macro-del-btn'; removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => { list.splice(idx, 1); rebuildBody(); });
      typeRow.appendChild(typeSel); typeRow.appendChild(removeBtn);
      card.appendChild(typeRow);

      const pRow = buildParamRow(actionObj);
      if (pRow) card.appendChild(pRow);

      if (!isParallelRef() && idx > 0) {
        const delayRow = document.createElement('div');
        delayRow.className = 'settings-row';
        const delayLbl = document.createElement('span');
        delayLbl.style.cssText = 'min-width:50px;font-size:10px;color:var(--text-dim);flex-shrink:0;';
        delayLbl.textContent = 'Delay';
        const delayInp = document.createElement('input');
        delayInp.type = 'number'; delayInp.min = '0'; delayInp.max = '60000'; delayInp.step = '100';
        delayInp.value = actionObj.delay || 0;
        delayInp.style.cssText = 'width:64px;background:#1a1a22;border:1px solid var(--border);border-radius:4px;color:var(--text);padding:2px 4px;font-size:10px;';
        delayInp.addEventListener('input', () => { actionObj.delay = parseInt(delayInp.value) || 0; });
        const delayUnit = document.createElement('span');
        delayUnit.style.cssText = 'font-size:10px;color:var(--text-dim);margin-left:4px;';
        delayUnit.textContent = 'ms after previous';
        delayRow.appendChild(delayLbl); delayRow.appendChild(delayInp); delayRow.appendChild(delayUnit);
        card.appendChild(delayRow);
      }
      wrap.appendChild(card);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'settings-add-btn'; addBtn.textContent = '+ Add Action';
    addBtn.addEventListener('click', onAddClick);
    wrap.appendChild(addBtn);
    return wrap;
  }

  function makeSectionTitle(text) {
    const h = document.createElement('div');
    h.className = 'settings-section-title'; h.textContent = text;
    return h;
  }

  function rebuildBody() {
    const body = document.getElementById('macro-cfg-body');
    body.innerHTML = '';

    // ── Name ──
    const nameRow = document.createElement('div');
    nameRow.className = 'settings-row';
    const nameLbl = document.createElement('span');
    nameLbl.textContent = 'Name';
    nameLbl.style.cssText = 'min-width:50px;font-size:10px;color:var(--text-dim);flex-shrink:0;';
    const nameInp = document.createElement('input');
    nameInp.type = 'text'; nameInp.maxLength = 20; nameInp.value = editLabel;
    nameInp.style.cssText = 'flex:1;background:#1a1a22;border:1px solid var(--border);border-radius:4px;color:var(--text);padding:2px 6px;font-size:11px;font-family:var(--font);';
    nameInp.addEventListener('input', () => { editLabel = nameInp.value; });
    nameRow.appendChild(nameLbl); nameRow.appendChild(nameInp);
    body.appendChild(nameRow);

    // ── Mode ──
    const modeRow = document.createElement('div');
    modeRow.className = 'settings-row';
    const modeLbl = document.createElement('span');
    modeLbl.textContent = 'Mode';
    modeLbl.style.cssText = 'min-width:50px;font-size:10px;color:var(--text-dim);flex-shrink:0;';
    const modeSel = document.createElement('select');
    modeSel.className = 'settings-loop-sel'; modeSel.style.flex = '1';
    [['normal','Normal (click to fire)'],['momentary','Momentary (hold)'],['toggle','Toggle (on / off)']].forEach(([v,l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; o.selected = editMode === v;
      modeSel.appendChild(o);
    });
    modeSel.addEventListener('change', () => { editMode = modeSel.value; rebuildBody(); });
    modeRow.appendChild(modeLbl); modeRow.appendChild(modeSel);
    body.appendChild(modeRow);

    // ── Color ──
    const colorRow = document.createElement('div');
    colorRow.className = 'settings-row';
    const colorLbl = document.createElement('span');
    colorLbl.textContent = 'Color';
    colorLbl.style.cssText = 'min-width:50px;font-size:10px;color:var(--text-dim);flex-shrink:0;flex:1;';
    const colorPick = document.createElement('input');
    colorPick.type = 'color'; colorPick.value = editColor;
    colorPick.style.cssText = 'width:36px;height:22px;padding:0;border:none;cursor:pointer;background:none;border-radius:4px;';
    colorPick.addEventListener('input', () => { editColor = colorPick.value; });
    colorRow.appendChild(colorLbl); colorRow.appendChild(colorPick);
    body.appendChild(colorRow);

    // ── On-press / activate actions ──
    const onTitle = editMode === 'normal' ? 'ACTIONS' : editMode === 'toggle' ? 'ON ACTIVATE' : 'ON PRESS';
    body.appendChild(makeSectionTitle(onTitle));
    body.appendChild(makeActionCards(
      editActions,
      () => editParallel,
      v => { editParallel = v; },
      () => { editActions.push({ action: 'scene', param: '', delay: 0 }); rebuildBody(); }
    ));

    // ── Off-release / deactivate actions (momentary / toggle only) ──
    if (editMode === 'momentary' || editMode === 'toggle') {
      const offTitle = editMode === 'toggle' ? 'ON DEACTIVATE' : 'ON RELEASE';
      body.appendChild(makeSectionTitle(offTitle));
      body.appendChild(makeActionCards(
        editOffActions,
        () => editOffPar,
        v => { editOffPar = v; },
        () => { editOffActions.push({ action: 'scene', param: '', delay: 0 }); rebuildBody(); }
      ));
    }

    // ── Save / Delete ──
    const saveBtn = document.createElement('button');
    saveBtn.className = 'settings-add-btn'; saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const m = macros.find(m => m.id === _editingMacroId);
      if (!m) return;
      m.label = editLabel.trim() || 'Macro';
      m.mode = editMode; m.color = editColor;
      m.actions = editActions; m.parallel = editParallel;
      m.offActions = editOffActions; m.offParallel = editOffPar;
      delete m.action; delete m.param;
      saveMacros(); renderMacroGrid();
      document.getElementById('macro-cfg-overlay').classList.add('hidden');
    });
    body.appendChild(saveBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'settings-add-btn';
    delBtn.style.cssText = 'background:#3a1010;border-color:#6a2020;color:#ff6060;';
    delBtn.textContent = 'Delete macro';
    delBtn.addEventListener('click', () => {
      macros = macros.filter(m => m.id !== _editingMacroId);
      saveMacros(); renderMacroGrid();
      document.getElementById('macro-cfg-overlay').classList.add('hidden');
    });
    body.appendChild(delBtn);
  }

  rebuildBody();
  document.getElementById('macro-cfg-overlay').classList.remove('hidden');
}

function renderMacroGrid() {
  const grid = document.getElementById('macro-grid');
  if (!grid) return;
  grid.innerHTML = '';

  macros.forEach(macro => {
    const btn = document.createElement('div');
    btn.className = 'macro-btn';
    btn.dataset.id = macro.id;
    btn.style.setProperty('--macro-color', macro.color || '#2a2a38');
    const mode = macro.mode || 'normal';

    // Restore toggle active state
    if (mode === 'toggle' && macroToggleStates.get(macro.id)) btn.classList.add('active');

    // ── Upper area: label, execute on click/press ──
    const main = document.createElement('div');
    main.className = 'macro-btn-main';

    const lbl = document.createElement('div');
    lbl.className = 'macro-label';
    lbl.textContent = macro.label || 'Macro';
    main.appendChild(lbl);

    if (mode === 'momentary') {
      main.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        main.setPointerCapture(e.pointerId);
        btn.classList.add('active');
        executeMacro(macro, 'on');
      });
      main.addEventListener('pointerup',     () => { btn.classList.remove('active'); executeMacro(macro, 'off'); });
      main.addEventListener('pointercancel', () => { btn.classList.remove('active'); executeMacro(macro, 'off'); });
    } else if (mode === 'toggle') {
      main.addEventListener('click', () => {
        const isOn = macroToggleStates.get(macro.id) || false;
        macroToggleStates.set(macro.id, !isOn);
        btn.classList.toggle('active', !isOn);
        executeMacro(macro, isOn ? 'off' : 'on');
      });
    } else {
      main.addEventListener('click', () => {
        btn.classList.add('active');
        setTimeout(() => btn.classList.remove('active'), 150);
        executeMacro(macro, 'on');
      });
    }

    btn.appendChild(main);

    // ── Lower foot: click to open config ──
    const foot = document.createElement('div');
    foot.className = 'macro-btn-foot';
    const modeLabel = { normal: 'normal', momentary: 'hold', toggle: 'toggle' }[mode] || 'normal';
    foot.textContent = modeLabel;
    foot.addEventListener('click', (e) => { e.stopPropagation(); openMacroCfg(macro.id); });
    btn.appendChild(foot);

    grid.appendChild(btn);
  });
}

// ── App filter ──────────────────────────────────────────────────────────────

function applyAppFilter() {
  const q = appFilter.toLowerCase().trim();
  let visible = 0;
  document.querySelectorAll('.strip[data-type="sink-input"]').forEach(s => {
    const nameEl = s.querySelector('.app-name');
    const name = (nameEl ? nameEl.textContent : '').toLowerCase();
    const key  = (s.dataset.appkey || '').toLowerCase();
    const show = !q || name.includes(q) || key.includes(q);
    s.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  const empty = document.getElementById('empty-sinkinputs');
  if (empty) empty.style.display = (visible === 0) ? '' : 'none';
}

// ── State handler ───────────────────────────────────────────────────────────

function applyState(state) {
  const hidden = getHidden();
  currentSinks = state.sinks.filter(s => !hidden.has(s.name));  // shared by all dropdowns
  renderSection('strips-sources',    state.sources.filter(s => !hidden.has(s.name)), 'source',     null);
  renderSection('strips-sinkinputs', state.sinkInputs, 'sink-input', null);
  renderSection('strips-sinks',      currentSinks,                                   'sink',       null);
  fillSbSinkSel(currentSinks);
  applyAppFilter();
}

function onState(state) {
  if (!settingsApplied) {
    if (hasServerSettings(state.settings)) {
      applyServerSettings(state.settings);
    }
    settingsApplied = true;
    // Push current settings to server (migration from localStorage, or keep server in sync)
    sendSettings();
  }
  lastState    = state;
  defaultSink  = state.defaultSink || '';
  sourceRoutes = state.sourceRoutes || {};
  if (state.settings && state.settings.app_colors &&
      Object.keys(state.settings.app_colors).length > 0) {
    localStorage.setItem(APP_COLORS_KEY, JSON.stringify(state.settings.app_colors));
  }
  if (state.settings && Array.isArray(state.settings.scenes)) {
    const incoming = JSON.stringify(state.settings.scenes);
    if (incoming !== JSON.stringify(scenes)) {
      scenes = state.settings.scenes;
      renderSceneButtons();
    }
  }
  if (state.settings && Array.isArray(state.settings.macros)) {
    const incoming = JSON.stringify(state.settings.macros);
    if (incoming !== JSON.stringify(macros)) {
      macros = state.settings.macros;
      renderMacroGrid();
    }
  }
  applyState(state);
  renderDefaultSinkSwitcher(state.sinks);
  renderSoundboard(state.sounds);
  // Refresh settings modal only if open and user isn't typing inside it
  const overlay = document.getElementById('settings-overlay');
  if (!overlay.classList.contains('hidden') && !overlay.contains(document.activeElement)) {
    openSettings();
  }
}

// ── Vertical resize (inside media panel) ────────────────────────────────────

function initVResize(handle, topEl, storageKey) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = topEl.offsetHeight;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    function onMove(ev) {
      const newH = Math.max(80, Math.min(h0 + ev.clientY - y0,
                            topEl.parentElement.offsetHeight - 80));
      topEl.style.height = newH + 'px';
      topEl.style.flexShrink = '0';
    }
    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup',   onUp);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      if (storageKey) localStorage.setItem(storageKey, topEl.style.height);
      schedSendSettings();
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup',   onUp);
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────

// Media panel toggle
applyMediaVisibility();
document.getElementById('toggle-media').addEventListener('click', () => {
  mediaVisible = !mediaVisible;
  localStorage.setItem('pw-media-visible', mediaVisible);
  applyMediaVisibility();
  schedSendSettings();
});

// Zoom
applyZoom();
applyAccentColor(accentColor);
applyStripWidth(stripWidth);
document.getElementById('zoom-in') .addEventListener('click', () => adjustZoom(+ZOOM_STEP));
document.getElementById('zoom-out').addEventListener('click', () => adjustZoom(-ZOOM_STEP));

// Panel resize handles
initResize(document.getElementById('rh-left'),  document.getElementById('panel-inputs'),  true);
initResize(document.getElementById('rh-right'), document.getElementById('panel-outputs'), false);
initResize(document.getElementById('rh-media'), document.getElementById('panel-media'),   false);

// Restore saved panel widths
['panel-inputs', 'panel-outputs', 'panel-media'].forEach(id => {
  const w = localStorage.getItem('pw-panel-' + id);
  if (w) { const p = document.getElementById(id); p.style.width = w; p.style.flexShrink = '0'; }
});

// Vertical resize inside media panel
initVResize(document.getElementById('rh-media-v'), document.getElementById('media-top'), 'pw-media-top-h');
const savedMTH = localStorage.getItem('pw-media-top-h');
if (savedMTH) {
  const el = document.getElementById('media-top');
  el.style.height = savedMTH; el.style.flexShrink = '0';
}
initVResize(document.getElementById('rh-macro-v'), document.getElementById('media-bottom'), 'pw-soundboard-h');
const savedSBH = localStorage.getItem('pw-soundboard-h');
if (savedSBH) {
  const el = document.getElementById('media-bottom');
  el.style.height = savedSBH; el.style.flexShrink = '0';
}

// Macros
document.getElementById('macro-add').addEventListener('click', () => {
  macros.push({ id: genId(), label: 'Macro', color: '#2a2a38', action: 'scene', param: '' });
  saveMacros();
  renderMacroGrid();
});
document.getElementById('macro-cfg-close').addEventListener('click', () =>
  document.getElementById('macro-cfg-overlay').classList.add('hidden'));
document.getElementById('macro-cfg-overlay').addEventListener('click', e => {
  if (e.target.id === 'macro-cfg-overlay')
    document.getElementById('macro-cfg-overlay').classList.add('hidden');
});

// Scenes
document.getElementById('scenes-btn').addEventListener('click', openScenesManager);
document.getElementById('scenes-close').addEventListener('click', () =>
  document.getElementById('scenes-overlay').classList.add('hidden'));
document.getElementById('scenes-overlay').addEventListener('click', e => {
  if (e.target.id === 'scenes-overlay')
    document.getElementById('scenes-overlay').classList.add('hidden');
});

// Settings
document.getElementById('app-filter').addEventListener('input', (e) => {
  appFilter = e.target.value;
  applyAppFilter();
});

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', () =>
  document.getElementById('settings-overlay').classList.add('hidden'));
document.getElementById('settings-overlay').addEventListener('click', e => {
  if (e.target.id === 'settings-overlay')
    document.getElementById('settings-overlay').classList.add('hidden');
});

// Media controls — always target the currently displayed player by name
document.getElementById('mc-prev').addEventListener('click', () => send({ type: 'media_cmd', action: 'previous',   player: currentMediaPlayer }));
document.getElementById('mc-play').addEventListener('click', () => send({ type: 'media_cmd', action: 'play-pause', player: currentMediaPlayer }));
document.getElementById('mc-next').addEventListener('click', () => send({ type: 'media_cmd', action: 'next',       player: currentMediaPlayer }));

// Soundboard stop / rescan
document.getElementById('sb-stop').addEventListener('click', () => {
  document.querySelectorAll('.sb-btn.active').forEach(b => b.classList.remove('active'));
  send({ type: 'stop_sounds' });
});
document.getElementById('sb-rescan').addEventListener('click', () => send({ type: 'rescan_sounds' }));

// ── Mobile panel tabs ─────────────────────────────────────────────────────

function initMobilePanelTabs() {
  const tabBar = document.getElementById('panel-tabs');
  const main   = document.getElementById('main');
  if (!tabBar || !main) return;

  const panelDefs = [
    { id: 'panel-inputs',     label: 'INPUTS' },
    { id: 'panel-apps',       label: 'APPS'   },
    { id: 'panel-outputs',    label: 'OUTPUT' },
    { id: 'panel-media',      label: 'MEDIA'  },
  ];

  tabBar.innerHTML = '';
  const tabs = [];

  panelDefs.forEach(({ id, label }) => {
    const btn = document.createElement('button');
    btn.className = 'panel-tab';
    btn.textContent = label;
    btn.dataset.panel = id;
    btn.addEventListener('click', () => {
      const panel = document.getElementById(id);
      if (!panel || panel.classList.contains('collapsed')) return;
      panel.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
    });
    tabBar.appendChild(btn);
    tabs.push(btn);
  });

  function updateActiveTabs() {
    const mainRect = main.getBoundingClientRect();
    const cx = mainRect.left + mainRect.width / 2;
    tabs.forEach(btn => {
      const panel = document.getElementById(btn.dataset.panel);
      if (!panel || panel.classList.contains('collapsed')) {
        btn.style.display = 'none';
        return;
      }
      btn.style.display = '';
      const r = panel.getBoundingClientRect();
      btn.classList.toggle('active', r.left <= cx && r.right > cx);
    });
  }

  main.addEventListener('scroll', updateActiveTabs, { passive: true });
  updateActiveTabs();
}

initMobilePanelTabs();

// ── Drag-and-drop soundboard upload ──────────────────────────────────────

(function initDragDrop() {
  const target = document.getElementById('media-bottom');
  if (!target) return;

  let dragCounter = 0;

  target.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    target.classList.add('drag-over');
  });
  target.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; target.classList.remove('drag-over'); }
  });
  target.addEventListener('dragover', (e) => { e.preventDefault(); });
  target.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    target.classList.remove('drag-over');
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    const allowed = new Set(['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a']);
    const valid = files.filter(f => {
      const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
      return allowed.has(ext);
    });
    if (!valid.length) return;
    for (const file of valid) {
      const fd = new FormData();
      fd.append('file', file, file.name);
      await fetch('/upload-sound', { method: 'POST', body: fd });
    }
    send({ type: 'rescan_sounds' });
  });
})();

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === ' ') {
    e.preventDefault();
    send({ type: 'media_cmd', action: 'play-pause', player: currentMediaPlayer });
  }
});

// Connect
connect();
