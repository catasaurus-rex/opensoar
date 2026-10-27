// OpenSoar web — screens, GPS, map, voice, recording, logbook.
'use strict';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('opensoar.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('opensoar.' + k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem('opensoar.' + k); } catch { /* ignore */ } },
};

const DEFAULT_CHECKLIST = `# Pilot
Helmet, radio and headset on
Reserve pin and handle checked
Harness buckles and leg straps closed
# Motor
Fuel cap tight, no leaks
Prop and cage secure
Throttle and kill switch tested
# Wing
Lines clear, risers untwisted
Carabiners locked
# Field
Wind checked, launch path clear
Landing options known`;

const DEFAULTS = {
  pilot: 'Pilot', wing: '', glideRatio: 6, trimKmh: 38, contact: '', tank: 12, fuelLoaded: 12,
  burnLph: 4, reserveMin: 15, altUnit: 'm', spdUnit: 'kmh', voice: 'normal', checklist: DEFAULT_CHECKLIST, theme: 'sun',
};
let S = Object.assign({}, DEFAULTS, store.get('settings', {}));
const saveSettings = () => store.set('settings', S);

// ── Formatting ───────────────────────────────────────────────────────────
const SPD = { kmh: [3.6, 'km/h', 1000, 'km'], mph: [2.23694, 'mph', 1609.344, 'mi'], kt: [1.94384, 'kt', 1852, 'nm'] };
const fmt = {
  alt: (m) => Math.round(S.altUnit === 'ft' ? m * 3.28084 : m).toLocaleString('en'),
  altUnit: () => S.altUnit,
  spd: (ms) => String(Math.round(ms * SPD[S.spdUnit][0])),
  spdUnit: () => SPD[S.spdUnit][1],
  dist: (m) => { const d = m / SPD[S.spdUnit][2]; return d < 10 ? d.toFixed(1) : String(Math.round(d)); },
  distUnit: () => SPD[S.spdUnit][3],
  vario: (ms) => {
    if (S.altUnit === 'ft') { const f = Math.round(ms * 196.85 / 10) * 10; return f === 0 ? '0' : (f > 0 ? '+' : '') + f; }
    const v = ms.toFixed(1); return v === '-0.0' || v === '0.0' ? '0.0' : (ms > 0 ? '+' : '') + v;
  },
  varioUnit: () => (S.altUnit === 'ft' ? 'ft/min' : 'm/s'),
  minutes: (min) => { const m = Math.round(min), a = Math.abs(m), sign = m < 0 ? '-' : ''; return a < 60 ? `${sign}${a} min` : `${sign}${Math.floor(a / 60)} h ${String(a % 60).padStart(2, '0')}`; },
  hm: (s) => { const m = Math.floor(s / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; },
  litres: (l) => l.toFixed(1),
  compass: (d) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.floor((((d % 360) + 360) % 360 + 22.5) / 45) % 8],
};

// ── Small UI helpers ─────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function setTheme(theme) {
  S.theme = theme; saveSettings();
  document.body.dataset.theme = theme;
  document.body.classList.toggle('night-map', theme === 'night');
  document.querySelector('meta[name=theme-color]').content = theme === 'night' ? '#000000' : '#ffffff';
  const reach = getComputedStyle(document.body).getPropertyValue('--reach').trim();
  if (reachCircle) reachCircle.setStyle({ color: reach, fillColor: reach });
}

// ── Voice ────────────────────────────────────────────────────────────────
const voice = {
  say(text, urgent = false) {
    if (S.voice === 'off' || !('speechSynthesis' in window)) return;
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.rate = 1; u.lang = navigator.language || 'en';
    speechSynthesis.speak(u);
  },
};
const LEVEL = { off: 0, less: 1, normal: 2, more: 3 };

