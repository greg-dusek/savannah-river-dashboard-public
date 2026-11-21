// Channel forecast: water level and current every 500 m along the ship channel, from data/forecast.json
// (written by model/daily.py). The file is metric (m NAVD88, m/s); here it is turned into the page's
// internal units: feet above MLLW and knots, flood positive.

const CHAN_COLOR = '#e8731c';
const chan = { fc: null, sel: null, line: null, dot: null, siteDots: [], open: false };
try { chan.open = localStorage.getItem('sr-chan-open') === '1'; } catch (e) { /* storage unavailable */ }
// a link with ?chan=open shows the channel charts
if (new URLSearchParams(location.search).get('chan') === 'open') chan.open = true;

async function loadForecast() {
  let j;
  try { j = await getJSON('data/forecast.json?t=' + Math.floor(Date.now() / 3e5)); } catch (e) { chan.fc = null; throw e; }
  const t = j.times.map(s => s * 1000);
  const ser = (a, f) => (a ? a.map((v, i) => [t[i], v == null ? NaN : f(v)]).filter(p => isFinite(p[1])) : []);
  const pts = j.points.map(p => {
    const wl = v => v * FT_PER_M + p.mllw_ft, cu = v => v * KT_PER_MS;
    return { ...p, wl: ser(p.wl, wl), wlLo: ser(p.wl_lo, wl), wlHi: ser(p.wl_hi, wl), cur: ser(p.cur, cu), curLo: ser(p.cur_lo, cu), curHi: ser(p.cur_hi, cu) };
  });
  const gc = {};
  for (const g of j.gauge_currents || []) gc[g.id] = { cur: ser(g.cur, v => v * KT_PER_MS), curLo: ser(g.cur_lo, v => v * KT_PER_MS), curHi: ser(g.cur_hi, v => v * KT_PER_MS) };
  chan.fc = { now: j.now * 1000, made: j.made * 1000, cycle: j.cycle, flow: j.river_flow_m3s, t0: t[0], t1: t[t.length - 1], points: pts, gaugeCur: gc };
  if (chan.sel == null) {
    let km = 12;
    try { const s = parseFloat(localStorage.getItem('sr-chan-km')); if (isFinite(s)) km = s; } catch (e) { /* storage unavailable */ }
    chan.sel = nearestPoint(km);
  }
}

function nearestPoint(km) {
  const P = chan.fc.points;
  let best = 0;
  for (let i = 1; i < P.length; i++) if (Math.abs(P[i].km - km) < Math.abs(P[best].km - km)) best = i;
  return best;
}

// The forecast for a dashboard station that sits on a gauge (level) or a USGS velocity gauge (section-mean current).
function gaugeForecast(s) {
  if (!chan.fc) return null;
  const id = s.coops || s.usgs, memo = chan.fc.gf || (chan.fc.gf = {});
  if (id in memo) return memo[id];
  const p = chan.fc.points.find(x => x.gauge && (x.gauge === s.coops || x.gauge === s.usgs));
  const c = chan.fc.gaugeCur[s.usgs];
  // wlAll runs back over the past hours (the gauge reading); wlFine and curFine are the hours ahead on a 6-minute step
  return memo[id] = p || c ? {
    wl: p ? fromNow(p.wl) : [], wlAll: p ? p.wl : [], wlLo: p ? p.wlLo : [], wlHi: p ? p.wlHi : [],
    cur: c ? c.cur : [], curLo: c ? c.curLo : [], curHi: c ? c.curHi : [],
    wlFine: p ? fineAhead(p.wl) : [], curFine: c ? fineAhead(c.cur) : [], id
  } : null;
}
// The forecast is used in the headline numbers and for limits only while it is current.
const fcFresh = () => !!chan.fc && state.now - chan.fc.made <= 30 * HOUR;
// An hourly forecast series from the build hour on, filled in to a 6-minute step.
function fineAhead(series) {
  const out = [], step = 6 * 6e4;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    if (b[0] <= chan.fc.now || b[0] - a[0] > 2 * HOUR) continue;
    for (let t = a[0]; t < b[0]; t += step) out.push([t, a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0])]);
    if (i === series.length - 1) out.push(b);
  }
  return out;
}
// The best series for the hours ahead: the forecast while it lasts, then the tide-only prediction.
function aheadSeries(fine, pred) {
  if (!fine || !fine.length || !fcFresh()) return pred;
  const end = fine[fine.length - 1][0];
  return fine.concat(pred.filter(q => q[0] > end));
}
const halfBand = (lo, hi, t) => { const a = interpAt(lo, t), b = interpAt(hi, t); return a == null || b == null ? null : (b - a) / 2; };

