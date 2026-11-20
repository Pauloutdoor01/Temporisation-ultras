/* ===== Modèle de temporisation (pur, sans DOM) ===== */
const TM = (() => {
  const R_EARTH = 6371.0088;
  const STEP_KM = 0.025;

  function hav(a, b) {
    const toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /* --- Lecture GPX --- */
  function parseGPX(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Le fichier n'est pas un GPX lisible.");
    const read = (el) => {
      const e = el.getElementsByTagName("ele")[0];
      const n = el.getElementsByTagName("name")[0];
      return { lat: +el.getAttribute("lat"), lon: +el.getAttribute("lon"), ele: e ? +e.textContent : NaN, name: n ? n.textContent.trim() : "" };
    };
    let pts = [...doc.getElementsByTagName("trkpt")].map(read);
    if (pts.length < 2) pts = [...doc.getElementsByTagName("rtept")].map(read);
    if (pts.length < 2) throw new Error("Aucune trace trouvée dans le GPX (balises trkpt ou rtept).");
    if (!pts.some((p) => Number.isFinite(p.ele))) throw new Error("La trace n'a pas d'altitudes. Exporte le GPX avec l'élévation.");
    const wpts = [...doc.getElementsByTagName("wpt")].map(read).filter((w) => w.name);
    const nm = doc.querySelector("metadata > name, trk > name");
    return { track: pts, wpts, name: nm ? nm.textContent.trim() : "" };
  }

  /* --- Rééchantillonnage + lissage de l'altitude --- */
  function buildCourse(track) {
    // altitudes manquantes : interpolation
    let last = track.find((p) => Number.isFinite(p.ele)).ele;
    track.forEach((p) => { if (Number.isFinite(p.ele)) last = p.ele; else p.ele = last; });
    const cum = [0];
    for (let i = 1; i < track.length; i++) cum.push(cum[i - 1] + hav(track[i - 1], track[i]));
    const total = cum[cum.length - 1];
    const n = Math.max(2, Math.round(total / STEP_KM) + 1);
    const km = [], ele = [], lat = [], lon = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.min(total, i * total / (n - 1));
      while (j < cum.length - 2 && cum[j + 1] < d) j++;
      const span = cum[j + 1] - cum[j] || 1e-9;
      const t = Math.min(1, Math.max(0, (d - cum[j]) / span));
      km.push(d);
      ele.push(track[j].ele + t * (track[j + 1].ele - track[j].ele));
      lat.push(track[j].lat + t * (track[j + 1].lat - track[j].lat));
      lon.push(track[j].lon + t * (track[j + 1].lon - track[j].lon));
    }
    // lissage ±75 m (bruit GPS/barométrique)
    const w = 3, sm = ele.map((_, i) => {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { s += ele[k]; c++; }
      return s / c;
    });
    const up = [0], down = [0];
    for (let i = 1; i < n; i++) {
      const dz = sm[i] - sm[i - 1];
      up.push(up[i - 1] + Math.max(0, dz));
      down.push(down[i - 1] + Math.max(0, -dz));
    }
    return { km, ele: sm, lat, lon, up, down, total, dplus: up[n - 1], dminus: down[n - 1] };
  }

  function idxAtKm(c, k) {
    let lo = 0, hi = c.km.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c.km[m] <= k) lo = m; else hi = m; }
    return Math.abs(c.km[hi] - k) < Math.abs(c.km[lo] - k) ? hi : lo;
  }

  /* waypoints accrochés à la trace, dans l'ordre du parcours (gère les boucles) */
  function snapWaypoints(c, wpts) {
    const out = [];
    let from = 0;
    const cand = wpts.map((w) => {
      let best = Infinity, bi = 0;
      for (let i = 0; i < c.km.length; i += 2) {
        const d = hav(w, { lat: c.lat[i], lon: c.lon[i] });
        if (d < best) { best = d; bi = i; }
      }
      return { w, best, bi };
    }).filter((x) => x.best < 0.5);
    // ordre de la trace ; pour un point proche de plusieurs passages, chercher après le précédent
    cand.sort((a, b) => a.bi - b.bi);
    cand.forEach(({ w }) => {
      let best = Infinity, bi = from;
      for (let i = from; i < c.km.length; i++) {
        const d = hav(w, { lat: c.lat[i], lon: c.lon[i] });
        if (d < best - 1e-6) { best = d; bi = i; }
      }
      if (best < 0.5) { out.push({ name: w.name, km: +c.km[bi].toFixed(2) }); from = bi; }
    });
    return out;
  }

  /* --- Loi de temps calée sur ~3 100 finishers LiveTrail (15 courses, 2025-2026) ---
     UTMB, CCC, OCC, TDS, MCC 2026 · UT4M 180 Xtrem, 100 Master, 40 Chartreuse 2026 · SaintéLyon et SaintExpress 2025
     Échappée Belle Traversée Nord 2025 · Templiers Grand Trail et Endurance Trail 2025 · GRK Odyssée de Caron 2026
     temps attendu d'une cote 945 : exp(-3.85) × (km + D+/120)^1.211 × e^(0.099 × D+/km/100) × e^(0.163 × (alt. max - 1500)/1000)
     effet de la cote : × (945/cote)^c, c = 1.057 + 0.075 × ln(km-effort/150)
     le vainqueur court en moyenne 8 % plus vite que le temps attendu pour sa cote (meilleure journée du plateau) */
  /* Usure sur parcours roulant (ajout après la Western Azuréenne 2026) : au-delà de 90 km, chaque km coûte un peu plus,
     d'autant plus que le parcours est peu pentu (aucun effet au-dessus de 70 m de D+ par km). Moncany, cote 817, 162 km / 4 800 D+ : 16h08 ; 82 finishers, médiane 26h53, derniers bien au-delà de 32 h. */
  /* Tous les réglages du modèle sont regroupés ici : modifiables depuis la page « Réglages » et par le recalage. */
  const DEFAULTS = {
    law: { a: -3.866, b: 1.218, k: 120, steep: 0.089, alt: 0.148, wear: 0.34, wearKm: 90, wearSteep: 50, c0: 1.057, c1: 0.075, win: 0.92, short: 0.36, shortKe: 30 },
    tech: { roulant: 0.97, standard: 1, technique: 1.07, tres: 1.15, lastAmp: 1.5 },
    last: { r0: 2.62, r1: 0.0011, rMin: 2.2, rMax: 2.7, tailB: 0.37, tailP: 1.43, tailK: 280, tailCap: 1.8 },
    profiles: {
      tete: { gamma: 0.2, kd: 2.0, altSens: 1.0, night: 1.06, stops: { passage: 0, liquide: 0.5, complet: 1.5, base: 4 } },
      dernier: { gamma: 0.32, kd: 4.5, altSens: 1.4, night: 1.12, stops: { passage: 0, liquide: 3, complet: 10, base: 30 } },
    },
    flux: { spread: 1.0, dots: 70 },
  };
  const deep = (o) => JSON.parse(JSON.stringify(o));
  function merge(base, over) {
    const out = deep(base);
    (function rec(a, b) { for (const k in b) { if (!(k in a)) continue; if (a[k] && typeof a[k] === "object") rec(a[k], b[k] || {}); else if (Number.isFinite(+b[k]) && b[k] !== "" && b[k] !== null) a[k] = +b[k]; } })(out, over || {});
    return out;
  }
  let P = deep(DEFAULTS), LAW = P.law, TECH = P.tech, PROFILES = P.profiles;
  function setParams(p) { P = merge(DEFAULTS, p); LAW = P.law; TECH = P.tech; PROFILES = P.profiles; }
  function getParams() { return deep(P); }
  function t945(km, dp, altMax) {
    const wear = LAW.wear * Math.max(0, Math.log(km / LAW.wearKm)) * (1 - Math.min(1, dp / km / LAW.wearSteep));
    // formats courts : la loi des ultras extrapolée donnerait des allures de route ; on la freine
    const ke = km + dp / LAW.k, shortF = 1 + LAW.short * Math.max(0, Math.log(LAW.shortKe / ke));
    return shortF * Math.exp(LAW.a + LAW.b * Math.log(ke) + LAW.steep * (dp / km / 100) + LAW.alt * Math.max(0, altMax - 1500) / 1000 + wear);
  }
  function idxExp(km, dp) { return LAW.c0 + LAW.c1 * Math.log((km + dp / 100) / 150); }
  function techF(tech) { return tech === "standard" ? 1 : (TECH[tech] || 1); }
  function leaderHours(km, dp, altMax, idx, tech) {
    return t945(km, dp, altMax) * Math.pow(945 / idx, idxExp(km, dp)) * LAW.win * techF(tech);
  }
  // dernier finisher / temps attendu d'une cote 945 : 2.5 sur ~100 km-effort, 2.3 sur ~280 (GRK, UT4M, UTMB)
  function lastRatio(kme) { const L = P.last; return Math.min(L.rMax, Math.max(L.rMin, L.r0 - L.r1 * kme)); }
  /* Longue traîne des derniers : plus le format est court, plus le plateau est hétérogène et plus le dernier finit loin de la tête.
     Calé sur la Western 2026 100 km, le Derby des 3 Vallées 2026, GRK 110 et UT4M 180 (classements complets). */
  function lastTail(km, dp) {
    const L = P.last, x = Math.max(0, Math.log(L.tailK / (km + dp / 100)));
    return Math.min(L.tailCap, 1 + L.tailB * Math.pow(x, L.tailP));
  }
  function techLast(tech) { const tf = techF(tech); return tf > 1 ? 1 + (tf - 1) * TECH.lastAmp : 1; }
  function lastHours(km, dp, altMax, tech) { return t945(km, dp, altMax) * lastRatio(km + dp / 100) * lastTail(km, dp) * techLast(tech); }

  function gradeFactor(g, kd) {
    if (g >= 0) return 1 + 10 * g;              // équivalence 100 m D+ = 1 km
    const a = -g;
    if (a <= 0.08) return 1 - 1.2 * a;           // descente roulante : on gagne
    return 0.904 + kd * (a - 0.08);              // descente raide : on perd (plus pour les moins rapides)
  }
  function altFactor(h, sens) {
    const x = Math.max(0, h - 1500) / 1000;
    return 1 + sens * (0.04 * x + 0.02 * x * x);
  }

  /* lever / coucher (crépuscule civil -6°) — équation du lever du soleil */
  function sunTimes(dateMs, lat, lon) {
    const rad = Math.PI / 180;
    const JD = dateMs / 86400000 + 2440587.5;
    const n = Math.round(JD - 2451545.0 + 0.0008);
    const Js = n - lon / 360;
    const M = (357.5291 + 0.98560028 * Js) % 360;
    const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
    const L = (M + C + 180 + 102.9372) % 360;
    const Jt = 2451545 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
    const sd = Math.sin(L * rad) * Math.sin(23.4397 * rad);
    const cd = Math.cos(Math.asin(sd));
    const cw = (Math.sin(-6 * rad) - Math.sin(lat * rad) * sd) / (Math.cos(lat * rad) * cd);
    if (cw <= -1) return { rise: -Infinity, set: Infinity };
    if (cw >= 1) return { rise: Infinity, set: -Infinity };
    const w = Math.acos(cw) / rad;
    const toMs = (J) => (J - 2440587.5) * 86400000;
    return { rise: toMs(Jt - w / 360), set: toMs(Jt + w / 360) };
  }
  function makeNight(c) {
    const lat = c.lat[0], lon = c.lon[0], cache = {};
    return (t) => {
      const day = Math.floor((t + lon / 360 * 86400000) / 86400000);
      if (!cache[day]) cache[day] = sunTimes(day * 86400000 + 43200000 - lon / 360 * 86400000, lat, lon);
      const s = cache[day];
      return t < s.rise || t > s.set;
    };
  }

  /* --- Simulation d'un coureur le long de la trace ---
     le temps total vient de la loi ; pente, fatigue, altitude et nuit répartissent ce temps le long du parcours */
  function simulate(c, cps, targetH, prof, startMs) {
    const n = c.km.length, isNight = makeNight(c);
    const step = [];
    let e = 0;
    for (let i = 1; i < n; i++) {
      const d = c.km[i] - c.km[i - 1];
      const dz = c.ele[i] - c.ele[i - 1];
      const g = d > 0 ? dz / (d * 1000) : 0;
      e += d + Math.max(0, dz) / 100;
      const h = (c.ele[i] + c.ele[i - 1]) / 2;
      step.push({ w: d * gradeFactor(g, prof.kd) * Math.pow(e + 25, prof.gamma) * altFactor(h, prof.altSens) });
    }
    const cpIdx = cps.map((p) => idxAtKm(c, p.km));
    const stopAt = cps.map((p, i) => (i > 0 && i < cps.length - 1 ? (prof.stops[p.type] || 0) * 60000 : 0));
    const moving = Math.max(targetH * 0.6 * 3.6e6, targetH * 3.6e6 - stopAt.reduce((a, b) => a + b, 0));
    let night = step.map(() => false), res;
    for (let pass = 0; pass < 3; pass++) {
      const wt = step.map((s, i) => s.w * (night[i] ? prof.night : 1));
      const k = moving / wt.reduce((a, b) => a + b, 0);
      res = new Array(cps.length).fill(startMs);
      let t = startMs, ci = 1;
      const nextNight = [];
      const curve = [[0, startMs]];   // [km, heure] tous les ~250 m, pour l'animation du flux
      for (let i = 1; i < n; i++) {
        nextNight.push(isNight(t));
        t += k * wt[i - 1];
        if (i % 10 === 0 || i === n - 1) curve.push([c.km[i], t]);
        while (ci < cps.length && cpIdx[ci] <= i) { res[ci] = t; t += stopAt[ci]; ci++; }
      }
      res.curve = curve;
      while (ci < cps.length) res[ci++] = t;
      night = nextNight;
    }
    return res;
  }

  function compute(c, points, opt) {
    const kme = c.total + c.dplus / 100;
    const cps = [{ name: opt.startName || "Départ", km: 0, type: "passage" },
      ...points.filter((p) => p.km > 0.05 && p.km < c.total - 0.05).sort((a, b) => a.km - b.km),
      { name: opt.finishName || "Arrivée", km: c.total, type: "passage" }];
    const start = opt.startMs;
    const altMax = Math.max(...c.ele);
    /* Recalage propre au format : temps réel du vainqueur d'une édition passée sur ce parcours, avec sa cote.
       Le rapport réel / modèle s'applique à la tête et à la 1re femme (borné à ±40 %). */
    let refK = 1;
    /* Éditions passées connues (opt.leadRefs, opt.lastRefs : {km, dp, alt, h, idx}) : rapport réel / modèle
       sur chaque édition, on garde la médiane (un dernier atypique ne fausse pas tout), bornée à ±40 %. */
    const med = (ks) => {
      ks = ks.filter((k) => k > 0 && Number.isFinite(k)).sort((a, b) => a - b);
      if (!ks.length) return 1;
      const m = ks.length >> 1;
      return Math.min(1.4, Math.max(0.6, ks.length % 2 ? ks[m] : (ks[m - 1] + ks[m]) / 2));
    };
    if (opt.ref && opt.ref.h > 0 && opt.ref.idx >= 300) {
      const m = leaderHours(c.total, c.dplus, altMax, opt.ref.idx, opt.tech);
      if (m > 0) refK = Math.min(1.4, Math.max(0.6, opt.ref.h / m));
    } else if (opt.leadRefs && opt.leadRefs.length) {
      refK = med(opt.leadRefs.map((r) => r.h / leaderHours(r.km, r.dp, r.alt, r.idx, opt.tech)));
    }
    const lastK = opt.lastK > 0 ? opt.lastK : opt.lastRefs && opt.lastRefs.length ? med(opt.lastRefs.map((r) => r.h / lastHours(r.km, r.dp, r.alt, opt.tech))) : 1;
    const tLead = leaderHours(c.total, c.dplus, altMax, opt.idx, opt.tech) * refK;
    const lead = simulate(c, cps, tLead, PROFILES.tete, start);
    let fem = null;
    if (opt.idxF) fem = simulate(c, cps, leaderHours(c.total, c.dplus, altMax, opt.idxF, opt.tech) * refK, PROFILES.tete, start);
    const tLast = lastHours(c.total, c.dplus, altMax, opt.tech) * lastK;   // un parcours roulant ne fait pas gagner de temps aux derniers
    const last = simulate(c, cps, tLast, PROFILES.dernier, start);
    const rows = cps.map((p, i) => {
      const ii = idxAtKm(c, p.km), pi = i ? idxAtKm(c, cps[i - 1].km) : 0;
      return {
        name: p.name, type: p.type, pt: p, km: c.km[ii], alt: c.ele[ii],
        dkm: c.km[ii] - c.km[pi], dup: c.up[ii] - c.up[pi], ddown: c.down[ii] - c.down[pi],
        up: c.up[ii], down: c.down[ii],
        lead: lead[i], fem: fem ? fem[i] : null, last: last[i],
      };
    });
    return { refK, lastK, leadCurve: lead.curve, lastCurve: last.curve, rows, kme, start, leadH: (lead[lead.length - 1] - start) / 3.6e6, lastH: (last[last.length - 1] - start) / 3.6e6, femH: fem ? (fem[fem.length - 1] - start) / 3.6e6 : null };
  }

  /* applique un D+ officiel : met à l'échelle les dénivelés sans toucher aux distances */
  /* applique les valeurs officielles : D+ et D- recalent le dénivelé (montées et descentes séparément),
     la distance officielle recale les kilomètres de la trace. Les points saisis aux km officiels tombent alors au bon endroit. */
  function scaleElevation(c, officialDplus, officialDminus) {
    const wantU = officialDplus > 0 ? officialDplus : (officialDminus > 0 ? null : 0);
    const wantD = officialDminus > 0 ? officialDminus : null;
    if (!wantU && !wantD) return c;
    const n = c.ele.length, W = 200;   // ±5 km : on garde les altitudes réelles, seules les variations locales sont recalées
    let fu = wantU ? wantU / c.dplus : wantD / c.dminus, fd = wantD ? wantD / c.dminus : fu, e3 = c.ele, up, down;
    for (let it = 0; it < 4; it++) {
      const e2 = [c.ele[0]];
      for (let i = 1; i < n; i++) { const dz = c.ele[i] - c.ele[i - 1]; e2.push(e2[i - 1] + dz * (dz > 0 ? fu : fd)); }
      // dérive basse fréquence (moyenne glissante de l'écart) retirée pour que les sommets restent à leur altitude
      const diff = e2.map((v, i) => v - c.ele[i]), pre = [0];
      for (let i = 0; i < n; i++) pre.push(pre[i] + diff[i]);
      e3 = e2.map((v, i) => { const a = Math.max(0, i - W), b = Math.min(n - 1, i + W); return v - (pre[b + 1] - pre[a]) / (b - a + 1); });
      up = [0]; down = [0];
      for (let i = 1; i < n; i++) { const dz = e3[i] - e3[i - 1]; up.push(up[i - 1] + Math.max(0, dz)); down.push(down[i - 1] + Math.max(0, -dz)); }
      const gu = up[n - 1], gd = down[n - 1];
      fu *= (wantU || wantD) / (wantU ? gu : gd); fd *= (wantD || wantU) / (wantD ? gd : gu);
    }
    return { ...c, ele: e3, up, down, dplus: up[n - 1], dminus: down[n - 1] };
  }
  function scaleDistance(c, officialKm) {
    if (!(officialKm > 0) || !c.total) return c;
    const f = officialKm / c.total;
    return { ...c, km: c.km.map((k) => k * f), total: officialKm, kmFactor: f };
  }

  return { scaleDistance, makeNight, t945, parseGPX, buildCourse, snapWaypoints, compute, scaleElevation, idxAtKm, leaderHours, lastHours, lastRatio, lastTail, idxExp, hav, DEFAULTS, setParams, getParams };
})();