/** Speaks once per event, like Callouts.kt on Android. */
const callouts = {
  reset(st) { Object.assign(this, { flightStart: st.start, reserveSoon: false, reserve: false, sun30: false, sun10: false, fuelPromptAt: st.t, lastReports: 0, homeWasIn: false, homeOutSince: 0, homeWarned: false, lastH: null, lastHAt: 0 }); },
  update(st) {
    const lvl = LEVEL[S.voice];
    if (!st.flying || lvl === 0) return;
    if (st.start !== this.flightStart) this.reset(st);
    const now = st.t, f = st.fuel;
    if (f) {
      if (f.toReserve <= 0 && !this.reserve) { this.reserve = true; voice.say('Fuel reserve. Turn for home.', true); }
      else if (f.toReserve <= 10 && !this.reserveSoon && !this.reserve) { this.reserveSoon = true; voice.say('Ten minutes to fuel reserve.'); }
      if (st.fuelReports.length !== this.lastReports) { this.lastReports = st.fuelReports.length; this.fuelPromptAt = now; }
      const every = lvl === 3 ? 20 * 60000 : lvl === 2 ? 30 * 60000 : Infinity;
      if (now - this.fuelPromptAt > every) { this.fuelPromptAt = now; voice.say(`Fuel check. Estimated ${fmt.minutes(f.endurance)} left.`); }
    }
    if (st.sunset) {
      const min = (st.sunset - now) / 60000;
      if (min >= 0 && min <= 30 && !this.sun30) { this.sun30 = true; voice.say(`Sunset in ${Math.floor(min)} minutes.`); }
      if (min >= 0 && min <= 10 && !this.sun10) { this.sun10 = true; voice.say(`Sunset in ${Math.floor(min)} minutes. Time to land.`, true); }
    }
    if (lvl >= 2 && st.homeInfo && st.reach) {
      if (st.homeInfo.inReach) { this.homeWasIn = true; this.homeOutSince = 0; this.homeWarned = false; }
      else if (this.homeWasIn) {
        this.homeOutSince = this.homeOutSince || now;
        if (!this.homeWarned && now - this.homeOutSince > 30000) { this.homeWarned = true; voice.say('Home is out of glide reach.'); }
      }
    }
    if (lvl === 3) {
      const h = fc.agl();
      const step = S.altUnit === 'ft' ? 200 / 3.28084 : 50;
      if (h != null && (this.lastH == null || (Math.abs(h - this.lastH) >= step && now - this.lastHAt > 15000))) {
        this.lastH = h; this.lastHAt = now; voice.say(`Height ${fmt.alt(h).replace(/,/g, '')}`);
      }
    }
  },
};

// ── Flight computer ──────────────────────────────────────────────────────
const fc = new FlightComputer(() => S, onFlightEvent);

function onFlightEvent(type, data) {
  if (type === 'takeoff') {
    voice.say('Takeoff detected. Have a good flight.');
    toast('Takeoff detected, recording');
    setFollow(true);
  } else if (type === 'landed') {
    const { entry, fuelLeft } = data;
    saveFlight(entry);
    if (fuelLeft != null) { S.fuelLoaded = Math.max(0, Math.round(fuelLeft * 2) / 2); saveSettings(); }
    store.del('inflight');
    const m = Math.round(entry.duration / 60);
    voice.say(`Landed. Flight time ${m >= 60 ? Math.floor(m / 60) + ' hours ' + (m % 60) + ' minutes' : m + ' minutes'}.`);
    toast('Landed. Flight saved to the logbook.');
    renderLogbook();
  }
}

// ── Logbook storage (tracks packed as integers to fit browser storage) ──
function pack(entry) {
  const t0 = entry.start;
  return Object.assign({}, entry, { rec: entry.rec.map((p) => [Math.round((p.t - t0) / 1000), Math.round(p.lat * 1e6), Math.round(p.lon * 1e6), Math.round(p.alt)]) });
}
function unpack(e) {
  return Object.assign({}, e, { rec: (e.rec || []).map((r) => ({ t: e.start + r[0] * 1000, lat: r[1] / 1e6, lon: r[2] / 1e6, alt: r[3] })) });
}
function saveFlight(entry) {
  const log = store.get('logbook', []);
  log.unshift(pack(entry));
  if (!store.set('logbook', log)) {
    // Storage full: keep the summary and drop the oldest tracks.
    for (let i = log.length - 1; i > 0 && !store.set('logbook', log); i--) log[i].rec = [];
    toast('Phone storage is nearly full: older tracks were trimmed. Export flights you want to keep.');
  }
}

