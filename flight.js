// OpenSoar web — flight maths. Ported from the Android app's Kotlin
// (algorithms/FlightMath.kt, Sun.kt, WindEstimator.kt, FlightDataManager.kt).
// All inputs SI: metres, m/s, degrees true, epoch ms.
'use strict';

const R_EARTH = 6371000;
const rad = (d) => d * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;

function haversine(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2), dp = rad(lat2 - lat1), dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return norm360(deg(Math.atan2(y, x)));
}

function destination(lat, lon, brg, dist) {
  const d = dist / R_EARTH, t = rad(brg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lon: ((deg(l2) + 540) % 360) - 180 };
}

/** Ground speed along a course at an airspeed in a wind {speed, from}. Null if no headway. */
function groundSpeedAlong(course, airspeed, wind) {
  const rel = rad(wind.from + 180 - course);
  const along = wind.speed * Math.cos(rel), cross = wind.speed * Math.sin(rel);
  if (Math.abs(cross) >= airspeed) return null;
  const gs = along + Math.sqrt(airspeed * airspeed - cross * cross);
  return gs > 0.5 ? gs : null;
}

/**
 * Engine-out glide reach over flat ground: a circle of radius height × L/D,
 * drifted downwind by windSpeed × timeAloft.
 */
function glideReach(lat, lon, height, airspeed, ld, wind) {
  if (!(height > 0 && airspeed > 0 && ld > 0)) return null;
  const timeAloft = height / (airspeed / ld);
  const drift = wind.speed * timeAloft;
  const c = drift > 1 ? destination(lat, lon, norm360(wind.from + 180), drift) : { lat, lon };
  return { lat: c.lat, lon: c.lon, radius: height * ld, timeAloft };
}

/** Sunset (epoch ms) for the solar day nearest now; null in polar day/night. */
function sunsetMs(nowMs, lat, lon) {
  const J2000 = 2451545, jdNow = nowMs / 86400000 + 2440587.5;
  const n0 = Math.floor(jdNow - J2000 + 0.0008);
  let best = null;
  for (const n of [n0 - 1, n0, n0 + 1]) {
    const jStar = n - lon / 360;
    const M = rad((357.5291 + 0.98560028 * jStar) % 360);
    const C = 1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M);
    const L = rad((deg(M) + C + 180 + 102.9372) % 360);
    const transit = J2000 + jStar + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const decl = Math.asin(Math.sin(L) * Math.sin(rad(23.4397)));
    const cosW = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * Math.sin(decl)) / (Math.cos(rad(lat)) * Math.cos(decl));
    const set = cosW < -1 || cosW > 1 ? null : transit + deg(Math.acos(cosW)) / 360;
    if (!best || Math.abs(transit - jdNow) < Math.abs(best.transit - jdNow)) best = { transit, set };
  }
  return best.set == null ? null : Math.round((best.set - 2440587.5) * 86400000);
}

/**
 * Wind + airspeed from ground velocity: every ground vector lies on a circle
 * whose centre is the wind and radius is the airspeed. Needs ~120° of turn.
 */
class WindEstimator {
  constructor() { this.reset(); }
  reset() { this.bins = new Map(); this.wind = null; this.airspeed = null; this.solvedAt = 0; }

  update(gs, track, t) {
    if (gs >= 2 && gs <= 60) {
      const b = Math.floor(norm360(track) / 10);
      const q = this.bins.get(b) || [];
      q.push({ gs, track, t });
      while (q.length > 4) q.shift();
      this.bins.set(b, q);
    }
    for (const [k, q] of this.bins) {
      while (q.length && q[0].t < t - 600000) q.shift();
      if (!q.length) this.bins.delete(k);
    }
    if (this.wind && t - this.solvedAt > 300000) { this.wind = null; this.airspeed = null; }

    const s = [...this.bins.values()].flat();
    if (s.length < 8 || this.fov(s) < 120) return this.wind;
    let pts = s.map((p) => [p.gs * Math.sin(rad(p.track)), p.gs * Math.cos(rad(p.track))]);
    for (let pass = 0; pass < 6; pass++) {
      const f = kasa(pts);
      if (!f) return this.wind;
      const res = pts.map((p) => Math.abs(Math.hypot(p[0] - f.cx, p[1] - f.cy) - f.r) / f.r);
      let wi = 0; res.forEach((r, i) => { if (r > res[wi]) wi = i; });
      if (res[wi] <= 0.35) {
        const ws = Math.hypot(f.cx, f.cy);
        if (f.r < 5 || f.r > 25 || ws > 25) return this.wind;
        this.wind = { speed: ws, from: norm360(deg(Math.atan2(f.cx, f.cy)) + 180) };
        this.airspeed = f.r; this.solvedAt = t;
        return this.wind;
      }
      pts = pts.filter((_, i) => i !== wi);
      if (pts.length < 8) return this.wind;
    }
    return this.wind;
  }