// Where a channel point is: distance from the sea entrance, and the nearest dashboard station.
function placeParts(p) {
  let best = null, bd = 1e9;
  for (const s of CONFIG.stations) {
    if (s.buoy || s.flowOnly) continue;
    const d = Math.hypot((s.lat - p.lat) * 111, (s.lon - p.lon) * 94);
    if (d < bd) { bd = d; best = s; }
  }
  const dist = metric() ? p.km.toFixed(1) + ' km' : (p.km / 1.852).toFixed(1) + ' nm';
  const near = bd < 0.4 ? 'at ' + best.name : (bd / (metric() ? 1 : 1.852)).toFixed(1) + (metric() ? ' km' : ' nm') + ' from ' + best.name;
  return { dist, near };
}

// ---- reading the hourly forecast series at any time ----
function interpAt(series, t) {
  const n = series.length;
  if (!n || t < series[0][0] || t > series[n - 1][0]) return null;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (series[mid][0] <= t) lo = mid; else hi = mid; }
  const a = series[lo], b = series[hi];
  if (b[0] - a[0] > 2 * HOUR) return null;
  return b[0] === a[0] ? a[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
}
// Next high or low water after t. The series is hourly, so the turn is placed with a curve through three points.
function chanTurn(series, t) {
  for (let i = 1; i < series.length - 1; i++) {
    const [ta, a] = series[i - 1], [tb, b] = series[i], c = series[i + 1][1];
    const high = b >= a && b > c, low = b <= a && b < c;
    if (!high && !low) continue;
    const den = a - 2 * b + c, off = den ? 0.5 * (a - c) / den : 0;
    const tt = tb + off * (tb - ta);
    if (tt > t) return { type: high ? 'High' : 'Low', t: tt, v: b - 0.25 * (a - c) * off };
  }
  return null;
}
function chanSlack(series, t) {
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    if (a[1] * b[1] >= 0 && a[1] !== 0) continue;
    const tt = a[0] + (b[0] - a[0]) * a[1] / ((a[1] - b[1]) || 1);
    if (tt > t) return tt;
  }
  return null;
}
// Wind for a channel point: the nearest fresh wind observation when the page shows now, otherwise the NWS forecast.
function chanWind(p, t) {
  const st = CONFIG.stations.filter(s => !s.buoy && !s.flowOnly)
    .map(s => ({ s, d: Math.hypot((s.lat - p.lat) * 60, (s.lon - p.lon) * 51) })).sort((a, b) => a.d - b.d);
  if (isLive(t)) {
    for (const { s } of st) {
      const w = latest(S('wind', s.id));
      if (!w || w.stale) continue;
      const dir = valueAt(S('wdir', s.id), w.t, 20), gust = valueAt(S('gust', s.id), w.t, 20);
      return { v: w.v, src: 'obs', t: w.t, dir: dir == null ? '' : compass(dir), gust, at: s.name, level: lvHigh(w.v, 'wind') };
    }
  }
  const f = windForecast(st[0].s.nws, t);
  return f ? { v: f.kt, src: 'fcst', dir: f.dir, level: lvHigh(f.kt, 'wind') } : null;
}

function selectChannel(i) {
  chan.sel = i;
  store('sr-chan-km', String(chan.fc.points[i].km));
  renderChannel();
}

