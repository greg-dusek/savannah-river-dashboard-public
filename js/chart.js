// Minimal SVG time-series chart: one y-axis, legend, "now" marker, crosshair tooltip (which names a caution or
// alert period under the pointer) and an hourly table view.
// Limits are drawn lightly: a short labeled tick at the right edge marks each limit's level, and a thin
// colored strip under the plot marks the times a limit is passed. All times are US Eastern (EST or EDT).
// opt: { series:[{name, color, points:[[ms,value],...], dashed}], unit, t0, t1, now,
//        thresholds:[{value, label, color}], zeroLine, digits, mark (ms: the time the page is showing),
//        bands:[{t0, t1, level}] caution/alert time spans for the strip, rowStatus(t) -> {level, text} for the table,
//        height (px, default 150), marginRight (px, to line up stacked charts),
//        areas:[{lo:[[ms,value],...], hi:[[ms,value],...], color}] uncertainty bands drawn behind the lines }

const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric' });
const fmtDayTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
const fmtHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
const fmtZone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
// 'EST' or 'EDT' at time t
const tzAbbr = t => fmtZone.formatToParts(t).find(p => p.type === 'timeZoneName').value;
const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function niceTicks(lo, hi, n) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function nearest(points, t) {
  if (!points.length) return null;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid][0] < t) lo = mid; else hi = mid; }
  return Math.abs(points[lo][0] - t) <= Math.abs(points[hi][0] - t) ? points[lo] : points[hi];
}

// Room needed at the right of a chart for its limit labels. Stacked charts share the largest, so their time axes line up.
const chartRightMargin = opt => ((opt.thresholds || []).length ? 14 + 5.6 * Math.max(...opt.thresholds.map(th => th.label.length)) : 10);