  fov(s) {
    const h = s.map((p) => norm360(p.track)).sort((a, b) => a - b);
    let gap = 360 - h[h.length - 1] + h[0];
    for (let i = 1; i < h.length; i++) gap = Math.max(gap, h[i] - h[i - 1]);
    return 360 - gap;
  }
}

function kasa(pts) {
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (const p of pts) {
    const x = p[0] - mx, y = p[1] - my, z = x * x + y * y;
    sxx += x * x; syy += y * y; sxy += x * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z;
  }
  const sol = solve3([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], [-sxz, -syz, -sz]);
  if (!sol) return null;
  const cx = -sol[0] / 2, cy = -sol[1] / 2, r2 = cx * cx + cy * cy - sol[2];
  return r2 > 0 ? { cx: cx + mx, cy: cy + my, r: Math.sqrt(r2) } : null;
}

function solve3(a, b) {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-9) return null;
    const s = m[c][c]; for (let j = c; j < 4; j++) m[c][j] /= s;
    for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c]; for (let j = c; j < 4; j++) m[r][j] -= f * m[c][j]; }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

/** Drops fixes implying impossible motion; restarts from the newest after 5 rejects. */
class GpsJumpFilter {
  constructor() { this.anchor = null; this.rejects = 0; }
  accept(f) {
    const a = this.anchor;
    if (!a || this.plausible(a, f) || this.rejects >= 5 || f.t - a.t > 10000) {
      this.anchor = f; this.rejects = 0; return true;
    }
    this.rejects++; return false;
  }
  plausible(a, f) {
    const dt = (f.t - a.t) / 1000;
    if (dt <= 0) return false;
    if (haversine(a.lat, a.lon, f.lat, f.lon) / dt > 100) return false;
    if (a.alt != null && f.alt != null && Math.abs(f.alt - a.alt) / dt > 40) return false;
    return true;
  }
}

/**
 * Ground elevation from public Terrarium tiles (AWS Open Data). Tiles are
 * fetched on demand and cached in memory; returns null until available.
 */
