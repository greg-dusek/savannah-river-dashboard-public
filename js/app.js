// Savannah River pilots dashboard: fetch live data in the browser and render.
// Conventions: speeds in knots; currents flood-positive (upriver), ebb-negative; times shown in US Eastern.

const KT_PER_MPH = 0.868976, KT_PER_FPS = 0.592484, KT_PER_MS = 1.943844, FT_PER_M = 3.28084;
const HOUR = 36e5;
const COOPS = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
// Caution and alert limits. Nothing is set by default: a limit only takes effect once a pilot enters it,
// and anything left blank is simply not shown. Values are stored in feet and knots.
// kind: 'spd' or 'len' (for unit conversion). dir: 'high' = at or above, 'low' = at or below.
const LIMITS = [
  { key: 'wind', label: 'Wind speed', kind: 'spd', dir: 'high', help: 'Sustained wind at or above this, observed or forecast.' },
  { key: 'current', label: 'Current speed', kind: 'spd', dir: 'high', help: 'Flood or ebb at or above this, observed, forecast or predicted, at places on the route (Tybee approach to Port Wentworth).' },
  { key: 'wlHigh', label: 'High water, Fort Pulaski', kind: 'len', dir: 'high', help: 'Water level at or above this (MLLW).' },
  { key: 'wlLow', label: 'Low water, Fort Pulaski', kind: 'len', dir: 'low', help: 'Water level at or below this (MLLW).' },
  { key: 'airGap', label: 'Air gap, Talmadge Bridge', kind: 'len', dir: 'low', help: 'Bridge clearance at or below this.' },
  { key: 'workable', label: 'Workable current', kind: 'spd', single: true, help: 'Not an alert. The current speed below which you consider a move workable. Used for the "under this speed until…" lines, the table of workable windows, and the "workable" note in hourly tables.' }
];

// offsetMin: minutes ahead of now that the page is showing (0 = live). mode: 'time' shows every place at
// that one time; 'transit' shows each place at the time a ship leaving then would reach it.
const state = { data: {}, nws: {}, nwsAlerts: [], failed: [], waves: null, selected: null, now: Date.now(), offsetMin: 0, mode: 'time', dir: 'in', speed: 10, units: 'english', hidden: new Set() };
let TH = { ...CONFIG.thresholds };
try { Object.assign(TH, JSON.parse(localStorage.getItem('sr-limits-v2') || '{}')); } catch (e) { /* storage unavailable */ }
try { if (localStorage.getItem('sr-units') === 'metric') state.units = 'metric'; } catch (e) { /* storage unavailable */ }
try { state.hidden = new Set(JSON.parse(localStorage.getItem('sr-hidden') || '[]')); } catch (e) { /* storage unavailable */ }
const store = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };

window.addEventListener('error', e => showError('Page error: ' + e.message));
window.addEventListener('unhandledrejection', e => showError('Page error: ' + (e.reason && e.reason.message || e.reason)));
function showError(msg) {
  const el = document.getElementById('err');
  el.hidden = false;
  el.textContent = msg;
}

// ---------- fetching ----------