function renderChannelMap() {
  if (!window.L || !map || !chan.fc) return;
  const P = chan.fc.points;
  if (!chan.line) {
    // orange, unlike the teal gauge dots: this is the experimental forecast, not a measurement
    chan.line = L.polyline(P.map(p => [p.lat, p.lon]), { color: CHAN_COLOR, weight: 5, opacity: 0.6 }).addTo(map)
      .bindTooltip('Experimental channel forecast: tap to choose a place', { sticky: true })
      .on('click', e => {
        let best = 0, bd = 1e9;
        P.forEach((p, i) => { const d = Math.hypot(p.lat - e.latlng.lat, (p.lon - e.latlng.lng) * 0.85); if (d < bd) { bd = d; best = i; } });
        // in Transit, with a "map" button armed, the click sets that end of the transit
        if (state.mode === 'transit' && state.tr.pick) { setTransitEnd(state.tr.pick, { km: chan.fc.points[best].km }); return; }
        state.hidden.delete('chan');
        selectChannel(best);
        const el = document.getElementById('chan');
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    chan.dot = L.circleMarker([P[0].lat, P[0].lon], { radius: 8, color: CHAN_COLOR, weight: 4, fillColor: '#fff', fillOpacity: 1 }).addTo(map)
      .bindTooltip('Experimental channel forecast', { direction: 'right', offset: [10, 0], className: 'chanlbl' });
  }
  const p = P[chan.sel];
  chan.dot.setLatLng([p.lat, p.lon]);
}

// The forecast is built on the hour, but the page's "now" moves with the clock. Lines hand over from solid to dashed
// at "now", with a point worked out there from the forecast in hand, so the dashed line never starts before "now".
function splitNow(points, now) {
  const v = interpAt(points, now), mid = v == null ? [] : [[now, v]];
  return [points.filter(p => p[0] < now).concat(mid), mid.concat(points.filter(p => p[0] > now))];
}
const fromNow = points => splitNow(points, state.now)[1];

// The three tiles for the chosen place at the time the page is showing.
function channelTiles(p, t) {
  const fc = chan.fc, past = t <= fc.now, half = (lo, hi) => { const a = interpAt(lo, t), b = interpAt(hi, t); return a == null || b == null ? null : (b - a) / 2; };
  let html = '';
  const wl = interpAt(p.wl, t);
  if (wl == null) html += tile('Water level', '<small>no forecast for this time</small>');
  else {
    const subs = [], h = half(p.wlLo, p.wlHi), nx = chanTurn(p.wl, t);
    if (h != null && h > 0.005) subs.push(`± ${fl(h)} ${lu()} (95%)`);
    if (nx) subs.push(`${nx.type} ${fl(nx.v)} ${lu()} ${whenText(nx.t, t)}`);
    html += tile('Water level · ' + (past ? (p.gauge ? 'observed' : 'from gauges') : 'forecast'), `${fl(wl)} <small>${lu()} MLLW</small>`, subs);
  }
  const cu = interpAt(p.cur, t);
  if (cu == null) html += tile('Current', p.cur.length ? '<small>no forecast for this time</small>' : '<small>no forecast here</small>');
  else {
    const subs = [], h = half(p.curLo, p.curHi), sl = chanSlack(p.cur, t);
    if (h != null && h > 0.005) subs.push(`± ${fs(h)} ${su()} (95%)`);
    if (sl) subs.push('slack ' + whenText(sl, t));
    html += tile('Current · ' + (past ? 'from water level' : 'forecast'), curText(cu), subs, curLv(cu));
  }
  const w = chanWind(p, t);
  if (!w) html += tile('Wind', '<small>no forecast</small>');
  else if (w.src === 'obs') html += tile('Wind · observed', `${fw(w.v)} <small>${su()} ${w.dir}</small>`, [w.gust ? 'gust ' + fw(w.gust) : '', 'at ' + w.at], w.level, w.t);
  else html += tile('Wind · forecast', `${fw(w.v)} <small>${su()} ${w.dir || ''}</small>`, ['NWS forecast'], w.level);
  return html;
}

function renderChannel() {
  const el = document.getElementById('chan');
  if (!el) return;
  const fc = chan.fc;
  el.hidden = !fc;
  if (!fc) return;
  renderChannelMap();
  const min = state.hidden.has('chan');
  el.classList.toggle('min', min);
  document.getElementById('chanfull').hidden = min;
  document.getElementById('chanmin').hidden = !min;
  if (min) return;

  // in Transit the card shows this place at the time the ship passes it, if it is on the leg
  const P = fc.points, p = P[chan.sel], eta = state.mode === 'transit' ? trTimeAt(kmPos(p.km)) : null, t = eta == null ? viewTime() : eta;
  const slider = document.getElementById('chankm');
  slider.max = P.length - 1; slider.value = chan.sel;
  const ageH = (state.now - fc.made) / HOUR;
  document.getElementById('chanmeta').textContent = `Experimental · NOAA model run ${fc.cycle.replace('Z', ' UTC')} · built ${fmtDayTime.format(fc.made)} ${tzAbbr(fc.made)}` + (ageH > 30 ? ' · OUT OF DATE' : '');

  const host = document.getElementById('chancard');
  host.innerHTML = '';
  const pl = placeParts(p), open = chan.open;
  const card = document.createElement('div');
  card.className = 'card' + (open ? ' sel' : '');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-expanded', open);
  card.innerHTML = `<div class="chead"><div class="cname">${pl.dist} from the sea entrance</div><div class="cwhere">${pl.near}${state.mode === 'transit' ? (eta == null ? ' · off route' : ` · <b>ETA ${clock(eta)}</b>`) : ''}</div></div>` + channelTiles(p, t) +
    `<div class="cctl"><span class="chev" title="${open ? 'Close charts' : 'Open charts'}">${open ? '▾' : '▸'}<small>${open ? 'close' : 'charts'}</small></span>` +
    '<button type="button" class="minbtn" title="Minimize the channel forecast" aria-label="Minimize the channel forecast">–</button></div>';
  const toggle = () => { chan.open = !chan.open; store('sr-chan-open', chan.open ? '1' : ''); renderChannel(); };
  card.addEventListener('click', toggle);
  card.addEventListener('keydown', e => { if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } });
  card.querySelector('.minbtn').addEventListener('click', e => { e.stopPropagation(); setHidden('chan', true); });
  host.appendChild(card);
  if (!open) return;

  const dr = document.createElement('div');
  dr.className = 'drawer';
  host.appendChild(dr);
  // One plain note. The wording changes only where the standard text would be untrue: at a gauge, and above 30 km
  // where no current is given.
  const what = p.cur.length ? 'Water level and currents here are' : 'Water level here is';
  const note = (p.gauge ? `${what} the forecast for this gauge.`
    : `${what} estimated by blending nearby gauges, then forecast. This results in greater uncertainty compared to locations with gauges.`)
    + (p.cur.length ? '' : ' No current is given this far upriver.') + ' Shaded bands are 95% confidence limits.';
  dr.innerHTML = `<p class="dnote">${note}</p>`;
  const charts = document.createElement('div');
  charts.className = 'charts';
  dr.appendChild(charts);
  const live = isLive(t);
  const base = { t0: Math.max(fc.t0, state.now - 12 * HOUR), t1: fc.t1, now: state.now, mark: live ? null : t, alwaysLegend: true };
  const C1 = 'var(--series-1)', C3 = 'var(--series-3)';   // blue: measured; green: forecast, as on the gauge charts
  const workNote = TH.workable == null ? null : v => (Math.abs(v) < TH.workable ? 'workable' : '');
  const [wa, wb] = splitNow(p.wl, state.now);
  queueChart(chartBox(charts), 'Water level', {
    ...base, unit: lu() + ' MLLW', digits: 2,
    areas: [{ lo: conv(p.wlLo, lenK()), hi: conv(p.wlHi, lenK()), color: C3 }],
    series: [{ name: p.gauge ? 'Observed' : 'From gauges either side', color: C1, points: conv(wa, lenK()) }, { name: 'Forecast', color: C3, points: conv(wb, lenK()), dashed: true }]
  });
  if (p.cur.length) {
    const [ca, cb] = splitNow(p.cur, state.now);
    queueChart(chartBox(charts), 'Current, flood + / ebb −', {
      ...base, unit: su(), digits: 2, zeroLine: true, thresholds: limitLines('current', spdK(), true), ...statusOpts(p.cur, curLv, workNote),
      areas: [{ lo: conv(p.curLo, spdK()), hi: conv(p.curHi, spdK()), color: C3 }],
      series: [{ name: 'From water level now', color: C3, points: conv(ca, spdK()) }, { name: 'Forecast', color: C3, points: conv(cb, spdK()), dashed: true }]
    });
  }
  flushCharts();
  const about = document.createElement('p');
  about.className = 'muted small';
  about.innerHTML = 'Water level every 500 m along the ship channel: each gauge\'s tide carried between gauges using the shape of NOAA\'s STOFS-3D-Atlantic model, plus the model\'s weather signal and a correction from the live gauges. '
    + 'Current is worked out from that water level with a fit to each NOAA 2023 survey meter and to river flow at Clyo. The orange line on the map is the channel; tap it or use the slider to choose a place. '
    + '<a href="sources.html#channel">More on the method and its tests</a>.';
  dr.appendChild(about);
}

document.getElementById('chankm').addEventListener('input', e => { if (chan.fc) selectChannel(+e.target.value); });
(function () {
  const bar = document.getElementById('chanmin'), show = () => setHidden('chan', false);
  bar.addEventListener('click', show);
  bar.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } });
})();