// Survive a reload or crash mid-flight: snapshot every 15 s.
setInterval(() => {
  const st = fc.st;
  if (!st.flying || simRunning) return;
  store.set('inflight', pack({ id: st.start, start: st.start, duration: st.duration, maxAlt: st.maxAlt, maxAgl: st.maxAgl,
    distance: st.distance, fuelUsed: st.fuel ? Math.max(0, st.fuelAtLaunch - st.fuel.left) : null, wing: S.wing, pilot: S.pilot,
    rec: st.rec, marks: st.marks, home: st.home, recovered: true }));
}, 15000);

function recoverInflight() {
  const e = store.get('inflight', null);
  if (!e) return;
  const log = store.get('logbook', []);
  if (!log.some((x) => x.id === e.id)) { log.unshift(e); store.set('logbook', log); toast('Recovered an unfinished flight into the logbook.'); }
  store.del('inflight');
}

// ── Map ──────────────────────────────────────────────────────────────────
let map, own, ownEl, homeMk, trackLine, homeLine, reachCircle, markLayer, follow = true;

function initMap(lat, lon) {
  map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 5, maxZoom: 17 }).setView([lat, lon], 14);
  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc', crossOrigin: true,
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
  }).addTo(map);
  const css = getComputedStyle(document.body);
  const reach = css.getPropertyValue('--reach').trim();
  reachCircle = L.circle([lat, lon], { radius: 1, color: reach, weight: 3, fillColor: reach, fillOpacity: 0.14, interactive: false });
  trackLine = L.polyline([], { color: '#0a4fc2', weight: 4, opacity: 0.9, interactive: false }).addTo(map);
  homeLine = L.polyline([], { color: '#0a4fc2', weight: 3, dashArray: '10 8', interactive: false });
  markLayer = L.layerGroup().addTo(map);
  homeMk = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="home-marker"><svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7M6 10v9h12v-9"/></svg></div>', iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false });
  own = L.marker([lat, lon], { icon: L.divIcon({ className: 'own-marker', html: '<svg viewBox="0 0 24 24"><path d="M12 2l7.5 18L12 16l-7.5 4z"/></svg>', iconSize: [40, 40], iconAnchor: [20, 20] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
  ownEl = () => own.getElement() && own.getElement().querySelector('svg');
  map.on('dragstart', () => setFollow(false));
}

function setFollow(on) {
  follow = on;
  $('followBtn').classList.toggle('on', on);
  if (on && fc.st.fix && map) centreOn(fc.st.lat, fc.st.lon);
}

/** Centre on you, nudged up when the preflight sheet covers the lower part of the map. */
function centreOn(lat, lon) {
  const sheet = $('ground');
  const offset = sheet.hidden ? 0 : sheet.offsetHeight / 2;
  const p = map.project([lat, lon], map.getZoom()).add([0, offset]);
  map.panTo(map.unproject(p, map.getZoom()), { animate: false });
}

function updateMap() {
  const st = fc.st;
  if (!st.fix) return;
  if (!map) initMap(st.lat, st.lon);
  own.setLatLng([st.lat, st.lon]);
  const el = ownEl(); if (el) el.style.transform = `rotate(${st.trk || 0}deg)`;
  if (follow) centreOn(st.lat, st.lon);

  trackLine.setLatLngs(st.flying ? st.track.map((p) => [p.lat, p.lon]) : []);
  if (st.home && st.flying) {
    homeMk.setLatLng([st.home.lat, st.home.lon]).addTo(map);
    const out = st.homeInfo && st.reach && !st.homeInfo.inReach;
    homeLine.setLatLngs([[st.lat, st.lon], [st.home.lat, st.home.lon]]).setStyle({ color: out ? '#b26a00' : '#0a4fc2' }).addTo(map);
  } else { homeMk.remove(); homeLine.remove(); }
  if (st.reach) reachCircle.setLatLng([st.reach.lat, st.reach.lon]).setRadius(st.reach.radius).addTo(map);
  else reachCircle.remove();
  if (markLayer.getLayers().length !== st.marks.length) {
    markLayer.clearLayers();
    st.marks.forEach((m) => L.circleMarker([m.lat, m.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#7a4600', fillOpacity: 1 }).addTo(markLayer));
  }
}

// ── Rendering ────────────────────────────────────────────────────────────
let showMsl = false;

function topAlert(st) {
  const f = st.fuel, sun = st.sunset ? (st.sunset - Date.now()) / 60000 : null;
  if (!st.fix) return ['Searching for GPS…', 'warn'];
  if (st.fix && st.acc > 50) return [`Weak GPS (±${Math.round(st.acc)} m)`, 'warn'];
  if (st.flying && f && f.toReserve <= 0) return ['Fuel reserve: turn for home', 'danger'];
  if (st.flying && sun != null && sun < 0) return ['After sunset: land now', 'danger'];
  if (st.flying && sun != null && sun < 10) return [`Sunset in ${Math.round(sun)} min: land soon`, 'danger'];
  if (st.flying && st.homeInfo && st.reach && !st.homeInfo.inReach) return ['Home is outside engine-out reach', 'warn'];
  return null;
}

function render() {
  const st = fc.st;
  const flying = !!st.flying;
  $('flight').hidden = !flying || currentTab !== 'fly';
  $('ground').hidden = flying || currentTab !== 'fly';
  updateMap();
  if (flying) renderFlight(st); else renderGround(st);
  callouts.update(st);
}

function renderFlight(st) {
  const agl = fc.agl();
  const msl = showMsl || agl == null;
  $('altLbl').textContent = msl ? 'ALTITUDE' : st.groundElev != null ? 'ABOVE GROUND' : 'ABOVE TAKEOFF';
  $('altVal').textContent = fmt.alt(msl ? st.alt : agl);
  $('altUnit').textContent = fmt.altUnit();
  $('altSub').textContent = msl ? (agl != null ? `${fmt.alt(agl)} ${fmt.altUnit()} above ground` : '') : `${fmt.alt(st.alt)} ${fmt.altUnit()} altitude`;
  $('spdVal').textContent = fmt.spd(st.gs);
  $('spdUnit').textContent = fmt.spdUnit();
  $('windSub').textContent = st.wind ? `Wind ${fmt.spd(st.wind.speed)} ${fmt.compass(st.wind.from)}` : 'Wind --';
  const v = st.vario;
  const varEl = $('varVal'); varEl.textContent = fmt.vario(v);
  varEl.style.color = v > 0.2 ? 'var(--climb)' : v < -0.2 ? 'var(--sink)' : '';
  $('varUnit').textContent = fmt.varioUnit();

  const f = st.fuel;
  const fuelEl = $('fuelVal');
  fuelEl.textContent = f ? fmt.minutes(f.endurance) : '--';
  fuelEl.style.color = !f ? '' : f.toReserve <= 0 ? 'var(--danger)' : f.toReserve < 10 ? 'var(--warn)' : '';
  $('fuelSub').textContent = f ? `${fmt.litres(f.left)} L${f.measured ? ' · measured' : ''}` : '';

  const h = st.homeInfo;
  $('homeVal').textContent = h ? fmt.dist(h.dist) : '--';
  $('homeUnit').textContent = fmt.distUnit();
  $('homeArrow').style.transform = h ? `rotate(${h.brg - (st.trk || 0)}deg)` : '';
  $('homeArrow').style.visibility = h ? 'visible' : 'hidden';
  const homeSub = $('homeSub');
  homeSub.textContent = !h ? '' : h.dist < 150 ? 'Overhead' : h.eta == null ? 'No headway' : h.eta < 60 ? '< 1 min back' : `${fmt.minutes(h.eta / 60)} back`;
  homeSub.style.color = h && h.eta != null && f && h.eta / 60 > f.toReserve ? 'var(--danger)' : '';

  $('timeVal').textContent = fmt.minutes((st.duration || 0) / 60);
  const sun = st.sunset ? (Date.now() > st.sunset ? -1 : (st.sunset - Date.now()) / 60000) : null;
  const sunEl = $('sunSub');
  sunEl.textContent = sun == null ? '' : sun < 0 ? 'After sunset' : `Sunset ${fmt.minutes(sun)}`;
  sunEl.style.color = sun == null ? '' : sun < 10 ? 'var(--danger)' : sun < 30 ? 'var(--warn)' : '';

  const a = topAlert(st), al = $('alert');
  if (a) { al.textContent = a[0]; al.className = 'alert ' + a[1]; al.hidden = false; } else al.hidden = true;
}

function renderGround(st) {
  const ok = st.fix && st.acc <= 30;
  $('gpsDot').classList.toggle('ok', ok);
  $('gpsTitle').textContent = !st.fix ? 'Waiting for GPS' : ok ? 'Ready to fly' : 'GPS still settling';
  $('gpsSub').textContent = !st.fix ? 'Go outside with a clear view of the sky.' : ok ? `GPS ±${Math.round(st.acc)} m. Takeoff is detected automatically.` : `GPS ±${Math.round(st.acc)} m. Give it a minute in the open.`;
  $('gAlt').textContent = st.fix ? fmt.alt(st.alt) : '--';
  $('gAltUnit').textContent = `${fmt.altUnit()} altitude`;
  $('gFuel').textContent = `${fmt.litres(S.fuelLoaded)} L`;
  const f = st.fuel || fc.fuelInfo(S);
  $('gEndurance').textContent = `≈ ${fmt.minutes(f.endurance)} at ${fmt.litres(f.burn)} L/h`;
}

// ── Checklist ────────────────────────────────────────────────────────────
let checked = new Set();
function renderChecklist() {
  const box = $('checklist'); box.textContent = '';
  let total = 0, sec = '';
  for (const raw of S.checklist.split('\n')) {
    const line = raw.trim(); if (!line) continue;
    if (line.startsWith('#')) { sec = line.slice(1).trim(); const h = document.createElement('div'); h.className = 'check-sec'; h.textContent = sec; box.append(h); continue; }
    total++;
    const key = sec + '/' + line, b = document.createElement('button');
    b.className = 'check' + (checked.has(key) ? ' done' : '');
    b.innerHTML = '<span class="box"></span><span></span>'; b.lastChild.textContent = line;
    b.onclick = () => { checked.has(key) ? checked.delete(key) : checked.add(key); renderChecklist(); };
    box.append(b);
  }
  const done = [...checked].length;
  $('checkCount').textContent = `${done} / ${total}`;
  $('checkCount').style.color = done === total && total ? 'var(--climb)' : '';
}

// ── Logbook screen ───────────────────────────────────────────────────────
function renderLogbook() {
  const log = store.get('logbook', []);
  const tot = log.reduce((a, e) => ({ s: a.s + e.duration, d: a.d + e.distance }), { s: 0, d: 0 });
  $('totals').innerHTML = `<div class="stat"><span>Flights</span><b>${log.length}</b></div><div class="stat"><span>Airtime</span><b>${fmt.hm(tot.s)}</b></div><div class="stat"><span>Distance</span><b>${fmt.dist(tot.d)} ${fmt.distUnit()}</b></div>`;
  const list = $('flights'); list.textContent = '';
  if (!log.length) { list.innerHTML = '<div class="empty"><b>Your flights land here</b><br>Every flight is recorded automatically from takeoff to landing.</div>'; return; }
  for (const e of log) {
    const d = new Date(e.start);
    const card = document.createElement('div'); card.className = 'flight';
    card.innerHTML = `<h4></h4><div class="stats">
      <div class="stat"><span>Time</span><b>${fmt.hm(e.duration)}</b></div>
      <div class="stat"><span>Max height</span><b>${fmt.alt(e.maxAgl || 0)} ${fmt.altUnit()}</b></div>
      <div class="stat"><span>Distance</span><b>${fmt.dist(e.distance)} ${fmt.distUnit()}</b></div></div>
      <div class="muted"></div><div class="row"><button class="igc">IGC</button><button class="gpx">GPX</button><button class="del">Delete</button></div>`;
    card.querySelector('h4').textContent = d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + (e.recovered ? ' · recovered' : '');
    card.querySelector('.muted').textContent = [e.wing, e.fuelUsed != null ? `Fuel used ≈ ${fmt.litres(e.fuelUsed)} L` : '', e.measuredBurn ? `measured ${fmt.litres(e.measuredBurn)} L/h` : ''].filter(Boolean).join(' · ');
    const name = `OpenSoar_${d.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
    card.querySelector('.igc').onclick = () => shareFile(`${name}.igc`, buildIgc(unpack(e)), 'application/octet-stream');
    card.querySelector('.gpx').onclick = () => shareFile(`${name}.gpx`, buildGpx(unpack(e)), 'application/gpx+xml');
    const del = card.querySelector('.del');
    del.onclick = () => {
      if (del.dataset.armed) { store.set('logbook', store.get('logbook', []).filter((x) => x.id !== e.id)); renderLogbook(); }
      else { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete'; }, 3000); }
    };
    list.append(card);
  }
}

async function shareFile(name, text, type) {
  if (NativeSensors) {
    try { await NativeSensors.shareFile({ name, text }); } catch (e) { toast(`Couldn't share: ${e.message || e}`); }
    return;
  }
  const file = new File([text], name, { type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ── Settings screen ──────────────────────────────────────────────────────
const FIELDS = ['pilot', 'wing', 'glideRatio', 'trimKmh', 'contact', 'tank', 'burnLph', 'reserveMin', 'altUnit', 'spdUnit', 'voice', 'checklist'];
function loadSettingsForm() { for (const k of FIELDS) $('s-' + k).value = S[k]; }
$('settingsForm').addEventListener('input', (ev) => {
  const k = ev.target.id.replace('s-', '');
  if (!FIELDS.includes(k)) return;
  const el = ev.target;
  if (el.type === 'number') { const v = parseFloat(el.value); if (isNaN(v)) return; S[k] = Math.min(+el.max || v, Math.max(+el.min || v, v)); }
  else S[k] = el.value;
  if (k === 'tank') S.fuelLoaded = Math.min(S.fuelLoaded, S.tank);
  if (k === 'checklist') { checked = new Set(); renderChecklist(); }
  saveSettings(); render();
});
$('settingsForm').addEventListener('submit', (e) => e.preventDefault());

// ── Tabs ─────────────────────────────────────────────────────────────────
let currentTab = 'fly';
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  currentTab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('logbook').hidden = currentTab !== 'logbook';
  $('settings').hidden = currentTab !== 'settings';
  if (currentTab === 'logbook') renderLogbook();
  if (currentTab === 'settings') loadSettingsForm();
  render();
  if (currentTab === 'fly' && map) setTimeout(() => map.invalidateSize(), 50);
}));

// ── Buttons ──────────────────────────────────────────────────────────────
$('topCard').onclick = () => { showMsl = !showMsl; render(); };
$('followBtn').onclick = () => setFollow(true);
$('themeBtn').onclick = () => setTheme(S.theme === 'night' ? 'sun' : 'night');
$('markBtn').onclick = () => { fc.mark(); toast('Spot marked'); render(); };
$('startFlight').onclick = () => { if (!fc.st.fix) { toast('Waiting for GPS first'); return; } fc.startManually(); render(); };
$('fuelMinus').onclick = () => { S.fuelLoaded = Math.max(0, S.fuelLoaded - 0.5); saveSettings(); fc.derive(S); render(); };
$('fuelPlus').onclick = () => { S.fuelLoaded = Math.min(S.tank, S.fuelLoaded + 0.5); saveSettings(); fc.derive(S); render(); };
$('fuelFull').onclick = () => { S.fuelLoaded = S.tank; saveSettings(); fc.derive(S); render(); };

let dlgFuel = 0;
function openFuel() {
  const st = fc.st;
  dlgFuel = Math.round((st.fuel ? st.fuel.left : S.fuelLoaded) * 2) / 2;
  $('fuelDlgTitle').textContent = st.flying ? 'How much fuel is left?' : 'Fuel loaded';
  $('fuelDlgHint').hidden = !st.flying;
  $('dlgFuel').textContent = `${fmt.litres(dlgFuel)} L`;
  $('fuelDialog').hidden = false;
}
$('fuelBtn').onclick = openFuel; $('fuelCell').onclick = openFuel;
document.querySelectorAll('#fuelDialog .quick button').forEach((b) => b.onclick = () => { dlgFuel = S.tank * +b.dataset.frac; $('dlgFuel').textContent = `${fmt.litres(dlgFuel)} L`; });
$('dlgMinus').onclick = () => { dlgFuel = Math.max(0, dlgFuel - 0.5); $('dlgFuel').textContent = `${fmt.litres(dlgFuel)} L`; };
$('dlgPlus').onclick = () => { dlgFuel = Math.min(S.tank, dlgFuel + 0.5); $('dlgFuel').textContent = `${fmt.litres(dlgFuel)} L`; };
$('fuelCancel').onclick = () => { $('fuelDialog').hidden = true; };
$('fuelSave').onclick = () => {
  if (fc.st.flying) fc.reportFuel(dlgFuel); else { S.fuelLoaded = dlgFuel; saveSettings(); fc.derive(S); }
  $('fuelDialog').hidden = true; toast('Fuel updated'); render();
};

$('helpBtn').onclick = () => {
  const st = fc.st, lat = st.lat?.toFixed(5), lon = st.lon?.toFixed(5);
  const body = `Paramotor pilot ${S.pilot} needs help. Position ${lat}, ${lon} https://maps.google.com/?q=${lat},${lon}`;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $('helpSend').href = `sms:${S.contact.replace(/\s/g, '')}${ios ? '&' : '?'}body=${encodeURIComponent(body)}`;
  $('helpText').textContent = S.contact ? `Opens your messages app with a help message and your position for ${S.contact}. You press send.` : 'Opens your messages app with your position filled in. Add an emergency contact in Settings so it is ready to send.';
  $('helpPos').textContent = `${lat}, ${lon}`;
  $('helpDialog').hidden = false;
};
$('helpCancel').onclick = () => { $('helpDialog').hidden = true; };
$('helpSend').addEventListener('click', () => setTimeout(() => { $('helpDialog').hidden = true; }, 300));

// ── GPS, keep-awake, start ───────────────────────────────────────────────
let started = false, watchId = null, simRunning = false, wakeLock = null;

async function keepAwake() {
  try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch { /* refused: screen may sleep */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && started) keepAwake(); });

function onPosition(pos) {
  if (simRunning) return;
  const c = pos.coords;
  fc.onFix({ t: pos.timestamp || Date.now(), lat: c.latitude, lon: c.longitude, alt: c.altitude, acc: c.accuracy, speed: c.speed, heading: c.heading });
  render();
}

// ── iPhone app: native GPS (works with the screen locked) + barometer ────
const NativeSensors = (() => {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
  return cap.registerPlugin ? cap.registerPlugin('FlightSensors') : cap.Plugins && cap.Plugins.FlightSensors;
})();
let lastNativeT = 0;

function onNativeFix(d) {
  if (simRunning || !d || d.t <= lastNativeT) return;
  lastNativeT = d.t;
  fc.onFix({ t: d.t, lat: d.lat, lon: d.lon, alt: d.alt, acc: d.acc, speed: d.speed, heading: d.heading });
}

async function startNative() {
  await NativeSensors.addListener('location', (d) => { onNativeFix(d); render(); });
  await NativeSensors.addListener('pressure', (d) => { if (!simRunning) fc.onBaro(d.relAlt, d.t); });
  await NativeSensors.addListener('authorization', (d) => {
    if (d.status === 'denied' || d.status === 'restricted') showStartError('Location is off for OpenSoar. Turn it on in Settings → OpenSoar → Location, then reopen the app.');
  });
  const res = await NativeSensors.start();
  if (res && res.barometer) toast('Barometer found: using it for altitude and climb');
  // Coming back from a locked screen: replay the fixes the phone took meanwhile.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const { fixes } = await NativeSensors.drain({ since: lastNativeT });
      (fixes || []).sort((a, b) => a.t - b.t).forEach(onNativeFix);
      render();
    } catch { /* nothing buffered */ }
  });
}

$('startBtn').onclick = () => {
  if (NativeSensors) {
    if ('speechSynthesis' in window) speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(' '), { volume: 0 }));
    started = true;
    $('startScreen').hidden = true;
    startNative().catch((e) => showStartError(`Couldn't start GPS: ${e.message || e}`));
    render();
    return;
  }
  if (!('geolocation' in navigator)) { showStartError('This browser has no GPS access. Try Safari on iPhone or Chrome on Android.'); return; }
  if (!window.isSecureContext) { showStartError('GPS needs a secure (https) link. Open the app from its https address.'); return; }
  // Unlock speech on this tap (iOS only speaks after a user gesture).
  if ('speechSynthesis' in window) speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(' '), { volume: 0 }));
  keepAwake();
  watchId = navigator.geolocation.watchPosition(onPosition, (err) => {
    if (err.code === 1) showStartError('Location is blocked. Allow location for this site in your browser settings, then reload.');
    else toast(err.code === 3 ? 'Still waiting for GPS…' : 'GPS unavailable right now');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  started = true;
  $('startScreen').hidden = true;
  render();
};
function showStartError(msg) { const e = $('startError'); e.textContent = msg; e.hidden = false; $('startScreen').hidden = false; }

// ── Simulator: a scripted flight for ground testing ─────────────────────
$('simBtn').onclick = () => {
  if (simRunning) { toast('Simulation already running'); return; }
  if (!started) { toast('Tap Start instruments first'); return; }
  const startLat = fc.st.fix ? fc.st.lat : -12.53, startLon = fc.st.fix ? fc.st.lon : 131.07;
  simRunning = true; fc.reset();
  document.querySelector('#tabs button[data-tab=fly]').click();
  toast('Simulated flight started: takeoff in about 40 s');
  let lat = startLat, lon = startLon, alt = 100, heading = 270, t = 0, landedFor = 0;
  const groundAlt = 100, WIND = 4;
  const tick = setInterval(() => {
    let air = 0, vario = 0;
    if (t < 25) { air = 0; }
    else if (t < 35) { air = 2 + (t - 25) * 0.6; }
    else if (t < 95) { air = 10; vario = 2; }
    else if (t < 125) { heading = (heading + 6) % 360; air = 11; vario = 0.5; }
    else if (t < 215) { air = 11; }
    else if (t < 245) { heading = (heading + 6) % 360; air = 11; }
    else if (alt > groundAlt + 1) {
      heading = bearing(lat, lon, startLat, startLon);
      const near = haversine(lat, lon, startLat, startLon) < 400;
      air = near ? 8 : 11; vario = near ? -2 : -1;
    } else if (++landedFor > 40) { clearInterval(tick); simRunning = false; toast('Simulation finished'); return; }
    const h = heading * Math.PI / 180;
    const e = air * Math.sin(h) + (air > 0 ? WIND : 0), n = air * Math.cos(h);
    const gs = Math.hypot(e, n), trk = ((Math.atan2(e, n) * 180 / Math.PI) + 360) % 360;
    if (gs > 0.01) { const p = destination(lat, lon, trk, gs); lat = p.lat; lon = p.lon; }
    alt = Math.max(groundAlt, alt + vario);
    fc.onFix({ t: Date.now(), lat, lon, alt, acc: 4, speed: gs, heading: trk });
    render(); t++;
  }, 1000);
};

// ── Boot ─────────────────────────────────────────────────────────────────
if (NativeSensors) {
  $('groundHint').textContent = 'Takeoff and landing are detected automatically. Recording continues with the screen locked; voice alerts and the map need the screen on.';
}
setTheme(S.theme);
recoverInflight();
renderChecklist();
renderLogbook();
setInterval(() => { if (started && fc.st.fix) render(); }, 1000);
if ('serviceWorker' in navigator && window.isSecureContext && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