async function getJSON(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

function coopsDate(ms) {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
const coopsTime = t => Date.parse(t.replace(' ', 'T') + ':00Z');

function coopsURL(station, product, t0, t1, extra) {
  const q = new URLSearchParams({
    station, product, begin_date: coopsDate(t0), end_date: coopsDate(t1),
    units: 'english', time_zone: 'gmt', format: 'json', application: 'river_dashboard', ...extra
  });
  return COOPS + '?' + q;
}

async function loadUSGS(d) {
  const sites = CONFIG.stations.filter(s => s.usgs).map(s => s.usgs).join(',');
  const j = await getJSON(`https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${sites}&parameterCd=00065,72255,00060,00035,00036&period=P2D`);
  for (const ts of j.value.timeSeries) {
    const site = ts.sourceInfo.siteCode[0].value, parm = ts.variable.variableCode[0].value;
    const nd = ts.variable.noDataValue;
    const vals = ts.values.reduce((a, b) => (b.value.length > a.value.length ? b : a)).value;
    d['usgs:' + site + ':' + parm] = vals.map(v => [Date.parse(v.dateTime), +v.value]).filter(p => p[1] !== nd && isFinite(p[1]));
  }
}

async function loadCoops(d, now) {
  const jobs = [];
  for (const s of CONFIG.stations) {
    if (s.coops) {
      jobs.push(getJSON(coopsURL(s.coops, 'water_level', now - 48 * HOUR, now, { datum: 'MLLW' }))
        .then(j => { d['wl:' + s.id] = (j.data || []).filter(r => r.v !== '').map(r => [coopsTime(r.t), +r.v]); }));
      jobs.push(getJSON(coopsURL(s.coops, 'predictions', now - 24 * HOUR, now + 36 * HOUR, { datum: 'MLLW' }))
        .then(j => { d['wlpred:' + s.id] = (j.predictions || []).map(r => [coopsTime(r.t), +r.v]); }));
    }
    if (s.coopsMet) {
      jobs.push(getJSON(coopsURL(s.coopsMet, 'wind', now - 48 * HOUR, now))
        .then(j => {
          const rows = (j.data || []).filter(r => r.s !== '');
          d['wind:' + s.id] = rows.map(r => [coopsTime(r.t), +r.s]);
          d['gust:' + s.id] = rows.filter(r => r.g !== '').map(r => [coopsTime(r.t), +r.g]);
          d['wdir:' + s.id] = rows.filter(r => r.d !== '').map(r => [coopsTime(r.t), +r.d]);
        }));
    }
    if (s.curPred) {
      jobs.push(getJSON(coopsURL(s.curPred.id, 'currents_predictions', now - 24 * HOUR, now + 36 * HOUR, { bin: s.curPred.bin, interval: 6 }))
        .then(j => { d['curpred:' + s.id] = ((j.current_predictions || {}).cp || []).map(r => [coopsTime(r.Time), +r.Velocity_Major]); }));
    }
  }
  for (const g of CONFIG.airGaps || []) {
    jobs.push(getJSON(coopsURL(g.coops, 'air_gap', now - 48 * HOUR, now))
      .then(j => { d['airgap:' + g.id] = (j.data || []).filter(r => r.v !== '').map(r => [coopsTime(r.t), +r.v]); }));
  }
  for (const p of CONFIG.currentPoints) {
    if (p.station) continue;
    const extra = p.type === 'H' ? { bin: p.bin, interval: 6 } : { interval: 'MAX_SLACK' };
    jobs.push(getJSON(coopsURL(p.id, 'currents_predictions', now - 24 * HOUR, now + 36 * HOUR, extra)).then(j => {
      const rows = ((j.current_predictions || {}).cp || []).map(r => [coopsTime(r.Time), +r.Velocity_Major, r.Type]);
      d['cp:' + p.id] = p.type === 'H' ? rows : curveFromEvents(rows);
    }));
  }
  const res = await Promise.allSettled(jobs);
  if (res.some(r => r.status === 'rejected')) throw new Error('some NOAA CO-OPS requests failed');
}

// Subordinate stations give only slack and maximum events. Draw a quarter-sine between each pair
// so they can be charted and compared like the harmonic stations. Returns a 6-minute series.
function curveFromEvents(ev) {
  const out = [];
  for (let i = 0; i < ev.length - 1; i++) {
    const [t0, v0, k0] = ev[i], [t1, v1, k1] = ev[i + 1];
    for (let t = Math.ceil(t0 / 36e4) * 36e4; t < t1; t += 36e4) {
      const f = (t - t0) / (t1 - t0);
      let v;
      if (k0 === 'slack' && k1 !== 'slack') v = v1 * Math.sin(f * Math.PI / 2);
      else if (k0 !== 'slack' && k1 === 'slack') v = v0 * Math.cos(f * Math.PI / 2);
      else v = v0 + (v1 - v0) * (1 - Math.cos(f * Math.PI)) / 2;
      out.push([t, v]);
    }
  }
  return out;
}

// Prediction series for a current point, wherever it was loaded.
const pointSeries = p => (p.station ? S('curpred', p.station) : S('cp', p.id));

// Next slack (sign change) and next maximum (turning point of speed) after time t0.
function nextEvents(series, t0) {
  const out = {};
  const pts = series.filter(q => q[0] >= t0 - 6 * 6e4);
  for (let i = 1; i < pts.length - 1 && !(out.slack && out.max); i++) {
    const a = pts[i - 1][1], b = pts[i][1], c = pts[i + 1][1];
    if (!out.slack && pts[i][0] > t0 && (a === 0 || a * b < 0 || b === 0)) out.slack = pts[i][0];
    if (!out.max && pts[i][0] > t0 && Math.abs(b) > 0.2 && Math.abs(b) >= Math.abs(a) && Math.abs(b) > Math.abs(c)) out.max = { t: pts[i][0], v: b };
  }
  return out;
}

async function loadBuoy(d) {
  const s = CONFIG.stations.find(x => x.buoy);
  if (!s) return;
  const vars = 'time,wind_speed,wind_from_direction,wind_speed_of_gust,sea_surface_wave_significant_height,sea_surface_wave_period_at_variance_spectral_density_maximum';
  const j = await getJSON(`https://erddap.sensors.ioos.us/erddap/tabledap/${s.buoy}.json?${vars}&time%3E=now-2days`);
  const rows = j.table.rows.map(r => [Date.parse(r[0]), ...r.slice(1)]).sort((a, b) => a[0] - b[0]);
  const col = (i, k) => rows.filter(r => r[i] != null).map(r => [r[0], r[i] * k]);
  d['wind:' + s.id] = col(1, KT_PER_MS);
  d['wdir:' + s.id] = col(2, 1);
  d['gust:' + s.id] = col(3, KT_PER_MS);
  d['wave:' + s.id] = col(4, FT_PER_M);
  d['wper:' + s.id] = col(5, 1);
}

// Wave forecast at a few places from the NWS nearshore wave model (data/waves.json, written by model/fetch_nwps.py).
// The file is metric; heights are turned into feet here.
async function loadWaves() {
  let j;
  try { j = await getJSON('data/waves.json?t=' + Math.floor(Date.now() / 3e5)); } catch (e) { state.waves = null; throw e; }
  const t = j.times.map(s => s * 1000);
  const ser = (a, k) => (a || []).map((v, i) => [t[i], v == null ? NaN : v * k]).filter(p => isFinite(p[1]));
  state.waves = {
    made: j.made * 1000, run: Date.parse(j.cycle.replace(' ', 'T')),
    by: Object.fromEntries(j.points.map(p => [p.id, { hs: ser(p.hs, FT_PER_M), tp: ser(p.tp, 1), dir: ser(p.dir, 1) }]))
  };
}
const waveFc = id => (state.waves && state.waves.by[id]) || null;
function waveAt(id, t) {
  const wf = waveFc(id), v = wf ? valueAt(wf.hs, t, 31) : null;
  return v == null ? null : { v, src: 'fcst', period: valueAt(wf.tp, t, 31), dir: valueAt(wf.dir, t, 31) };
}

async function loadNWS() {
  const jobs = Object.entries(CONFIG.nwsGrids).map(([k, grid]) =>
    getJSON(`https://api.weather.gov/gridpoints/${grid}/forecast/hourly`).then(j => {
      state.nws[k] = j.properties.periods.map(p => ({
        t: Date.parse(p.startTime),
        kt: Math.max(...(String(p.windSpeed).match(/\d+/g) || [0]).map(Number)) * KT_PER_MPH,
        dir: p.windDirection, text: p.shortForecast
      }));
    }));
  jobs.push(Promise.all(CONFIG.nwsAlertPoints.map(pt => getJSON('https://api.weather.gov/alerts/active?point=' + pt))).then(list => {
    const seen = new Map();
    for (const j of list) for (const f of j.features || []) seen.set(f.properties.id, f.properties);
    state.nwsAlerts = [...seen.values()];
  }));
  const res = await Promise.allSettled(jobs);
  if (res.some(r => r.status === 'rejected')) throw new Error('some NWS requests failed');
}

async function loadAll() {
  const now = Date.now(), d = {};
  document.getElementById('updated').innerHTML = '<span class="spin"></span>Loading…';
  const names = ['USGS', 'NOAA CO-OPS', 'buoy 41008', 'NWS forecast', 'channel forecast', 'wave forecast'];
  const res = await Promise.allSettled([loadUSGS(d), loadCoops(d, now), loadBuoy(d), loadNWS(), loadForecast(), loadWaves()]);
  state.failed = names.filter((n, i) => res[i].status === 'rejected');
  state.data = d;
  state.now = now;
  deriveSeries();
  render();
}

// Build the per-station series the UI reads, whatever the source.
// Harmonic prediction from one set of constants in tides.js: water level (feet above MLLW) or
// cross-section mean current (knots, flood positive).
function harmonic(T, z0, t0, t1, stepMs) {
  const out = [];
  if (!T || !T.f) return out;
  for (let t = Math.ceil(t0 / stepMs) * stepMs; t <= t1; t += stepMs) {
    const year = new Date(t).getUTCFullYear(), Y = T.years[year];
    if (!Y) continue;
    const hrs = (t - Date.UTC(year, 0, 1)) / 36e5;
    let h = z0;
    for (let k = 0; k < T.f.length; k++) h += Y.A[k] * Math.cos(2 * Math.PI * T.f[k] * hrs + Y.p[k]);
    out.push([t, h]);
  }
  return out;
}

function deriveSeries() {
  const d = state.data;
  const now = Date.now();
  for (const s of CONFIG.stations) {
    const T = typeof TIDES !== 'undefined' && TIDES[s.id];
    if (!T) continue;
    const a = now - 24 * HOUR, b = now + 36 * HOUR;
    if (!s.coops && T.f) d['wlpred:' + s.id] = harmonic(T, CONFIG.tideMean === 'recent' ? T.z0_recent : T.z0, a, b, 6 * 6e4);
    if (T.cur) d['curh:' + s.id] = harmonic(T.cur, T.cur.z0, a, b, 6 * 6e4);
  }
  for (const s of CONFIG.stations) {
    if (!s.usgs) continue;
    const u = p => d['usgs:' + s.usgs + ':' + p] || [];
    // gauges with a computed MLLW offset (config.js) are shifted from gauge zero to MLLW
    if (!s.coops && !s.flowOnly) d['wl:' + s.id] = s.mllw != null ? u('00065').map(p => [p[0], p[1] + s.mllw]) : u('00065');
    if (s.flowOnly) { d['flow:' + s.id] = u('00060'); d['stage:' + s.id] = u('00065'); }
    // USGS reports downstream (ebb) as positive; flip so flood is positive like NOAA predictions.
    d['cur:' + s.id] = u('72255').map(p => [p[0], -p[1] * KT_PER_FPS]);
    if (!s.coopsMet) {
      d['wind:' + s.id] = u('00035').map(p => [p[0], p[1] * KT_PER_MPH]);
      d['wdir:' + s.id] = u('00036');
    }
  }
}

// ---------- helpers ----------

const S = (key, id) => state.data[key + ':' + id] || [];
function latest(series) {
  if (!series.length) return null;
  const p = series[series.length - 1];
  return { t: p[0], v: p[1], stale: state.now - p[0] > CONFIG.staleMinutes * 6e4 };
}
function valueAt(series, t, tolMin) {
  const p = nearest(series, t);
  return p && Math.abs(p[0] - t) <= (tolMin || 20) * 6e4 ? p[1] : null;
}
const compass = deg => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
// How old a reading is, from its own timestamp. Counted from the clock, and kept current between data reloads.
const ageText = t => {
  const m = Math.max(0, Math.round((Date.now() - t) / 6e4));
  return m < 90 ? m + ' min ago' : (m / 60).toFixed(1) + ' h ago';
};
const ageSpan = t => `<span class="age" data-t="${t}">${ageText(t)}</span>`;
setInterval(() => document.querySelectorAll('.age[data-t]').forEach(e => { e.textContent = ageText(+e.dataset.t); }), 30000);

// Rising or falling at a gauge comes from the tide prediction, so a brief dip in the readings cannot flip it.
// Within CONFIG.steadyMinutes of predicted high or low water it is "steady".
function tideTrend(tide, t) {
  const w = (CONFIG.steadyMinutes || 20) * 6e4, pts = tide.filter(q => q[0] >= t - w - 12 * 6e4 && q[0] <= t + w + 12 * 6e4);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1][1], b = pts[i][1], c = pts[i + 1][1];
    if (((b >= a && b > c) || (b <= a && b < c)) && Math.abs(pts[i][0] - t) <= w) return 'steady';
  }
  const a = valueAt(tide, t - 6 * 6e4, 6), b = valueAt(tide, t + 6 * 6e4, 6);
  return a == null || b == null ? null : b > a ? 'rising' : 'falling';
}
// Status of a value against a caution/alert pair. Unset limits never trigger.
const lvHigh = (v, k) => v == null ? 'none' : TH[k + 'Alert'] != null && v >= TH[k + 'Alert'] ? 'alert-hi' : TH[k + 'Caution'] != null && v >= TH[k + 'Caution'] ? 'caution' : 'ok';
const lvLow = (v, k) => v == null ? 'none' : TH[k + 'Alert'] != null && v <= TH[k + 'Alert'] ? 'alert-hi' : TH[k + 'Caution'] != null && v <= TH[k + 'Caution'] ? 'caution' : 'ok';
const worst = (...ls) => ls.includes('alert-hi') ? 'alert-hi' : ls.includes('caution') ? 'caution' : ls.includes('ok') ? 'ok' : 'none';
const levelWord = { 'alert-hi': 'Alert', caution: 'Caution', stale: 'Stale' };
const wlLv = v => worst(lvHigh(v, 'wlHigh'), lvLow(v, 'wlLow'));
const curLv = v => lvHigh(v == null ? null : Math.abs(v), 'current');
// the current limit applies on the pilots' route only (not at the I-95 bridge)
const curLvAt = r => (r.nm != null ? curLv : () => 'ok');

// ---------- units: stored in feet and knots, shown in the chosen system ----------
const metric = () => state.units === 'metric';
const lenK = () => (metric() ? 0.3048 : 1), spdK = () => (metric() ? 0.514444 : 1), flowK = () => (metric() ? 0.0283168 : 1);
const lu = () => (metric() ? 'm' : 'ft'), su = () => (metric() ? 'm/s' : 'kt'), fu = () => (metric() ? 'm³/s' : 'cfs');
const fl = (ft, d) => (ft * lenK()).toFixed(d == null ? (metric() ? 2 : 1) : d);
const fs = kt => (kt * spdK()).toFixed(1);
const fw = kt => (metric() ? (kt * spdK()).toFixed(1) : kt.toFixed(0));
const conv = (points, k) => (k === 1 ? points : points.map(p => [p[0], p[1] * k]));

// ---------- places: one sea-to-upriver list of stations, prediction points and bridge air gaps ----------

const POINTS = Object.fromEntries(CONFIG.currentPoints.map(p => ['cp:' + p.id, p]));
const GAPS = Object.fromEntries((CONFIG.airGaps || []).map(g => ['gap:' + g.id, g]));
const ROWS = CONFIG.order.map(id => {
  if (POINTS[id]) { const p = POINTS[id]; return { id, kind: 'point', p, name: p.name, lat: p.lat, lon: p.lon }; }
  if (GAPS[id]) { const g = GAPS[id]; return { id, kind: 'gap', g, name: g.name, lat: g.lat, lon: g.lon }; }
  const s = CONFIG.stations.find(x => x.id === id);
  return { id, kind: 'station', s, name: s.name, lat: s.lat, lon: s.lon };
});