class Terrain {
  constructor() { this.tiles = new Map(); this.loading = new Set(); this.failed = false; }
  elevation(lat, lon) {
    if (this.failed) return null;
    const z = 12, n = 2 ** z;
    const x = (lon + 180) / 360 * n;
    const lr = rad(Math.max(-85.05, Math.min(85.05, lat)));
    const y = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n;
    const tx = Math.floor(x), ty = Math.floor(y), key = `${z}/${tx}/${ty}`;
    const px = Math.min(255, Math.floor((x - tx) * 256)), py = Math.min(255, Math.floor((y - ty) * 256));
    const data = this.tiles.get(key);
    if (!data) { this.load(key); return null; }
    const i = (py * 256 + px) * 4;
    const e = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
    return e > -500 && e < 9000 ? e : null;
  }
  async load(key) {
    if (this.loading.has(key)) return;
    this.loading.add(key);
    try {
      const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`, { mode: 'cors' });
      if (!r.ok) throw new Error(r.status);
      const bmp = await createImageBitmap(await r.blob());
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      this.tiles.set(key, g.getImageData(0, 0, 256, 256).data);
      if (this.tiles.size > 12) this.tiles.delete(this.tiles.keys().next().value);
    } catch (e) {
      // Blocked or offline: fall back to height above takeoff for this session.
      if (String(e).includes('TypeError')) this.failed = true;
    } finally { this.loading.delete(key); }
  }
}

/**
 * Takes GPS fixes, decides ground / flying, and derives everything the
 * screen shows. Mirrors FlightDataManager on Android.
 */
class FlightComputer {
  constructor(getSettings, onEvent) {
    this.getSettings = getSettings; this.onEvent = onEvent;
    this.filter = new GpsJumpFilter(); this.windEst = new WindEstimator(); this.terrain = new Terrain();
    this.reset();
  }
  reset() {
    this.st = { fix: false, flying: false, track: [], marks: [], fuelReports: [], vario: 0, hasBaro: false };
    this.groundAlt = null; this.lastStationary = null; this.takeoffScore = 0; this.landingScore = 0;
    this.lastT = 0; this.lastAlt = null; this.lastFix = null; this.sunCalcAt = 0;
    this.baro = null;   // {offset, alt, vario, t, lastRel} when a barometer is feeding us
  }

  /**
   * Barometer input (iPhone app): relative altitude in metres since the
   * sensor started. On the ground we keep pulling the offset towards GPS
   * altitude so baro altitude reads as height above sea level; in flight the
   * offset is frozen, so climb rate comes purely from pressure.
   */
  onBaro(relAlt, t) {
    const st = this.st;
    let b = this.baro;
    if (!b) b = this.baro = { offset: null, alt: null, vario: 0, t, lastRel: relAlt };
    // Only calibrate standing still with a fresh, accurate fix; never against a stale one.
    const goodGps = st.fix && st.acc != null && st.acc < 15 && this.lastFix && this.lastFix.alt != null &&
      Math.abs(t - this.lastFix.t) < 2000 && (st.gs ?? 0) < 1.5;
    if (!st.flying && goodGps) {
      const target = this.lastFix.alt - relAlt;
      b.offset = b.offset == null ? target : b.offset + (target - b.offset) * 0.05;
    }
    if (b.offset == null) { b.lastRel = relAlt; b.t = t; return; }
    const dt = Math.max(0.05, (t - b.t) / 1000);
    const rate = (relAlt - b.lastRel) / dt;
    b.vario += (rate - b.vario) * Math.min(1, dt / 1.5);   // ~1.5 s smoothing
    b.alt = b.offset + relAlt; b.lastRel = relAlt; b.t = t;
    st.hasBaro = true;
  }

  onFix(f) {
    // f: {t, lat, lon, alt, acc, speed, heading}
    if (!this.filter.accept(f)) return;
    const st = this.st, s = this.getSettings();
    const dt = this.lastT ? Math.min(5, Math.max(0.1, (f.t - this.lastT) / 1000)) : 1;
    // Some browsers report no speed/heading: derive them from the last fix.
    let gs = f.speed, trk = f.heading;
    if (this.lastFix && (gs == null || isNaN(gs))) gs = haversine(this.lastFix.lat, this.lastFix.lon, f.lat, f.lon) / dt;
    if (this.lastFix && (trk == null || isNaN(trk)) && gs > 1) trk = bearing(this.lastFix.lat, this.lastFix.lon, f.lat, f.lon);
    gs = gs || 0; trk = trk == null || isNaN(trk) ? (st.trk || 0) : trk;
    this.lastFix = f; this.lastT = f.t;

    // Barometer (when fresh) beats GPS for altitude and climb.
    const b = this.baro, baroFresh = b && b.alt != null && Math.abs(f.t - b.t) < 3000;
    const alt = baroFresh ? b.alt : (f.alt ?? st.alt ?? 0);
    if (baroFresh) st.vario = b.vario;
    else if (this.lastAlt != null) st.vario += (((alt - this.lastAlt) / dt) - st.vario) * 0.3;
    this.lastAlt = alt;

    Object.assign(st, { fix: true, t: f.t, lat: f.lat, lon: f.lon, alt, acc: f.acc, gs, trk });
    st.groundElev = this.terrain.elevation(f.lat, f.lon);

    // ── Phase detection (same rules as Android) ──
    const agl = this.groundAlt != null ? alt - this.groundAlt : st.groundElev != null ? alt - st.groundElev : null;
    if (!st.flying) {
      if (gs < 1.5) {
        this.groundAlt = this.groundAlt == null ? alt : this.groundAlt + (alt - this.groundAlt) * 0.2;
        this.lastStationary = { lat: f.lat, lon: f.lon };
      }
      const goodFix = f.acc != null && f.acc <= 20;
      const movedAway = !this.lastStationary || haversine(this.lastStationary.lat, this.lastStationary.lon, f.lat, f.lon) > 50;
      const climbing = st.vario > 1.4;
      const cand = goodFix && movedAway && gs >= 4 && gs <= 25 && (agl == null ? climbing : agl > 30 || climbing);
      this.takeoffScore = cand ? this.takeoffScore + dt : Math.max(0, this.takeoffScore - dt);
      if (this.takeoffScore >= 15) this.beginFlight(f.t - this.takeoffScore * 1000);
    } else {
      const cand = gs < 1.7 && Math.abs(st.vario) < 0.3 && (agl == null || agl < 100);
      this.landingScore = cand ? this.landingScore + dt : 0;
      if (this.landingScore >= 20) this.finishFlight(f.t);
    }

    if (st.flying) {
      if (this.prevFlyFix) st.distance += haversine(this.prevFlyFix.lat, this.prevFlyFix.lon, f.lat, f.lon);
      this.prevFlyFix = f;
      const lp = st.track[st.track.length - 1];
      if (!lp || haversine(lp.lat, lp.lon, f.lat, f.lon) > 15) st.track.push({ lat: f.lat, lon: f.lon, alt, t: f.t });
      st.rec.push({ t: f.t, lat: f.lat, lon: f.lon, alt });
      st.wind = this.windEst.update(gs, trk, f.t);
      st.airspeed = this.windEst.airspeed;
      st.duration = (f.t - st.start) / 1000;
      st.maxAlt = Math.max(st.maxAlt, alt);
      st.maxAgl = Math.max(st.maxAgl, this.agl() ?? 0);
    }
    if (f.t - this.sunCalcAt > 60000 || st.sunset === undefined) { this.sunCalcAt = f.t; st.sunset = sunsetMs(f.t, f.lat, f.lon); }
    this.derive(s);
  }

  /** Height above the ground under you, else above takeoff. */
  agl() {
    const st = this.st;
    if (st.groundElev != null) return st.alt - st.groundElev;
    if (st.takeoffElev != null) return st.alt - st.takeoffElev;
    return null;
  }

  derive(s) {
    const st = this.st;
    st.fuel = this.fuelInfo(s);
    const wind = st.wind || { speed: 0, from: 0 };
    const h = this.agl();
    st.reach = st.flying && h != null ? glideReach(st.lat, st.lon, h, s.trimKmh / 3.6, s.glideRatio, wind) : null;
    if (st.home && st.fix) {
      const dist = haversine(st.lat, st.lon, st.home.lat, st.home.lon);
      const brg = bearing(st.lat, st.lon, st.home.lat, st.home.lon);
      const gsHome = groundSpeedAlong(brg, st.airspeed || s.trimKmh / 3.6, wind);
      st.homeInfo = { dist, brg, eta: gsHome ? dist / gsHome : null,
        inReach: st.reach ? haversine(st.reach.lat, st.reach.lon, st.home.lat, st.home.lon) <= st.reach.radius : false };
    } else st.homeInfo = null;
  }

  fuelInfo(s) {
    const st = this.st, burnSet = Math.max(0.1, s.burnLph);
    if (!st.flying) {
      const end = s.fuelLoaded / burnSet * 60;
      return { left: s.fuelLoaded, burn: burnSet, measured: false, endurance: end, toReserve: end - s.reserveMin };
    }
    const measured = this.measuredBurn();
    const burn = Math.max(0.1, measured ?? burnSet);
    const last = st.fuelReports[st.fuelReports.length - 1] || { t: st.start, l: st.fuelAtLaunch };
    const left = Math.max(0, last.l - burn * Math.max(0, st.t - last.t) / 3600000);
    const end = left / burn * 60;
    return { left, burn, measured: measured != null, endurance: end, toReserve: end - s.reserveMin };
  }

  measuredBurn() {
    const st = this.st, last = st.fuelReports[st.fuelReports.length - 1];
    if (!last) return null;
    const hrs = (last.t - st.start) / 3600000;
    if (hrs < 0.15) return null;
    const b = (st.fuelAtLaunch - last.l) / hrs;
    return b >= 0.5 && b <= 20 ? b : null;
  }

  beginFlight(startT) {
    const st = this.st, s = this.getSettings();
    this.takeoffScore = 0; this.landingScore = 0; this.prevFlyFix = null; this.windEst.reset();
    Object.assign(st, {
      flying: true, start: startT, duration: 0, distance: 0, maxAlt: st.alt, maxAgl: 0,
      track: [{ lat: st.lat, lon: st.lon, alt: st.alt, t: st.t }], rec: [], marks: [], fuelReports: [],
      home: this.lastStationary || { lat: st.lat, lon: st.lon },
      takeoffElev: this.groundAlt ?? st.groundElev ?? st.alt, fuelAtLaunch: s.fuelLoaded,
    });
    this.onEvent('takeoff', { t: startT });
  }

  finishFlight(endT) {
    const st = this.st, s = this.getSettings();
    this.takeoffScore = 0; this.landingScore = 0;
    const left = st.fuel ? st.fuel.left : null;
    const entry = {
      id: st.start, start: st.start, duration: Math.max(0, (endT - st.start) / 1000),
      maxAlt: st.maxAlt, maxAgl: st.maxAgl, distance: st.distance,
      fuelUsed: left != null ? Math.max(0, st.fuelAtLaunch - left) : null,
      measuredBurn: this.measuredBurn(), wing: s.wing, pilot: s.pilot, rec: st.rec, marks: st.marks,
      home: st.home,
    };
    st.flying = false; st.wind = null; st.airspeed = null; this.groundAlt = null;
    this.lastStationary = { lat: st.lat, lon: st.lon };
    this.onEvent('landed', { entry, fuelLeft: left });
  }

  startManually() { if (this.st.fix && !this.st.flying) { this.beginFlight(Date.now()); this.derive(this.getSettings()); } }
  endManually() { if (this.st.flying) this.finishFlight(Date.now()); }
  reportFuel(l) { const st = this.st; if (st.flying) st.fuelReports.push({ t: st.t || Date.now(), l }); this.derive(this.getSettings()); }
  mark() { const st = this.st; if (st.fix) st.marks.push({ lat: st.lat, lon: st.lon, t: st.t }); }
}

/** IGC file text for a recorded flight (no barometer on the web, so pressure altitude is 0). */
function buildIgc(entry) {
  const pad = (v, n) => String(Math.max(0, Math.floor(v))).padStart(n, '0');
  const d = new Date(entry.start);
  const date = pad(d.getUTCDate(), 2) + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCFullYear() % 100, 2);
  const ll = (v, degLen, pos, neg) => {
    const a = Math.abs(v), dg = Math.floor(a), m = (a - dg) * 60;
    return pad(dg, degLen) + pad(m, 2) + pad((m % 1) * 1000, 3) + (v >= 0 ? pos : neg);
  };
  const lines = ['AXOSWEBOpenSoar Web', `HFDTE${date}`, 'HFFXA035', `HFPLTPILOTINCHARGE:${entry.pilot || ''}`,
    `HFGTYGLIDERTYPE:Paramotor ${entry.wing || ''}`.trim(), 'HFDTM100GPSDATUM:WGS84', 'HFFTYFRTYPE:OpenSoar,Web'];
  for (const p of entry.rec) {
    const t = new Date(p.t);
    const time = pad(t.getUTCHours(), 2) + pad(t.getUTCMinutes(), 2) + pad(t.getUTCSeconds(), 2);
    const a = Math.round(p.alt);
    const gpsAlt = (a < 0 ? '-' + pad(-a, 4) : pad(a, 5));
    lines.push(`B${time}${ll(p.lat, 2, 'N', 'S')}${ll(p.lon, 3, 'E', 'W')}A00000${gpsAlt}`);
  }
  return lines.join('\r\n') + '\r\n';
}

function buildGpx(entry) {
  const pts = entry.rec.map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.alt.toFixed(1)}</ele><time>${new Date(p.t).toISOString()}</time></trkpt>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="OpenSoar Web" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>OpenSoar flight</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

if (typeof module !== 'undefined') {
  module.exports = { haversine, bearing, destination, groundSpeedAlong, glideReach, sunsetMs, WindEstimator, GpsJumpFilter, FlightComputer, buildIgc, buildGpx };
}