function drawChart(box, title, opt) {
  box.innerHTML = '';
  const digits = opt.digits == null ? 1 : opt.digits;
  const series = opt.series
    .map(s => ({ ...s, points: s.points.filter(p => p[0] >= opt.t0 && p[0] <= opt.t1 && isFinite(p[1])) }))
    .filter(s => s.points.length);

  const h = document.createElement('h3');
  h.textContent = title + (opt.unit ? ' (' + opt.unit + ')' : '');
  box.appendChild(h);
  const legend = document.createElement('div');
  legend.className = 'legend';
  box.appendChild(legend);
  if (!series.length) { legend.textContent = 'No data available right now.'; return; }
  if (series.length > 1 || opt.alwaysLegend) {
    for (const s of series) {
      const sp = document.createElement('span');
      sp.innerHTML = `<i style="border-color:${s.color};${s.dashed ? 'border-top-style:dashed' : ''}"></i>`;
      sp.append(s.name);
      legend.appendChild(sp);
    }
  }

  const bands = (opt.bands || []).filter(b => b.t1 > opt.t0 && b.t0 < opt.t1);
  for (const [lv, word] of [['caution', 'Caution'], ['alert-hi', 'Alert']]) {
    if (!bands.some(b => b.level === lv)) continue;
    const sp = document.createElement('span');
    sp.innerHTML = `<i class="bandkey ${lv}"></i>`;
    sp.append(word + ' period');
    legend.appendChild(sp);
  }

  const wrap = document.createElement('div');
  wrap.className = 'chart';
  box.appendChild(wrap);
  const W = Math.max(300, Math.round(opt.width || box.clientWidth || 480)), H = opt.height || 150;
  // a lane under the plot for the caution/alert strip, and room at the right for limit labels
  const strip = bands.length ? 7 : 0;
  const m = { l: 40, r: opt.marginRight || chartRightMargin(opt), t: 8, b: 22 + strip };
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title }, wrap);

  const inWin = p => p[0] >= opt.t0 && p[0] <= opt.t1 && isFinite(p[1]);
  const areas = (opt.areas || []).map(a => ({ ...a, lo: a.lo.filter(inWin), hi: a.hi.filter(inWin) })).filter(a => a.lo.length > 1 && a.hi.length > 1);
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const p of s.points) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
  for (const a of areas) { for (const p of a.lo) if (p[1] < lo) lo = p[1]; for (const p of a.hi) if (p[1] > hi) hi = p[1]; }
  const span0 = Math.max(hi - lo, 1);
  for (const th of opt.thresholds || []) {
    // show a threshold only when the data come reasonably close to it
    if (th.value > hi && th.value - hi < span0 * 0.6) hi = th.value;
    if (th.value < lo && lo - th.value < span0 * 0.6) lo = th.value;
  }
  if (opt.zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = (hi - lo || 1) * 0.08;
  lo -= pad; hi += pad;
  const x = t => m.l + (t - opt.t0) / (opt.t1 - opt.t0) * (W - m.l - m.r);
  const y = v => H - m.b - (v - lo) / (hi - lo) * (H - m.t - m.b);

  for (const b of bands) {
    const xa = x(Math.max(b.t0, opt.t0)), xb = x(Math.min(b.t1, opt.t1));
    svgEl('rect', { class: 'band ' + b.level, x: xa, y: H - m.b + 2, width: Math.max(2, xb - xa), height: strip - 2, rx: 1 }, svg);
  }
  const axis = svgEl('g', { class: 'axis' }, svg);
  for (const v of niceTicks(lo, hi, 4)) {
    svgEl('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, axis);
    svgEl('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, axis).textContent = v;
  }
  // label every 6, 12 or 24 hours, whichever keeps the labels at least 62 px apart
  const pxPerHour = (W - m.l - m.r) / ((opt.t1 - opt.t0) / 36e5);
  const stepH = [6, 12, 24].find(h => h * pxPerHour >= 62 && (h > 6 || (opt.t1 - opt.t0) / 36e5 <= 30)) || 24;
  // labels sit on Eastern clock hours (midnight, 6 AM, noon, 6 PM), whatever the UTC offset
  for (let t = Math.ceil(opt.t0 / 36e5) * 36e5; t <= opt.t1; t += 36e5) {
    if (+fmtHour.format(t) % stepH) continue;
    svgEl('line', { class: 'gridline', x1: x(t), x2: x(t), y1: H - m.b, y2: H - m.b + 3 }, axis);
    const edge = x(t) > W - 30; // keep the last label inside the chart
    svgEl('text', { x: edge ? W - 2 : x(t), y: H - 6, 'text-anchor': edge ? 'end' : 'middle' }, axis).textContent = fmtDay.format(t).replace(',', '');
  }
  if (opt.zeroLine) svgEl('line', { class: 'zero', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }, svg);

  // limit labels are nudged apart where two limits sit closer than a line of text
  const shown = (opt.thresholds || []).filter(th => th.value >= lo && th.value <= hi).map(th => ({ th, ly: y(th.value) })).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < shown.length; i++) if (shown[i].ly - shown[i - 1].ly < 11) shown[i].ly = shown[i - 1].ly + 11;
  for (const { th, ly } of shown) {
    svgEl('line', { class: 'thtick', stroke: th.color, x1: W - m.r - 10, x2: W - m.r + 4, y1: y(th.value), y2: y(th.value) }, svg);
    svgEl('text', { class: 'thlabel', x: W - m.r + 7, y: ly + 3.5 }, svg).textContent = th.label;
  }

  if (opt.now >= opt.t0 && opt.now <= opt.t1) {
    svgEl('line', { class: 'nowline', x1: x(opt.now), x2: x(opt.now), y1: m.t, y2: H - m.b }, svg);
    svgEl('text', { class: 'thlabel', x: x(opt.now) + 3, y: m.t + 9 }, svg).textContent = 'now';
  }

  if (opt.mark && opt.mark >= opt.t0 && opt.mark <= opt.t1) {
    svgEl('line', { class: 'markline', x1: x(opt.mark), x2: x(opt.mark), y1: m.t, y2: H - m.b }, svg);
    svgEl('text', { class: 'thlabel', x: x(opt.mark) + 3, y: m.t + 20 }, svg).textContent = fmtTime.format(opt.mark);
  }

  for (const a of areas) {
    const d = a.hi.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join('')
      + a.lo.slice().reverse().map(p => 'L' + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join('') + 'Z';
    svgEl('path', { d, fill: a.color, 'fill-opacity': 0.16, stroke: 'none' }, svg);
  }

  for (const s of series) {
    let d = '', prev = null;
    for (const p of s.points) {
      const gap = prev && p[0] - prev[0] > 90 * 6e4; // break the line across outages
      d += (prev && !gap ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1);
      prev = p;
    }
    svgEl('path', {
      d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round',
      'stroke-dasharray': s.dashed ? '5 4' : ''
    }, svg);
  }

  // hover layer
  const cross = svgEl('line', { class: 'nowline', y1: m.t, y2: H - m.b, visibility: 'hidden', style: 'stroke-dasharray:none' }, svg);
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  wrap.appendChild(tip);
  const hit = svgEl('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }, svg);
  const move = ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width * W;
    const t = opt.t0 + (px - m.l) / (W - m.l - m.r) * (opt.t1 - opt.t0);
    let html = '<b>' + fmtDayTime.format(t) + '</b>';
    // say so when the time under the pointer is in a caution or alert period
    const st = bands.find(b => t >= b.t0 && t < b.t1);
    if (st) html += ` <span class="tipst ${st.level}">${st.level === 'alert-hi' ? 'Alert' : 'Caution'}</span>`;
    for (const s of series) {
      const p = nearest(s.points, t);
      if (p && Math.abs(p[0] - t) < 45 * 6e4) {
        html += `<br><i style="background:${s.color}"></i>${s.name}: ${p[1].toFixed(digits)} ${opt.unit || ''}`;
      }
    }
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = html; tip.hidden = false;
    const left = px / W * r.width;
    tip.style.left = left > r.width / 2 ? '' : left + 10 + 'px';
    tip.style.right = left > r.width / 2 ? r.width - left + 10 + 'px' : '';
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });

  // table view
  const det = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = 'Hourly table';
  det.appendChild(sum);
  det.addEventListener('toggle', () => {
    if (!det.open || det.querySelector('table')) return;
    const st = opt.rowStatus;
    let rows = '<tr><th>Time</th>' + series.map(s => `<th>${s.name}</th>`).join('') + (st ? '<th>Status</th>' : '') + '</tr>';
    for (let t = Math.ceil(opt.t0 / 36e5) * 36e5; t <= opt.t1; t += 36e5) {
      const cells = series.map(s => {
        const p = nearest(s.points, t);
        return '<td>' + (p && Math.abs(p[0] - t) <= 30 * 6e4 ? p[1].toFixed(digits) : '') + '</td>';
      });
      if (!cells.some(c => c !== '<td></td>')) continue;
      const r = st ? st(t) : null;
      rows += `<tr class="${r && r.level ? 'r-' + r.level : ''}"><td>${fmtDayTime.format(t)}</td>${cells.join('')}${r ? '<td>' + r.text + '</td>' : ''}</tr>`;
    }
    const tb = document.createElement('table');
    tb.innerHTML = rows;
    det.appendChild(tb);
  });
  box.appendChild(det);
}