// Approximate channel distance (nm) from the seaward end of the route, chaining straight lines between places.
(function measureRoute() {
  const nm = (a, b) => {
    const R = 3440.065, r = Math.PI / 180, dla = (b.lat - a.lat) * r, dlo = (b.lon - a.lon) * r;
    const h = Math.sin(dla / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const i0 = ROWS.findIndex(r => r.id === CONFIG.route.from), i1 = ROWS.findIndex(r => r.id === CONFIG.route.to);
  let d = 0;
  for (let i = i0; i <= i1; i++) { if (i > i0) d += nm(ROWS[i - 1], ROWS[i]); ROWS[i].nm = d; }
  CONFIG.route.length = d;
})();

// A link such as index.html#elba opens with that place's drawer open.
if (ROWS.some(r => r.id === decodeURIComponent(location.hash.slice(1)))) state.selected = decodeURIComponent(location.hash.slice(1));

// Links can also carry the view: ?t=180 (minutes ahead), ?mode=transit, ?dir=out, ?speed=8, ?units=metric
(function readQuery() {
  const q = new URLSearchParams(location.search);
  const t = parseInt(q.get('t'), 10), v = parseFloat(q.get('speed'));
  if (t >= 0 && t <= 2160) state.offsetMin = t;
  if (q.get('mode') === 'transit') state.mode = 'transit';
  if (q.get('dir') === 'out') state.dir = 'out';
  if (v >= 1 && v <= 30) state.speed = v;
  if (q.get('units') === 'metric' || q.get('units') === 'english') state.units = q.get('units');
  // ?limits=windCaution:20,windAlert:25,workable:1 presets limits (feet and knots) for this visit
  for (const pair of (q.get('limits') || '').split(',')) {
    const [k, v] = pair.split(':');
    if (k in TH && isFinite(parseFloat(v))) TH[k] = parseFloat(v);
  }
})();

// ---------- time ----------

const viewTime = () => state.now + state.offsetMin * 6e4;
const isLive = t => Math.abs(t - state.now) < 6e4;
// The time a row is showing: the chosen time, or in transit mode the time the ship reaches that place.
function rowTime(r) {
  const t = state.mode === 'transit' ? trTimeAt(r.nm) : null;
  return t == null ? viewTime() : t;
}

// ---------- transit: from one place to another, leaving at the time shown ----------
// Places are measured in nm from the Tybee approach along the route (r.nm). Either end can be a listed place
// ({id}) or any point on the channel forecast line ({km} from the sea entrance). The arrival is fixed either by
// a speed (the arrival time follows) or by an arrival time (the speed follows).
state.tr = { from: { id: CONFIG.route.from }, to: { id: CONFIG.route.to }, fix: 'speed', arrive: null, pick: null };
if (state.dir === 'out') [state.tr.from, state.tr.to] = [state.tr.to, state.tr.from];
let routeBase = null;   // nm from the Tybee approach to the seaward end of the channel line
const nmBetween = (a, b) => Math.hypot((a.lat - b.lat) * 60, (a.lon - b.lon) * 60 * Math.cos(32.05 * Math.PI / 180));
// Once the channel forecast is loaded, places on the route take their distance from the channel line, so listed
// places and points picked on the line share one scale. Before that the straight-line chain above is used.
function placeRoute() {
  if (!chan.fc || chan.fc.placed) return;
  const P = chan.fc.points, a = ROWS.find(r => r.id === CONFIG.route.from);
  routeBase = nmBetween(a, P[0]) + P[0].km / 1.852;
  for (const r of ROWS) {
    if (r.nm == null || r === a) continue;
    let best = P[0], bd = 1e9;
    for (const p of P) { const d = nmBetween(r, p); if (d < bd) { bd = d; best = p; } }
    r.nm = routeBase + best.km / 1.852;
    r.cp = best;   // the place on the channel line nearest this one
  }
  CONFIG.route.length = ROWS.find(r => r.id === CONFIG.route.to).nm;
  chan.fc.placed = true;
}
const kmPos = km => (routeBase == null ? null : routeBase + km / 1.852);
const trPos = e => (e.id ? ROWS.find(r => r.id === e.id).nm : kmPos(e.km));
const trName = e => (e.id ? ROWS.find(r => r.id === e.id).name : `Channel, ${(e.km / 1.852).toFixed(1)} nm from the sea entrance`);
const trDist = () => { const a = trPos(state.tr.from), b = trPos(state.tr.to); return a == null || b == null ? 0 : Math.abs(b - a); };
const trIn = () => trPos(state.tr.to) >= trPos(state.tr.from);   // heading upriver
function trSpeed() {
  if (state.tr.fix !== 'time' || state.tr.arrive == null) return state.speed;
  const h = (state.tr.arrive - viewTime()) / HOUR;
  return h > 0 && trDist() > 0 ? trDist() / h : null;
}
// When the ship passes a place at `pos` nm; null if the place is not on the leg.
function trTimeAt(pos) {
  const a = trPos(state.tr.from), b = trPos(state.tr.to), sp = trSpeed();
  if (pos == null || a == null || b == null || !sp || a === b || pos < Math.min(a, b) - 0.06 || pos > Math.max(a, b) + 0.06) return null;
  return viewTime() + Math.abs(pos - a) / sp * HOUR;
}
const onLeg = r => state.mode === 'transit' && trTimeAt(r.nm) != null;
function setTransitEnd(end, e) {
  state.tr[end] = e;
  state.tr.pick = null;
  renderView();
}

function fillSelect(el, sig, opts, value) {
  if (el.dataset.sig !== sig) {
    el.innerHTML = '';
    for (const [v, label] of opts()) { const o = document.createElement('option'); o.value = v; o.textContent = label; el.appendChild(o); }
    el.dataset.sig = sig;
  }
  el.value = value;
}
function renderTransitLine() {
  const tr = state.tr, dep = viewTime(), dist = trDist();
  const key = e => (e.id ? 'id:' + e.id : 'km:' + e.km);
  const places = () => ROWS.filter(r => r.nm != null && r.kind !== 'gap').map(r => ['id:' + r.id, r.name]);
  for (const end of ['from', 'to']) {
    const e = tr[end];
    fillSelect(document.getElementById('tr' + end), key(e) + state.units, () => places().concat(e.id ? [] : [[key(e), trName(e)]]), key(e));
  }
  fillSelect(document.getElementById('trdep'), String(state.now), () => Array.from({ length: 145 }, (_, k) => [k * 15, k === 0 ? 'now, ' + fmtTime.format(state.now) : fmtDayTime.format(state.now + k * 15 * 6e4)]), String(state.offsetMin));
  // an arrival time at or before the departure is replaced by the one the last speed gives
  if (tr.fix === 'time' && (tr.arrive == null || tr.arrive <= dep) && dist > 0) tr.arrive = dep + Math.ceil(dist / state.speed * 12) * 5 * 6e4;
  const byTime = tr.fix === 'time';
  document.getElementById('trfix').value = tr.fix;
  document.getElementById('trspdbox').hidden = byTime;
  const arr = document.getElementById('trarr');
  arr.hidden = !byTime;
  if (byTime) {
    const opts = () => {
      const out = [];
      for (let k = 1; k <= 144; k++) out.push([dep + k * 5 * 6e4, fmtDayTime.format(dep + k * 5 * 6e4)]);
      if (tr.arrive > dep + 144 * 5 * 6e4) out.push([tr.arrive, fmtDayTime.format(tr.arrive)]);
      return out;
    };
    // snap the arrival to the 5-minute list
    if (tr.arrive <= dep + 144 * 5 * 6e4) tr.arrive = dep + Math.max(1, Math.round((tr.arrive - dep) / (5 * 6e4))) * 5 * 6e4;
    fillSelect(arr, dep + ':' + (tr.arrive > dep + 144 * 5 * 6e4 ? tr.arrive : ''), opts, String(tr.arrive));
  }
  const sp = trSpeed(), out = document.getElementById('trout');
  if (!dist) out.textContent = 'Choose two different places.';
  else if (byTime) out.textContent = `· ${sp.toFixed(1)} kt over ${dist.toFixed(1)} nm` + (sp > 25 || sp < 2 ? ' (check the times)' : '');
  else out.textContent = `· arrive ${fmtDayTime.format(dep + dist / sp * HOUR)} ${tzAbbr(dep)} · ${dist.toFixed(1)} nm`;
  document.querySelectorAll('.pick').forEach(b => b.classList.toggle('on', tr.pick === b.dataset.end));
  document.getElementById('trhint').hidden = !tr.pick;
  document.body.classList.toggle('picking', !!tr.pick && state.mode === 'transit');
}
// Transit on the map and in the headings: a banner, the leg drawn heavier on the channel line, and Start and End pins.
let trLayer = null;
function trLatLng(e) {
  if (e.id) { const r = ROWS.find(x => x.id === e.id), p = r.cp || r; return [p.lat, p.lon]; }
  const P = chan.fc.points; let best = P[0];
  for (const p of P) if (Math.abs(p.km - e.km) < Math.abs(best.km - e.km)) best = p;
  return [best.lat, best.lon];
}
function renderTransitMap() {
  const on = state.mode === 'transit', tr = state.tr, dist = trDist();
  const ban = document.getElementById('trbanner');
  ban.hidden = !on;
  document.getElementById('trbadge').hidden = !on;
  if (on) ban.innerHTML = `<b>Transit mode</b> ${dist ? `${trName(tr.from)} → ${trName(tr.to)} · ${dist.toFixed(1)} nm` : 'choose a start and a destination'}`;
  if (!window.L || !map) return;
  if (trLayer) { trLayer.remove(); trLayer = null; }
  if (chan.line) chan.line.setStyle({ opacity: on ? 0.25 : 0.6 });
  if (!on || !dist || (!chan.fc && !(tr.from.id && tr.to.id))) return;
  trLayer = L.layerGroup().addTo(map);
  const A = trLatLng(tr.from), B = trLatLng(tr.to);
  if (chan.fc && routeBase != null) {
    const ka = (trPos(tr.from) - routeBase) * 1.852, kb = (trPos(tr.to) - routeBase) * 1.852, lo = Math.min(ka, kb), hi = Math.max(ka, kb);
    const mid = chan.fc.points.filter(p => p.km > lo + 0.01 && p.km < hi - 0.01).map(p => [p.lat, p.lon]);
    L.polyline([ka <= kb ? A : B, ...mid, ka <= kb ? B : A], { color: CHAN_COLOR, weight: 9, opacity: 1, interactive: false }).addTo(trLayer);
    if (chan.dot) chan.dot.bringToFront();
  }
  for (const [ll, label] of [[A, 'Start'], [B, 'End']]) {
    L.circleMarker(ll, { radius: 6, color: '#0b0b0b', weight: 3, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(trLayer);
    L.marker(ll, { interactive: false, keyboard: false, zIndexOffset: 1200, icon: L.divIcon({ className: '', html: `<div class="trpin">${label}</div>`, iconSize: [0, 0] }) }).addTo(trLayer);
  }
}
const clock = t => (Math.abs(t - state.now) < 16 * HOUR ? fmtTime : fmtDayTime).format(t);
function whenText(t, ref) {
  const m = Math.round((t - ref) / 6e4);
  if (isLive(ref) && m < 360) return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  return 'at ' + clock(t);
}

// ---------- reading the data at a time ----------

// A station's one tidal current prediction (see stationCurrentPrediction in config.js): by default the harmonic
// prediction of the USGS cross-section mean where the gauge measures velocity, otherwise NOAA's channel prediction.
function stationPred(id) {
  const sec = S('curh', id), noaa = S('curpred', id);
  return CONFIG.stationCurrentPrediction === 'noaa' ? (noaa.length ? noaa : sec) : (sec.length ? sec : noaa);
}
const predIsSection = id => S('curh', id).length > 0 && stationPred(id) === S('curh', id);
const predSeries = r => (r.kind === 'point' ? pointSeries(r.p) : r.kind === 'gap' ? [] : stationPred(r.s.id));

// Is the predicted current under the workable limit at t, and when does that next change?
// With a live reading (obsV) the reading decides whether it is under the limit now; if the series disagrees with the
// reading at this moment there is no honest time to give, so nothing is shown.
function windowInfo(series, t, obsV) {
  if (TH.workable == null) return null;
  const pts = series.filter(q => q[0] >= t - 3 * 6e4);
  if (!pts.length) return null;
  const under = Math.abs(obsV == null ? pts[0][1] : obsV) < TH.workable;
  const flip = pts.find(q => (Math.abs(q[1]) < TH.workable) !== under);
  if (obsV != null && flip && flip[0] - t < 12 * 6e4) return null;
  return { under, t: flip ? flip[0] : null };
}

// Next high or low water in a tide prediction series after t.
function nextTurn(series, t) {
  const pts = series.filter(q => q[0] >= t - 6 * 6e4);
  for (let i = 1; i < pts.length - 1; i++) {
    if (pts[i][0] <= t) continue;
    const a = pts[i - 1][1], b = pts[i][1], c = pts[i + 1][1];
    if (b >= a && b > c) return { type: 'High', t: pts[i][0], v: b };
    if (b <= a && b < c) return { type: 'Low', t: pts[i][0], v: b };
  }
  return null;
}

function windForecast(grid, t) {
  const fc = state.nws[grid] || [];
  let best = null;
  for (const p of fc) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best && Math.abs(best.t - t) <= 60 * 6e4 ? best : null;
}
function windPeak(grid, t, hours) {
  return (state.nws[grid] || []).filter(p => p.t > t && p.t <= t + hours * HOUR)
    .reduce((a, b) => (b.kt > (a ? a.kt : -1) ? b : a), null);
}

// Everything a row, marker or alert needs to know about one place at time t.
function summarize(r, t) {
  const live = isLive(t), out = { t, live };

  // a bridge air gap: the latest reading whatever time is shown, since there is no air gap forecast
  if (r.kind === 'gap') {
    const gap = latest(S('airgap', r.g.id));
    if (gap) out.gap = { ...gap, level: gap.stale ? 'stale' : lvLow(gap.v, 'airGap') };
    out.level = out.gap ? out.gap.level : 'none';
    return out;
  }

  // current
  const pser = predSeries(r), pred = valueAt(pser, t, 10);
  const obs = live && r.kind === 'station' ? latest(S('cur', r.s.id)) : null;
  // the experimental forecast at this gauge, used for times ahead while it is current
  const gf = r.kind === 'station' && fcFresh() ? gaugeForecast(r.s) : null;
  const fcur = gf && !live ? interpAt(gf.cur, t) : null;
  if (obs) out.cur = { v: obs.v, src: 'obs', stale: obs.stale, t: obs.t, pred: valueAt(S('curh', r.s.id).length ? S('curh', r.s.id) : pser, obs.t, 10), level: obs.stale ? 'stale' : curLvAt(r)(obs.v) };
  else if (fcur != null) out.cur = { v: fcur, src: 'fcst', half: halfBand(gf.curLo, gf.curHi, t), level: curLvAt(r)(fcur) };
  else if (pred != null) out.cur = { v: pred, src: 'pred', level: curLvAt(r)(pred) };
  if (out.cur && pser.length) { Object.assign(out.cur, nextEvents(pser, t)); out.cur.win = windowInfo(pser, t, obs && !obs.stale ? obs.v : null); }
  // next slack and the workable window come from the forecast where it reaches
  if (out.cur && gf && gf.curFine.length) {
    const sl = chanSlack(gf.cur, t), win = windowInfo(aheadSeries(gf.curFine, pser), t, obs && !obs.stale ? obs.v : null);
    if (sl) out.cur.slack = sl;
    out.cur.win = win;
  }
  if (r.kind === 'point') {
    const wv = waveAt(r.id, t);
    if (wv) out.wave = wv;
    out.level = out.cur ? out.cur.level : 'none';
    return out;
  }

  const s = r.s;
  // water level
  const wlNow = latest(S('wl', s.id)), tide = S('wlpred', s.id);
  // how far the water is running above or below the tide prediction right now
  const anomaly = wlNow && !wlNow.stale && tide.length ? (p => (p == null ? null : wlNow.v - p))(valueAt(tide, wlNow.t, 10)) : null;
  const datum = s.coops || s.mllw != null ? 'MLLW' : 'NAVD88';
  const lv = v => (s.coops ? wlLv(v) : 'ok');
  // next high or low water: from the forecast where there is one, otherwise from the tide prediction
  const fturn = gf && gf.wlAll.length ? chanTurn(gf.wlAll, t) : null;
  const next = fturn ? { ...fturn, fc: true } : nextTurn(tide, t);
  const fwl = gf && !live ? interpAt(gf.wlAll, t) : null;
  if (live && wlNow) {
    // where there is no tide prediction (I-95) the readings themselves are used
    const before = valueAt(S('wl', s.id), wlNow.t - 30 * 6e4, 12);
    const trend = tideTrend(tide, t) || (before == null ? '' : wlNow.v - before > 0.05 ? 'rising' : wlNow.v - before < -0.05 ? 'falling' : 'steady');
    out.wl = { v: wlNow.v, src: 'obs', stale: wlNow.stale, t: wlNow.t, trend, datum, anomaly, next, level: wlNow.stale ? 'stale' : lv(wlNow.v) };
  } else if (fwl != null) {
    out.wl = { v: fwl, src: 'fcst', half: halfBand(gf.wlLo, gf.wlHi, t), tide: valueAt(tide, t, 10), datum, next, level: lv(fwl) };
  } else if (!live && tide.length) {
    const p = valueAt(tide, t, 10);
    if (p != null) out.wl = { v: p, src: 'pred', datum, anomaly, next, level: lv(p) };
  } else if (!live && !s.flowOnly && !s.buoy) out.wl = { src: 'none' };

  // wind
  const w = live ? latest(S('wind', s.id)) : null;
  if (w) {
    const dir = valueAt(S('wdir', s.id), w.t, 20), gust = valueAt(S('gust', s.id), w.t, 20);
    out.wind = { v: w.v, src: 'obs', stale: w.stale, t: w.t, dir: dir == null ? '' : compass(dir), gust, peak: windPeak(s.nws, t, 12), level: w.stale ? 'stale' : lvHigh(w.v, 'wind') };
  } else if (!live) {
    const f = windForecast(s.nws, t);
    if (f) out.wind = { v: f.kt, src: 'fcst', dir: f.dir, level: lvHigh(f.kt, 'wind') };
  }

  if (live) {
    const flow = latest(S('flow', s.id));
    if (flow) out.flow = flow;
    const wave = latest(S('wave', s.id));
    if (wave) out.wave = { ...wave, src: 'obs', period: valueAt(S('wper', s.id), wave.t, 30) };
  }
  // no wave observation for this time: use the wave model forecast where there is one
  if (!out.wave) { const wv = waveAt(r.id, t); if (wv) out.wave = wv; }
  const parts = [out.wl, out.cur, out.wind].filter(x => x && x.level);
  out.level = worst(...parts.map(x => x.level));
  const main = [out.wl, out.cur, out.wind].filter(x => x && x.level);
  if (main.length && main.every(x => x.level === 'stale')) out.level = 'stale';
  return out;
}

const curWord = v => (Math.abs(v) < 0.2 ? 'slack' : v > 0 ? 'flood' : 'ebb');
const curText = v => `${fs(Math.abs(v))} <small>${su()} ${curWord(v)}</small>`;
const signed = (v, txt) => (v >= 0 ? '+' : '−') + txt;
const anyLimit = () => Object.keys(TH).some(k => k !== 'workable' && TH[k] != null);

// ---------- rendering ----------

function render() {
  const up = document.getElementById('updated');
  up.textContent = 'Data updated ' + fmtTime.format(state.now) + ' ' + tzAbbr(state.now) + (state.failed.length ? ' · unavailable: ' + state.failed.join(', ') : '');
  document.querySelectorAll('#unitseg button').forEach(b => b.classList.toggle('on', b.dataset.units === state.units));
  renderAlerts();
  renderView();
}

// Everything that depends on the chosen time, the units or the open drawer.
function renderView() {
  placeRoute();
  renderTimebar();
  const sums = ROWS.map(r => summarize(r, rowTime(r)));
  renderRows(sums);
  renderMap(sums);
  renderChannel();
  renderTransitMap();
}

function renderAlerts() {
  const items = [];
  for (const a of state.nwsAlerts) {
    items.push({ l: /Warning/.test(a.event) ? 'alert-hi' : 'caution', label: 'NWS', text: `${a.event}. ${a.headline || ''}` });
  }
  for (const r of ROWS.filter(x => x.kind === 'station')) {
    const u = summarize(r, state.now), hit = x => x && (x.level === 'caution' || x.level === 'alert-hi');
    if (hit(u.wind)) items.push({ l: u.wind.level, label: r.name, text: `Wind ${fw(u.wind.v)} ${su()}${u.wind.dir ? ' from ' + u.wind.dir : ''}${u.wind.gust ? ', gusts ' + fw(u.wind.gust) : ''}.` });
    if (hit(u.cur)) items.push({ l: u.cur.level, label: r.name, text: `${u.cur.src === 'obs' ? 'Observed' : u.cur.src === 'fcst' ? 'Forecast' : 'Predicted'} current ${fs(Math.abs(u.cur.v))} ${su()} ${curWord(u.cur.v)}.` });
    if (hit(u.wl)) items.push({ l: u.wl.level, label: r.name, text: `Water level ${fl(u.wl.v)} ${lu()} ${u.wl.datum}.` });
  }
  for (const r of ROWS.filter(x => x.kind === 'gap')) {
    const u = summarize(r, state.now);
    if (u.gap && (u.gap.level === 'caution' || u.gap.level === 'alert-hi')) items.push({ l: u.gap.level, label: r.g.label, text: `Air gap ${fl(u.gap.v)} ${lu()}.` });
  }
  // water level limits against the forecast for the next 24 hours (the tide-only prediction if there is no forecast)
  for (const r of ROWS.filter(x => x.kind === 'station' && x.s.coops)) {
    const gf = fcFresh() ? gaugeForecast(r.s) : null, isFc = !!(gf && gf.wlFine.length);
    const pts = aheadSeries(gf && gf.wlFine, S('wlpred', r.s.id)).filter(q => q[0] > state.now && q[0] <= state.now + 24 * HOUR);
    if (!pts.length) continue;
    const hi = pts.reduce((a, b) => (b[1] > a[1] ? b : a)), lo = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
    const word = isFc ? 'forecast' : 'predicted (tide only)';
    for (const [q, l, verb] of [[hi, lvHigh(hi[1], 'wlHigh'), 'reach'], [lo, lvLow(lo[1], 'wlLow'), 'fall to']]) {
      if (l === 'caution' || l === 'alert-hi')
        items.push({ l, label: r.name + (isFc ? ' forecast' : ' prediction'), text: `Water level ${word} to ${verb} ${fl(q[1])} ${lu()} MLLW around ${fmtDayTime.format(q[0])}.` });
    }
  }
  for (const [k, name] of [['river', 'River'], ['entrance', 'Entrance']]) {
    const peak = windPeak(k, state.now, 24), l = peak ? lvHigh(peak.kt, 'wind') : 'ok';
    if (l === 'caution' || l === 'alert-hi')
      items.push({ l, label: name + ' forecast', text: `Wind forecast to reach ${fw(peak.kt)} ${su()} from ${peak.dir} around ${fmtDayTime.format(peak.t)}.` });
  }
  const el = document.getElementById('alerts');
  el.innerHTML = '';
  items.sort((a, b) => (a.l === 'alert-hi' ? 0 : 1) - (b.l === 'alert-hi' ? 0 : 1));
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'alert ' + it.l;
    const b = document.createElement('b');
    b.textContent = (it.l === 'alert-hi' ? '● Alert · ' : '▲ Caution · ') + it.label;
    const sp = document.createElement('span');
    sp.textContent = it.text;
    div.append(b, sp);
    el.appendChild(div);
  }
  if (!anyLimit()) {
    const div = document.createElement('div');
    div.className = 'alert info';
    div.innerHTML = '<b>No limits set</b><span>Cautions and alerts are off until you enter your own limits.</span>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Set limits';
    btn.addEventListener('click', () => {
      const d = document.getElementById('settings');
      d.open = true;
      d.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    div.appendChild(btn);
    el.appendChild(div);
  }
}

function renderTimebar() {
  const t = viewTime(), transit = state.mode === 'transit';
  document.querySelectorAll('#modeseg button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
  document.getElementById('trline').hidden = !transit;
  document.getElementById('tlabel').hidden = transit;
  if (transit) renderTransitLine();
  document.getElementById('nowbtn').disabled = state.offsetMin === 0;
  document.getElementById('tslider').value = state.offsetMin;
  const stamp = state.offsetMin === 0 ? 'now, ' + fmtTime.format(t) + ' ' + tzAbbr(t) : fmtDayTime.format(t) + ' ' + tzAbbr(t) + ` (+${Math.floor(state.offsetMin / 60)} h ${String(state.offsetMin % 60).padStart(2, '0')})`;
  document.getElementById('tlabel').textContent = 'Showing ' + stamp;
  // headline: how the river is running against the tide tables right now
  const p = summarize(ROWS.find(r => r.id === 'pulaski'), state.now);
  document.getElementById('anomaly').textContent = p.wl && p.wl.anomaly != null
    ? `Fort Pulaski now: water ${fl(Math.abs(p.wl.anomaly))} ${lu()} ${p.wl.anomaly >= 0 ? 'above' : 'below'} predicted` : '';
}

// One measurement inside a row. Stale readings are faded in a shaded box; readings past a caution or
// alert limit get a thick outline plus the word, so the status never relies on color alone.
function tile(label, val, subs, lv, staleAt) {
  const lines = (subs || []).filter(Boolean).map(x => `<div class="tsub">${x}</div>`).join('');
  const flag = lv === 'caution' ? '<div class="tflag">▲ Caution</div>' : lv === 'alert-hi' ? '<div class="tflag">● Alert</div>'
    : lv === 'stale' ? `<div class="tflag">Stale${staleAt ? ' · ' + ageSpan(staleAt) : ''}</div>` : '';
  const age = staleAt && lv !== 'stale' ? `<div class="tsub tage">${ageSpan(staleAt)}</div>` : '';
  const cls = lv === 'caution' || lv === 'alert-hi' || lv === 'stale' ? ' lv-' + lv : '';
  return `<div class="tile${cls}"><div class="tlabel">${label}</div><div class="tval">${val}</div>${lines}${flag}${age}</div>`;
}
const emptyTile = '<div class="tile empty"></div>';

function currentTile(r, u) {
  const c = u.cur;
  if (!c) return tile('Current', u.live && r.kind === 'station' ? '<small>not measured</small>' : '<small>no prediction</small>');
  const subs = [];
  if (c.src === 'obs' && c.pred != null) {
    const same = Math.sign(c.v) === Math.sign(c.pred) || Math.abs(c.pred) < 0.2 || Math.abs(c.v) < 0.2;
    const d = Math.abs(c.v) - Math.abs(c.pred);
    subs.push(same ? (fs(Math.abs(d)) === '0.0' ? 'as predicted' : `${signed(d, fs(Math.abs(d)))} ${su()} vs predicted`) : `predicted ${fs(Math.abs(c.pred))} ${su()} ${curWord(c.pred)}`);
  }
  if (onLeg(r) && Math.abs(c.v) >= 0.2) subs.push(((c.v > 0) === trIn()) ? 'with you' : 'against you');
  if (c.src === 'fcst' && c.half != null && c.half > 0.005) subs.push(`± ${fs(c.half)} ${su()} (95%)`);
  if (c.slack) subs.push('slack ' + whenText(c.slack, u.t));
  if (c.win) {
    const lim = `${fs(TH.workable)} ${su()}`;
    subs.push(c.win.under ? `under ${lim} ${c.win.t ? 'until ' + clock(c.win.t) : 'for 36 h+'}` : (c.win.t ? `under ${lim} from ${clock(c.win.t)}` : ''));
  }
  return tile(c.src === 'obs' ? 'Current · observed' : c.src === 'fcst' ? 'Current · forecast' : 'Current · predicted', curText(c.v), subs, c.level, c.t);
}

function levelTile(r, u) {
  if (u.flow) return tile('River flow', `${Math.round(u.flow.v * flowK()).toLocaleString()} <small>${fu()}</small>`, [], u.flow.stale ? 'stale' : '', u.flow.t);
  if (u.wave) {
    const f = u.wave.src === 'fcst';
    const how = [u.wave.period ? u.wave.period.toFixed(0) + ' s' : '', u.wave.dir != null ? 'from ' + compass(u.wave.dir) : ''].filter(Boolean).join(' ');
    return tile(f ? 'Seas · forecast' : 'Seas · observed', `${fl(u.wave.v, 1)} <small>${lu()}${r.kind === 'point' ? ' seas' : ''}</small>`,
      [how, f ? 'NWS wave model' : ''], !f && u.wave.stale ? 'stale' : '', f ? null : u.wave.t);
  }
  const w = u.wl;
  if (!w) return r.s.flowOnly || r.s.buoy ? emptyTile : tile('Water level', '<small>no data</small>');
  if (w.src === 'none') return tile('Water level', '<small>no prediction yet</small>');
  const subs = [];
  if (w.src === 'fcst') {
    if (w.half != null && w.half > 0.005) subs.push(`± ${fl(w.half)} ${lu()} (95%)`);
  } else if (w.src === 'pred' && w.anomaly != null) subs.push(`tide only; running ${signed(w.anomaly, fl(Math.abs(w.anomaly)))} ${lu()} now`);
  if (w.next) subs.push(`${w.next.type} ${fl(w.next.v)} ${lu()} ${whenText(w.next.t, u.t)}`);
  return tile(w.src === 'obs' ? `Water level · ${w.trend || 'observed'}` : w.src === 'fcst' ? 'Water level · forecast' : 'Water level · predicted', `${fl(w.v)} <small>${lu()} ${w.datum}</small>`, subs, w.level, w.t);
}

// A bridge air gap. Observed only: at a future time (or an ETA in Transit) it is still the latest reading.
function gapTile(u) {
  const g = u.gap;
  if (!g) return tile('Air gap', '<small>no data</small>');
  return tile(u.live ? 'Air gap · observed' : 'Air gap · observed now', `${fl(g.v)} <small>${lu()}</small>`, u.live ? [] : ['latest reading; no forecast'], g.level, g.t);
}

function windTile(r, u) {
  const w = u.wind;
  if (!w) return tile('Wind', u.live ? '<small>not measured</small>' : '<small>no forecast</small>');
  const subs = [];
  if (w.src === 'obs') {
    if (!w.stale && w.gust) subs.push('gust ' + fw(w.gust));
    if (w.peak) subs.push(`forecast peak ${fw(w.peak.kt)} ${su()} ${whenText(w.peak.t, u.t)}`);
  } else subs.push('NWS forecast');
  return tile(w.src === 'obs' ? 'Wind · observed' : 'Wind · forecast', `${fw(w.v)} <small>${su()} ${w.dir || ''}</small>`, subs, w.level, w.t);
}

function setHidden(id, hide) {
  if (hide) state.hidden.add(id); else state.hidden.delete(id);
  if (hide && state.selected === id) state.selected = null;
  store('sr-hidden', JSON.stringify([...state.hidden]));
  renderView();
}

function renderRows(sums) {
  const el = document.getElementById('cards');
  const keepScroll = window.scrollY;
  el.innerHTML = '';
  document.getElementById('showall').hidden = !state.hidden.size;
  ROWS.forEach((r, i) => {
    const u = sums[i], open = r.id === state.selected;
    const b = document.createElement('div');
    b.dataset.id = r.id;
    b.tabIndex = 0;
    b.setAttribute('role', 'button');

    if (state.hidden.has(r.id)) {
      // minimized: a thin bar with just the name
      b.className = 'card min';
      b.setAttribute('aria-label', 'Show ' + r.name);
      b.innerHTML = `<span class="cname">${r.name}</span><span class="minhint">＋ show</span>`;
      const restore = () => setHidden(r.id, false);
      b.addEventListener('click', restore);
      b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); restore(); } });
      el.appendChild(b);
      return;
    }

    b.setAttribute('aria-expanded', open);
    b.className = 'card' + (r.kind !== 'station' ? ' slim' : '') + (open ? ' sel' : '') + (r.s && r.s.focus ? ' focus' : '') + (state.mode === 'transit' ? (onLeg(r) ? ' leg' : ' off') : '');
    let where = r.kind === 'point' ? `NOAA prediction ${r.p.id} · ${r.p.survey}` : r.kind === 'gap' ? `${r.g.where} · NOAA ${r.g.coops}` : r.s.where;
    const tag = state.mode !== 'transit' ? '' : state.tr.from.id === r.id ? '<span class="trtag">Start</span>' : state.tr.to.id === r.id ? '<span class="trtag">End</span>' : '';
    if (state.mode === 'transit') where = onLeg(r) ? (state.tr.from.id === r.id ? `${tag}<b>depart ${clock(u.t)}</b>` : `${tag}<b>ETA ${clock(u.t)}</b> · ${Math.abs(r.nm - trPos(state.tr.from)).toFixed(1)} nm`) : 'off route · at departure time';
    let html = `<div class="chead"><div class="cname">${r.name}</div><div class="cwhere">${where}</div></div>`;
    html += r.kind === 'gap' ? gapTile(u) + emptyTile + emptyTile
      : r.kind === 'point' ? (u.wave ? levelTile(r, u) : emptyTile) + currentTile(r, u) + emptyTile : levelTile(r, u) + currentTile(r, u) + windTile(r, u);
    html += `<div class="cctl"><span class="chev" title="${open ? 'Close charts' : 'Open charts'}">${open ? '▾' : '▸'}<small>${open ? 'close' : 'charts'}</small></span>` +
      `<button type="button" class="minbtn" title="Minimize this location" aria-label="Minimize ${r.name}">–</button></div>`;
    b.innerHTML = html;
    b.addEventListener('click', () => select(r.id));
    b.addEventListener('keydown', e => { if (e.target === b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(r.id); } });
    b.querySelector('.minbtn').addEventListener('click', e => { e.stopPropagation(); setHidden(r.id, true); });
    el.appendChild(b);
    if (open) {
      const dr = document.createElement('div');
      dr.className = 'drawer';
      el.appendChild(dr);
      renderDrawer(dr, r, u);
    }
  });
  window.scrollTo(0, keepScroll);
}

// ---------- map ----------

let map, markers = {}, pointMarkers = [], lastSums = null;

// NOAA's chart service picks which chart to draw from the pixel scale of each request, and only uses the
// harbor and river charts at about 10 m per pixel or finer. Two workarounds keep the river visible:
// 1. at zoom 12-13, ask for sharper tiles;
// 2. at zoom 11 and wider, lay three pre-sized images of the river corridor from Savannah to Clyo over the map.
function buildChartLayer() {
  const url = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer';
  const ChartLayer = L.TileLayer.WMS.extend({
    getTileUrl(coords) {
      const f = Math.min(4, Math.max(1, Math.pow(2, 14 - coords.z)));
      this.wmsParams.width = this.wmsParams.height = 256 * f;
      return L.TileLayer.WMS.prototype.getTileUrl.call(this, coords);
    }
  });
  const tiles = new ChartLayer(url, { layers: '0,1,2,3,4,5,6,7', format: 'image/png', transparent: true, attribution: 'NOAA Office of Coast Survey' });
  // NOAA's server now and then fails a tile that it serves correctly a moment later: ask again, up to three times
  tiles.on('tileerror', e => {
    const n = +(e.tile.dataset.retry || 0);
    if (n >= 3) return;
    e.tile.dataset.retry = n + 1;
    setTimeout(() => { e.tile.src = e.tile.src.replace(/&retry=\d+$/, '') + '&retry=' + (n + 1); }, 800 * (n + 1));
  });
  const group = L.layerGroup([tiles]);
  const c = CONFIG.chartCorridor, P = L.CRS.EPSG3857, corridor = [];
  for (let i = 0; i < c.lats.length - 1; i++) {
    const sw = P.project(L.latLng(c.lats[i], c.west)), ne = P.project(L.latLng(c.lats[i + 1], c.east));
    const q = new URLSearchParams({
      SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', LAYERS: '0,1,2,3,4,5,6,7', STYLES: '', FORMAT: 'image/png', TRANSPARENT: 'true',
      SRS: 'EPSG:3857', BBOX: [sw.x, sw.y, ne.x, ne.y].join(','),
      WIDTH: Math.round((ne.x - sw.x) / c.metersPerPixel), HEIGHT: Math.round((ne.y - sw.y) / c.metersPerPixel)
    });
    corridor.push(L.imageOverlay(url + '?' + q, [[c.lats[i], c.west], [c.lats[i + 1], c.east]]));
  }
  const sync = () => {
    const want = map.hasLayer(group) && map.getZoom() <= 11;
    for (const im of corridor) { if (want && !group.hasLayer(im)) group.addLayer(im); if (!want && group.hasLayer(im)) group.removeLayer(im); }
  };
  map.on('zoomend baselayerchange', sync);
  return group;
}

function renderMap(sums) {
  if (!window.L) return;
  lastSums = sums;
  if (!map) {
    map = L.map('map', { scrollWheelZoom: false }).setView([32.09, -81.02], 11);
    map.on('zoomend', () => renderMap(lastSums));   // the air gap symbol's nudge depends on the zoom
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' });
    // a plain light-gray base that lets the markers and the channel line stand out
    const esri = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/';
    const gray = L.layerGroup([
      L.tileLayer(esri + 'World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors' }),
      L.tileLayer(esri + 'World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 })
    ]);
    const chart = buildChartLayer();
    L.control.layers({ 'Minimal gray': gray, 'NOAA nautical chart': chart, 'Street map': osm }, null, { collapsed: false }).addTo(map);
    // ?base=street, gray or chart picks the base map; otherwise the last one chosen in this browser
    const bases = { street: osm, gray, chart };
    let want = new URLSearchParams(location.search).get('base');
    if (!bases[want]) { try { want = localStorage.getItem('sr-base2'); } catch (e) { /* storage unavailable */ } }
    (bases[want] || gray).addTo(map);          // the gray map unless another was chosen
    map.fire('baselayerchange');
    map.on('baselayerchange', e => { const k = Object.keys(bases).find(x => bases[x] === e.layer); if (k) store('sr-base2', k); });
    { const r0 = ROWS.find(x => x.id === state.selected); if (r0 && r0.kind === 'station' && r0.s.buoy) focusMap(r0, false); }
    for (const p of CONFIG.currentPoints) {
      const target = p.station || 'cp:' + p.id;
      if (!ROWS.some(r => r.id === target)) continue;
      const m = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: '<div class="mkp"></div>', iconSize: [12, 12] }) })
        .bindTooltip('NOAA current prediction: ' + p.name).addTo(map).on('click', () => select(target, true));
      pointMarkers.push({ m, target });
    }
  }
  for (const pm of pointMarkers) {
    const sel = pm.target === state.selected;
    const prow = ROWS.find(r => r.id === pm.target), off = state.mode === 'transit' && !onLeg(prow);
    pm.m.setIcon(L.divIcon({ className: '', html: `<div class="mkp${sel ? ' sel' : ''}${off ? ' off' : ''}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }));
    pm.m.setZIndexOffset(sel ? 900 : 0);
  }
  ROWS.forEach((r, i) => {
    if (r.kind === 'point') return;
    // a bridge air gap is a smaller circle in the light green of the prediction diamonds, named on hover
    const isGap = r.kind === 'gap', size = isGap ? 16 : 22;
    const u = sums[i], sel = r.id === state.selected;
    const glyph = u.level === 'alert-hi' ? '!' : u.level === 'caution' ? '▲' : u.level === 'stale' ? '?' : '';
    const cls = 'mk ' + (isGap ? 'gap ' : '') + (levelWord[u.level] ? u.level : '') + (sel ? ' sel' : '') + (state.mode === 'transit' && !onLeg(r) ? ' off' : '');
    // The Talmadge Bridge sensor is 400 m from the Talmadge current prediction point, a few pixels when zoomed out.
    // There the air gap symbol is drawn a little up and to the left of its true place so both can be seen and clicked.
    const nudge = isGap ? (map.getZoom() <= 11 ? 9 : map.getZoom() === 12 ? 5 : 0) : 0;
    const icon = L.divIcon({ className: '', html: `<div class="${cls}">${glyph}</div>`, iconSize: [size, size], iconAnchor: [size / 2 + nudge, size / 2 + nudge] });
    if (!markers[r.id]) {
      markers[r.id] = L.marker([r.lat, r.lon], { icon }).addTo(map).on('click', () => select(r.id, true));
      if (isGap) markers[r.id].bindTooltip(r.name);
      else markers[r.id].bindTooltip(r.s.short, { permanent: true, direction: 'right', offset: [12, 0], className: 'lbl' });
    } else markers[r.id].setIcon(icon);
    markers[r.id].setZIndexOffset(sel ? 1000 : isGap ? 100 : 0);
    if (isGap) return;
    const tip = markers[r.id].getTooltip() && markers[r.id].getTooltip().getElement();
    if (tip) { tip.classList.toggle('sel', sel); tip.classList.toggle('off', state.mode === 'transit' && !onLeg(r)); }
  });
}

// Bring a chosen place into view. The buoy is 40 nm offshore, so for it the map zooms out until the buoy and the
// whole river are in view (otherwise it is not clear where the map went); from that wide view, choosing a river
// place returns to the usual zoom.
function focusMap(r, animate) {
  if (r.kind === 'station' && r.s.buoy) {
    const b = L.latLngBounds(ROWS.map(x => [x.lat, x.lon]));
    if (animate) map.flyToBounds(b, { padding: [30, 30], duration: 0.8 }); else map.fitBounds(b, { padding: [30, 30] });
  } else if (map.getZoom() < 10) map.flyTo([r.lat, r.lon], 11, { duration: animate ? 0.8 : 0 });
  else map.panTo([r.lat, r.lon], { animate, duration: 0.6 });
}

// Open a place's drawer; choosing the open one again closes it. The map eases over to the chosen place.
function select(id, fromMap) {
  // in Transit, with a "map" button armed, a click on a place sets that end of the transit
  if (fromMap && state.mode === 'transit' && state.tr.pick) {
    const pr = ROWS.find(x => x.id === id);
    if (pr.nm != null && pr.kind !== 'gap') setTransitEnd(state.tr.pick, { id });
    return;
  }
  state.selected = state.selected === id && !fromMap ? null : id;
  if (state.selected) state.hidden.delete(id);
  history.replaceState(null, '', (state.selected ? '#' + state.selected : location.pathname) + '');
  renderView();
  const r = ROWS.find(x => x.id === state.selected);
  if (r && map) focusMap(r, true);
  if (fromMap && r) {
    const row = document.querySelector(`.card[data-id="${r.id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// ---------- drawer charts ----------

let chartQueue = [];
function chartBox(parent) {
  const div = document.createElement('div');
  div.className = 'chartbox';
  parent.appendChild(div);
  return div;
}
function queueChart(box, title, opt) { chartQueue.push([box, title, opt]); }
function flushCharts() {
  const q = chartQueue; chartQueue = [];
  const widths = q.map(c => c[0].clientWidth); // measure before any chart adds content
  const marginRight = Math.max(10, ...q.map(c => chartRightMargin(c[2])));
  q.forEach((c, i) => drawChart(c[0], c[1], { ...c[2], width: widths[i], marginRight }));
}

// One series for judging status over time: observations while they exist, then the prediction or forecast.
function statusSeries(obs, pred) {
  const last = obs.length ? obs[obs.length - 1][0] : -Infinity;
  return obs.concat((pred || []).filter(p => p[0] > last));
}

// Time spans when a series is at caution or alert, for shading charts and table rows.
function bandsOf(points, lv) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const l = lv(points[i][1]);
    if (l !== 'caution' && l !== 'alert-hi') continue;
    const t0 = points[i][0];
    const step = i + 1 < points.length ? points[i + 1][0] - t0 : (i ? t0 - points[i - 1][0] : 6 * 6e4);
    const t1 = t0 + Math.min(step, 90 * 6e4);
    const prev = out[out.length - 1];
    if (prev && prev.level === l && prev.t1 >= t0 - 1) prev.t1 = t1; else out.push({ t0, t1, level: l });
  }
  return out;
}

// Chart options that carry status: shaded bands, and a per-hour status for the table.
function statusOpts(points, lv, noteFn) {
  const bands = bandsOf(points, lv);
  const any = bands.length || noteFn;
  return {
    bands,
    rowStatus: !any ? null : t => {
      const b = bands.find(x => t >= x.t0 && t < x.t1);
      if (b) return { level: b.level, text: levelWord[b.level] };
      const v = noteFn ? valueAt(points, t, 45) : null;
      return { level: '', text: v == null ? '' : noteFn(v) };
    }
  };
}

function limitLines(key, k, mirror) {
  const out = [];
  for (const [suffix, label, color] of [['Caution', 'caution', 'var(--warning)'], ['Alert', 'alert', 'var(--critical)']]) {
    const v = TH[key + suffix];
    if (v == null) continue;
    out.push({ value: v * k, label, color });
    if (mirror) out.push({ value: -v * k, label, color });
  }
  return out;
}

function renderDrawer(el, r, u) {
  const base = { t0: state.now - 12 * HOUR, t1: state.now + 36 * HOUR, now: state.now, mark: u.live ? null : u.t };
  const C1 = 'var(--series-1)', C2 = 'var(--series-2)', C3 = 'var(--series-3)';
  const workNote = TH.workable == null ? null : v => (Math.abs(v) < TH.workable ? 'workable' : '');
  const gf = r.kind === 'station' ? gaugeForecast(r.s) : null;
  const wf = waveFc(r.id);
  const waveChart = obs => queueChart(chartBox(charts), 'Significant wave height', {
    ...base, unit: lu(), alwaysLegend: true,
    series: [{ name: 'Observed', color: C1, points: conv(obs, lenK()) }]
      .concat(wf ? [{ name: 'NWS wave model (NWPS), run ' + fmtDayTime.format(state.waves.run) + ' ' + tzAbbr(state.waves.run), color: C2, points: conv(wf.hs, lenK()), dashed: true }] : [])
  });
  let note;
  if (r.kind === 'point') {
    note = `NOAA tidal current prediction ${r.p.id} (${r.p.survey}). ` + (r.p.type === 'S'
      ? 'NOAA publishes only slack and maximum times here; the curve between them is drawn by the dashboard and is approximate.'
      : 'Full NOAA harmonic prediction' + (r.p.depth ? ` at ${fl(r.p.depth, 0)} ${lu()} depth.` : '.')) + ' Tide only: river flow and wind are not included.'
      + (waveFc(r.id) ? ' Seas are the National Weather Service nearshore wave model (NWPS) forecast for this spot.' : '');
  } else note = r.kind === 'gap' ? r.g.note : r.s.note;
  el.innerHTML = `<p class="dnote">${note}</p>`;
  const charts = document.createElement('div');
  charts.className = 'charts';
  el.appendChild(charts);

  if (r.kind === 'point') {
    const pts = predSeries(r);
    queueChart(chartBox(charts), 'Predicted current, flood + / ebb −', {
      ...base, unit: su(), digits: 2, zeroLine: true, thresholds: r.nm != null ? limitLines('current', spdK(), true) : [], ...statusOpts(pts, curLvAt(r), workNote),
      series: [{ name: 'Predicted tidal current', color: C2, points: conv(pts, spdK()), dashed: true }]
    });
    if (wf) waveChart([]);
  } else if (r.kind === 'gap') {
    queueChart(chartBox(charts), r.name, {
      ...base, unit: lu(), alwaysLegend: true, thresholds: limitLines('airGap', lenK()), ...statusOpts(S('airgap', r.g.id), v => lvLow(v, 'airGap')),
      series: [{ name: 'Observed', color: C1, points: conv(S('airgap', r.g.id), lenK()) }]
    });
  } else {
    const s = r.s;
    if (s.flowOnly) {
      queueChart(chartBox(charts), 'River flow', { ...base, unit: fu(), digits: 0, series: [{ name: 'Observed', color: C1, points: conv(S('flow', s.id), flowK()) }] });
      queueChart(chartBox(charts), 'River stage', { ...base, unit: lu(), digits: 2, series: [{ name: 'Observed', color: C1, points: conv(S('stage', s.id), lenK()) }] });
    } else if (s.buoy) {
      waveChart(S('wave', s.id));
    } else {
      const wlTh = s.coops ? limitLines('wlHigh', lenK()).map(x => ({ ...x, label: 'high ' + x.label })).concat(limitLines('wlLow', lenK()).map(x => ({ ...x, label: 'low ' + x.label }))) : [];
      queueChart(chartBox(charts), 'Water level', {
        ...base, unit: lu() + ' ' + (s.coops || s.mllw != null ? 'MLLW' : 'NAVD88'), digits: 2, thresholds: wlTh,
        ...(s.coops ? statusOpts(statusSeries(S('wl', s.id), aheadSeries(gf && gf.wlFine, S('wlpred', s.id))), wlLv) : {}),
        areas: gf && gf.wl.length ? [{ lo: conv(fromNow(gf.wlLo), lenK()), hi: conv(fromNow(gf.wlHi), lenK()), color: C3 }] : [],
        series: [{ name: 'Observed', color: C1, points: conv(S('wl', s.id), lenK()) }, { name: 'Predicted tide', color: C2, points: conv(S('wlpred', s.id), lenK()), dashed: true }]
          .concat(gf && gf.wl.length ? [{ name: 'Forecast (tide + weather + gauges)', color: C3, points: conv(gf.wl, lenK()), dashed: true }] : [])
      });
      const curSeries = [{ name: 'Observed (USGS section mean)', color: C1, points: conv(S('cur', s.id), spdK()) }];
      // one tidal prediction only: the section mean where the gauge measures velocity, else NOAA's channel point
      if (stationPred(s.id).length) curSeries.push({
        name: predIsSection(s.id) ? 'Predicted tidal current (section mean)' : `Predicted tidal current (NOAA, ${fl(s.curPred.depth, 0)} ${lu()} depth)`,
        color: C2, points: conv(stationPred(s.id), spdK()), dashed: true
      });
      // The green line also runs back over the past hours, where it is the current worked out from the measured water
      // level, so it can be checked against the USGS reading. Its band is drawn for the forecast hours only.
      if (gf && gf.cur.length) curSeries.push({ name: 'Forecast from water level (section mean)', color: C3, points: conv(gf.cur, spdK()), dashed: true });
      if (curSeries.some(c => c.points.length)) {
        queueChart(chartBox(charts), 'Current, flood + / ebb −', {
          ...base, unit: su(), digits: 2, zeroLine: true, alwaysLegend: true, series: curSeries, thresholds: r.nm != null ? limitLines('current', spdK(), true) : [],
          areas: gf && gf.cur.length ? [{ lo: conv(fromNow(gf.curLo), spdK()), hi: conv(fromNow(gf.curHi), spdK()), color: C3 }] : [],
          ...statusOpts(statusSeries(S('cur', s.id), aheadSeries(gf && gf.curFine, stationPred(s.id))), curLvAt(r), workNote)
        });
      }
    }
    const fc = (state.nws[s.nws] || []).map(p => [p.t, p.kt]);
    if (S('wind', s.id).length || fc.length) {
      queueChart(chartBox(charts), 'Wind speed', {
        ...base, unit: su(), digits: metric() ? 1 : 0, thresholds: limitLines('wind', spdK()),
        ...statusOpts(statusSeries(S('wind', s.id), fc), v => lvHigh(v, 'wind')),
        series: [{ name: 'Observed', color: C1, points: conv(S('wind', s.id), spdK()) }, { name: 'NWS forecast', color: C2, points: conv(fc, spdK()), dashed: true }]
      });
    }
  }
  flushCharts();
  if (TH.workable != null && predSeries(r).length) {
    const useFc = !!(gf && gf.curFine.length && fcFresh());
    renderWindows(el, useFc ? aheadSeries(gf.curFine, predSeries(r)) : predSeries(r), useFc ? 'the experimental section-mean current forecast at ' + r.s.name
      : r.kind === 'point' ? 'NOAA tidal current predictions at ' + r.p.name
        : predIsSection(r.s.id) ? 'the section-mean tidal current prediction computed for this page at ' + r.s.name
          : 'NOAA tidal current predictions at ' + r.s.curPred.name, useFc);
  }
}

// List upcoming periods when the predicted tidal current stays under the workable limit.
function renderWindows(el, series, source, isFc) {
  const pred = series.filter(p => p[0] >= state.now && p[0] <= state.now + 36 * HOUR);
  const div = document.createElement('div');
  div.className = 'windows';
  let rows = '', start = null, n = 0;
  pred.forEach((p, i) => {
    const under = Math.abs(p[1]) < TH.workable;
    if (under && start == null) start = p[0];
    if (start != null && (!under || i === pred.length - 1)) {
      const end = under ? p[0] : pred[i - 1][0];
      const mins = Math.round((end - start) / 6e4);
      rows += `<tr><td>${fmtDayTime.format(start)}</td><td>${fmtDayTime.format(end)}${under ? ' or later' : ''}</td><td>${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')}</td></tr>`;
      start = null; n++;
    }
  });
  div.innerHTML = `<h3>Workable windows: ${isFc ? 'forecast' : 'predicted'} current under ${fs(TH.workable)} ${su()}, next 36 h</h3>` +
    (n ? `<table><tr><th>From</th><th>Until</th><th>Length</th></tr>${rows}</table>` : '<p class="muted small">None in this period.</p>') +
    `<p class="muted small">From ${source}. ${isFc ? 'It includes the weather and river flow in the forecast; after the forecast ends the tide-only prediction is used.' : 'Tide only: river flow and wind will shift these times.'}</p>`;
  el.appendChild(div);
}

// ---------- limits form ----------

function renderSettings() {
  const form = document.getElementById('thform');
  form.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'limits';
  table.innerHTML = '<tr><th>Limit</th><th>Caution</th><th>Alert</th></tr>';
  const input = (key, kind) => {
    const k = kind === 'spd' ? spdK() : lenK();
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.1'; inp.placeholder = 'not set';
    inp.value = TH[key] == null ? '' : +(TH[key] * k).toFixed(2);
    inp.setAttribute('aria-label', key);
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      TH[key] = isFinite(v) ? v / k : null;
      store('sr-limits-v2', JSON.stringify(TH));
      render();
    });
    return inp;
  };
  for (const L of LIMITS) {
    const tr = document.createElement('tr');
    const unit = L.kind === 'spd' ? su() : lu();
    const how = L.single ? '' : L.dir === 'high' ? ' · at or above' : ' · at or below';
    tr.innerHTML = `<td><b>${L.label}</b> <span class="muted">(${unit}${how})</span><div class="help">${L.help}</div></td>`;
    if (L.single) {
      const td = document.createElement('td');
      td.colSpan = 2;
      td.appendChild(input(L.key, L.kind));
      tr.appendChild(td);
    } else {
      for (const suffix of ['Caution', 'Alert']) {
        const td = document.createElement('td');
        td.appendChild(input(L.key + suffix, L.kind));
        tr.appendChild(td);
      }
    }
    table.appendChild(tr);
  }
  form.appendChild(table);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = 'Clear all limits';
  clear.addEventListener('click', () => {
    for (const k in TH) TH[k] = null;
    store('sr-limits-v2', JSON.stringify(TH));
    renderSettings();
    render();
  });
  form.appendChild(clear);
}

// ---------- controls ----------

let frame = 0;
function later() { cancelAnimationFrame(frame); frame = requestAnimationFrame(renderView); }
document.getElementById('tslider').addEventListener('input', e => { state.offsetMin = +e.target.value; later(); });
document.getElementById('nowbtn').addEventListener('click', () => { state.offsetMin = 0; renderView(); });
document.querySelectorAll('#modeseg button').forEach(b => b.addEventListener('click', () => { state.mode = b.dataset.mode; renderView(); }));
document.querySelectorAll('#unitseg button').forEach(b => b.addEventListener('click', () => {
  state.units = b.dataset.units;
  store('sr-units', state.units);
  renderSettings();
  render();
}));
for (const end of ['from', 'to']) document.getElementById('tr' + end).addEventListener('change', e => {
  const v = e.target.value;
  setTransitEnd(end, v.startsWith('id:') ? { id: v.slice(3) } : { km: +v.slice(3) });
});
document.getElementById('trdep').addEventListener('change', e => { state.offsetMin = +e.target.value; renderView(); });
document.getElementById('trfix').addEventListener('change', e => {
  const sp = trSpeed();
  if (e.target.value === 'time') state.tr.arrive = viewTime() + trDist() / (sp || state.speed) * HOUR;
  else if (sp) state.speed = Math.min(25, Math.max(2, Math.round(sp * 2) / 2));
  state.tr.fix = e.target.value;
  document.getElementById('spd').value = state.speed;
  renderView();
});
document.getElementById('trarr').addEventListener('change', e => { state.tr.arrive = +e.target.value; renderView(); });
document.querySelectorAll('.pick').forEach(b => b.addEventListener('click', () => { state.tr.pick = state.tr.pick === b.dataset.end ? null : b.dataset.end; renderView(); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.tr.pick) { state.tr.pick = null; renderView(); } });
document.getElementById('spd').addEventListener('change', e => {
  const v = parseFloat(e.target.value);
  if (isFinite(v) && v >= 1) { state.speed = v; renderView(); }
});
document.getElementById('showall').addEventListener('click', () => { state.hidden.clear(); store('sr-hidden', '[]'); renderView(); });
document.getElementById('refresh').addEventListener('click', loadAll);
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderView, 200); });
document.getElementById('spd').value = state.speed;
renderSettings();
loadAll();
setInterval(loadAll, CONFIG.refreshMinutes * 6e4);
