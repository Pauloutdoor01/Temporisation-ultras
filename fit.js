/* ===== Recalage du modèle sur la base de résultats (pur, sans DOM) =====
   Une course : { id, name, km, dp, alt, tech, results: [[cote, heures], ...], winner: {idx, h} | null, lastH: heures | null, full: bool }
   - results : finishers dont on connaît la cote (collés depuis LiveTrail) -> loi de temps (tête)
   - winner  : vainqueur seul (cote + temps), quand on n'a pas tout le classement
   - lastH   : temps du dernier finisher ; si full = true (classement complet) et lastH vide, on prend le plus lent des results */
const FIT = (() => {
  function nelderMead(f, x0, steps, iters) {
    const n = x0.length;
    let S = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += steps[i]; S.push(x); }
    let F = S.map(f);
    for (let it = 0; it < iters; it++) {
      const ord = F.map((v, i) => i).sort((a, b) => F[a] - F[b]);
      S = ord.map((i) => S[i]); F = ord.map((i) => F[i]);
      if (Math.abs(F[n] - F[0]) < 1e-10) break;
      const c = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
      const pt = (t) => c.map((v, j) => v + t * (S[n][j] - v));
      const xr = pt(-1), fr = f(xr);
      if (fr < F[0]) { const xe = pt(-2), fe = f(xe); if (fe < fr) { S[n] = xe; F[n] = fe; } else { S[n] = xr; F[n] = fr; } }
      else if (fr < F[n - 1]) { S[n] = xr; F[n] = fr; }
      else {
        const xc = fr < F[n] ? pt(-0.5) : pt(0.5), fc = f(xc);
        if (fc < Math.min(fr, F[n])) { S[n] = xc; F[n] = fc; }
        else { for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); F[i] = f(S[i]); } }
      }
    }
    const b = F.indexOf(Math.min(...F));
    return { x: S[b], f: F[b] };
  }

  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
  const lastOf = (r) => (+r.lastH > 0 ? +r.lastH : (r.full && r.results && r.results.length ? Math.max(...r.results.map((x) => x[1])) : null));

  // paramètres de la loi que le recalage peut bouger, avec leur pas de départ
  const LAW_KEYS = [["a", 0.1], ["b", 0.05], ["steep", 0.03], ["alt", 0.03], ["wear", 0.05], ["c0", 0.05], ["c1", 0.02], ["short", 0.05]];

  /* Évalue le modèle (paramètres p) sur chaque course : écarts tête / dernier / finishers */
  function evaluate(TM, races, p) {
    const keep = TM.getParams(); TM.setParams(p);
    const out = races.map((r) => {
      const o = { id: r.id, name: r.name, n: (r.results || []).length };
      const tf = r.tech && r.tech !== "standard" ? (TM.getParams().tech[r.tech] || 1) : 1;
      if (o.n) {
        const errs = r.results.map(([idx, h]) => {
          const pred = TM.t945(r.km, r.dp, r.alt) * Math.pow(945 / idx, TM.idxExp(r.km, r.dp)) * tf;
          return Math.abs(h / pred - 1);
        });
        o.runnersErr = errs.reduce((a, b) => a + b, 0) / errs.length;
      }
      const w = r.winner && r.winner.idx && r.winner.h ? r.winner : (o.n ? (() => { const b = r.results.reduce((m, x) => (x[1] < m[1] ? x : m)); return { idx: b[0], h: b[1] }; })() : null);
      if (w) { o.winObs = w.h; o.winPred = TM.leaderHours(r.km, r.dp, r.alt, w.idx, r.tech || "standard"); }
      const L = lastOf(r);
      if (L) { o.lastObs = L; o.lastPred = TM.lastHours(r.km, r.dp, r.alt, r.tech || "standard"); }
      return o;
    });
    TM.setParams(keep);
    return out;
  }

  /* Recalage complet. locks = noms de paramètres à ne pas toucher ("law.a", "last.tailB", ...). */
  function fit(TM, races, base, locks) {
    locks = new Set(locks || []);
    const p = JSON.parse(JSON.stringify(base));
    const report = [];
    TM.setParams(p);

    // 1) loi de temps sur les finishers avec cote (poids égal par course, 400 coureurs max par course)
    const pts = [];
    races.forEach((r) => {
      let res = (r.results || []).filter(([i, h]) => i >= 300 && i <= 1000 && h > 0);
      if (res.length > 400) { const st = res.length / 400; res = Array.from({ length: 400 }, (_, k) => res[Math.floor(k * st)]); }
      const tf = r.tech && r.tech !== "standard" ? (p.tech[r.tech] || 1) : 1;
      res.forEach(([i, h]) => pts.push({ r, i, h: h / tf, w: 1 / res.length }));
      // vainqueur seul : on ramène son temps au « temps attendu pour sa cote » en retirant l'effet meilleure journée
      if (!res.length && r.winner && r.winner.idx && r.winner.h) pts.push({ r, i: +r.winner.idx, h: r.winner.h / tf / p.law.win, w: 1 });
    });
    const keys = LAW_KEYS.filter(([k]) => !locks.has("law." + k));
    if (pts.length >= 20 && keys.length) {
      const f = (x) => {
        keys.forEach(([k], j) => { p.law[k] = x[j]; });
        if (p.law.b <= 0.3 || p.law.c0 <= 0.2 || p.law.short < 0 || p.law.wear < 0) return 1e9;
        TM.setParams(p);
        let s = 0;
        for (const q of pts) { const pred = TM.t945(q.r.km, q.r.dp, q.r.alt) * Math.pow(945 / q.i, TM.idxExp(q.r.km, q.r.dp)); const d = Math.log(q.h / pred); s += q.w * d * d; }
        return s;
      };
      const x0 = keys.map(([k]) => p.law[k]);
      let best = nelderMead(f, x0, keys.map(([, s]) => s), 1500);
      best = nelderMead(f, best.x, keys.map(([, s]) => s / 4), 1500);
      keys.forEach(([k], j) => { p.law[k] = +best.x[j].toFixed(4); });
      report.push(`Loi de temps recalée sur ${pts.length} finishers de ${new Set(pts.map((q) => q.r.id)).size} course(s).`);
    } else report.push("Loi de temps : pas assez de finishers avec cote (20 minimum), inchangée.");
    TM.setParams(p);

    // 2) effet « meilleure journée » du vainqueur
    if (!locks.has("law.win")) {
      const ratios = [];
      races.forEach((r) => {
        const res = r.results || [];
        if (res.length < 15) return;   // il faut un vrai plateau pour situer le vainqueur
        const b = res.reduce((m, x) => (x[1] < m[1] ? x : m));
        const tf = r.tech && r.tech !== "standard" ? (p.tech[r.tech] || 1) : 1;
        ratios.push(b[1] / (TM.t945(r.km, r.dp, r.alt) * Math.pow(945 / b[0], TM.idxExp(r.km, r.dp)) * tf));
      });
      if (ratios.length >= 3) { p.law.win = +median(ratios).toFixed(3); report.push(`Vainqueur : ${Math.round((1 - p.law.win) * 100)} % plus rapide que sa cote (médiane de ${ratios.length} courses).`); }
    }
    TM.setParams(p);

    // 3) traîne du dernier sur les courses dont on connaît le dernier finisher
    const lastPts = races.map((r) => ({ r, L: lastOf(r) })).filter((q) => q.L);
    const tailKeys = [["tailB", 0.05], ["tailP", 0.2]].filter(([k]) => !locks.has("last." + k));
    if (lastPts.length >= 2 && tailKeys.length) {
      const use = lastPts.length >= 3 ? tailKeys : tailKeys.filter(([k]) => k === "tailB");
      const f = (x) => {
        use.forEach(([k], j) => { p.last[k] = x[j]; });
        if (p.last.tailB < 0 || p.last.tailP < 0.3 || p.last.tailP > 4) return 1e9;
        TM.setParams(p);
        let s = 0;
        lastPts.forEach(({ r, L }) => { const d = Math.log(L / TM.lastHours(r.km, r.dp, r.alt, r.tech || "standard")); s += d * d; });
        return s;
      };
      const best = nelderMead(f, use.map(([k]) => p.last[k]), use.map(([, s]) => s), 800);
      use.forEach(([k], j) => { p.last[k] = +best.x[j].toFixed(4); });
      report.push(`Dernier finisher recalé sur ${lastPts.length} course(s).`);
    } else report.push("Dernier finisher : il faut au moins 2 courses avec le temps du dernier, inchangé.");
    TM.setParams(base);
    return { params: p, report };
  }

  /* Lecture d'un classement collé : une ligne par coureur, avec un temps (hh:mm:ss ou 12h34) et, si on l'a, la cote UTMB.
     Formats acceptés : « 812;16:07:52 », « 16:07:52 812 », copie de tableau LiveTrail (rang, nom, ..., temps, cote). */
  function parseResults(text) {
    const out = [], noIdx = [];
    String(text || "").split(/\n/).forEach((line) => {
      const l = line.trim(); if (!l) return;
      const tm = l.match(/(\d{1,3})\s*[:h]\s*(\d{2})(?:\s*[:m']\s*(\d{2}))?/);
      if (!tm) return;
      const h = +tm[1] + +tm[2] / 60 + (tm[3] ? +tm[3] / 3600 : 0);
      const rest = (l.slice(0, tm.index) + " " + l.slice(tm.index + tm[0].length)).match(/\b([3-9]\d{2})\b/g);
      const idx = rest ? +rest[rest.length - 1] : null;
      if (idx) out.push([idx, +h.toFixed(4)]); else noIdx.push(+h.toFixed(4));
    });
    return { withIdx: out, times: noIdx.concat(out.map((x) => x[1])) };
  }

  return { fit, evaluate, parseResults, nelderMead, lastOf };
})();
if (typeof module !== "undefined") module.exports = FIT;
