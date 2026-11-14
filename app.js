const $ = (id) => document.getElementById(id);
const VIEWER = window.TEMPO_MODE === "viewer";
if (VIEWER) document.body.classList.add("viewer");
const TYPES = [["passage", "Passage"], ["liquide", "Ravito liquide"], ["complet", "Ravito complet"], ["base", "Base vie"]];
const TYPE_LABEL = Object.fromEntries(TYPES);
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---------- Course préchargée : GRK 3 Vallées, Ultra des 3 Vallées (trace 2026 provisoire) ---------- */
const PRESET_TRACK = "preset:grk2026";
const PRESET = {
  name: "Grand Raid Kiprun 3 Vallées Moûtiers - 2027",
  label: "Ultra des 3 Vallées",
  start: "2027-07-16T18:00", idx: 850, dplus: 12000,
  points: [
    ["Brides-les-bains", 10.1, "complet"], ["Route de la Tania", 15.5, "passage"], ["Col de la Loze", 23.5, "complet"],
    ["Méribel-Mottaret", 35.1, "base"], ["Tougnète", 42.0, "liquide"], ["Col de la Chambre", 55.3, "passage"],
    ["Val Thorens", 59.8, "complet"], ["Cime de Caron", 66.3, "complet"], ["Orelle", 80.0, "base"],
    ["Chalet Sainte Marguerite", 89.9, "liquide"], ["Col de Pierre Blanche", 93.8, "passage"], ["Pointe de la Masse", 98.1, "complet"],
    ["Les Menuires", 104.9, "liquide"], ["Saint-Martin-de-Belleville", 116.5, "base"], ["Plan des Queux", 124.6, "passage"],
    ["Deux-Nants", 129.6, "complet"], ["Col du Mottet", 135.8, "passage"], ["Saint-Jean-de-Belleville", 145.3, "complet"],
    ["Crève-tête", 151.9, "passage"], ["Refuge communal de Lachat", 156.9, "complet"],
  ],
};

/* ---------- Modèle de données ----------
   EV = l'événement en cours : { name, formats: [F], cur, archiveId }
   F  = un format : { id, label, start, idx, idxF, tech, dplus, points, finishBh, trackId, gpxInfo }
   Les traces sont rangées à part (IndexedDB), un format pointe vers sa trace par trackId. */
function newFormat(label) {
  return { id: uid("f"), label: label || "", start: "", idx: 850, idxF: "", tech: "standard", dplus: "", points: [], finishBh: "", trackId: null, gpxInfo: "" };
}
function presetEvent() {
  const F = newFormat(PRESET.label);
  Object.assign(F, { start: PRESET.start, idx: PRESET.idx, dplus: PRESET.dplus, trackId: PRESET_TRACK,
    points: PRESET.points.map(([n, k, t]) => ({ name: n, km: k, type: t })),
    gpxInfo: "Trace provisoire : celle de 2026, en attendant la trace 2027. Dépose le GPX 2027 ici : les points, la date, la cote et le D+ de ce format sont conservés." });
  return { name: PRESET.name, formats: [F], cur: 0, archiveId: null };
}
let EV = null;
const curF = () => EV.formats[EV.cur];

/* ---------- Stockage (IndexedDB : traces, archives, état en cours) ---------- */
let idbP = null;
function idb() {
  if (idbP) return idbP;
  idbP = new Promise((res) => {
    try {
      const r = indexedDB.open("tempo-ultra", 2);
      r.onupgradeneeded = () => { const d = r.result; ["t", "a", "w", "s", "r", "g"].forEach((n) => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); }); };
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    } catch (e) { res(null); }
  });
  return idbP;
}
/* Dans l'appli Mac : fichiers JSON dans Documents/Tempo Ultra (via le pont « tempo »). Dans la visionneuse : mémoire seule. */
const STORE = window.tempo ? window.tempo.kv : (window.TEMPO_MODE === "viewer" ? memStore() : null);
function memStore() {
  const m = new Map(), s = (n) => { if (!m.has(n)) m.set(n, new Map()); return m.get(n); };
  return { get: async (n, k) => s(n).get(k) ?? null, put: async (n, k, v) => { s(n).set(k, v); }, del: async (n, k) => { s(n).delete(k); },
    all: async (n) => [...s(n).values()], keys: async (n) => [...s(n).keys()] };
}
async function storeOp(name, mode, fn) {
  if (STORE) {
    let p = null;
    const st = { get: (k) => { p = STORE.get(name, k); }, put: (v, k) => { p = STORE.put(name, k, v); }, delete: (k) => { p = STORE.del(name, k); },
      getAll: () => { p = STORE.all(name); }, getAllKeys: () => { p = STORE.keys(name); } };
    fn(st);
    try { return p ? await p : null; } catch (e) { console.error(e); return null; }
  }
  const db = await idb(); if (!db) return null;
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction(name, mode); let out = null;
      const r = fn(t.objectStore(name)); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  } catch (e) { return null; }
}
const tracks = new Map();   // trackId -> [{lat,lon,ele}]
function packTrack(tr) { const a = new Array(tr.length * 3); tr.forEach((p, i) => { a[3 * i] = +p.lat.toFixed(6); a[3 * i + 1] = +p.lon.toFixed(6); a[3 * i + 2] = Math.round(p.ele * 10) / 10; }); return a; }
function unpackTrack(a) { const t = []; for (let i = 0; i < a.length; i += 3) t.push({ lat: a[i], lon: a[i + 1], ele: a[i + 2] }); return t; }
async function getTrack(id) {
  if (!id) return null;
  if (tracks.has(id)) return tracks.get(id);
  let t = null;
  if (id === PRESET_TRACK) t = unpackTrack(GRK_TRACK);
  else { const a = await storeOp("t", "readonly", (st) => st.get(id)); if (a) t = unpackTrack(a); }
  if (t) tracks.set(id, t);
  return t;
}
async function putTrack(tr) {
  const id = uid("t");
  tracks.set(id, tr);
  await storeOp("t", "readwrite", (st) => st.put(packTrack(tr), id));
  return id;
}
let saveT = null;
function saveWork() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    if (VIEWER) return;
    await storeOp("w", "readwrite", (st) => st.put(clone(EV), "current"));
    if (EV.archiveId && !arcBusy) archiveCurrent(false);
    shareChanged();
  }, 500);
}
async function loadWork() {
  let ev = await storeOp("w", "readonly", (st) => st.get("current"));
  if (ev && Array.isArray(ev.formats) && ev.formats.length) return ev;
  // reprise des réglages enregistrés par la version précédente (un seul format)
  const ev0 = presetEvent();
  return ev0;
}

/* ---------- Archives ---------- */
let arcBusy = false;
const arcAll = () => storeOp("a", "readonly", (st) => st.getAll()).then((v) => v || []);
const arcGet = (id) => storeOp("a", "readonly", (st) => st.get(id));
function evLabel(ev) { return (ev.name || "").trim() || "Événement sans nom"; }
function fmtList(ev) { return ev.formats.map((f) => (f.label || "").trim() || "sans nom").join(" · "); }
async function archiveCurrent(exported) {
  if (!EV.archiveId) EV.archiveId = uid("ar");
  const prev = await arcGet(EV.archiveId);
  const rec = { id: EV.archiveId, titre: evLabel(EV), formats: fmtList(EV), maj: Date.now(), exporte: exported ? Date.now() : (prev && prev.exporte) || null, ev: clone(EV) };
  arcBusy = true;
  await storeOp("a", "readwrite", (st) => st.put(rec, rec.id));
  await storeOp("w", "readwrite", (st) => st.put(clone(EV), "current"));
  arcBusy = false;
  renderArchives();
}
async function openArchive(id, copy) {
  const rec = await arcGet(id);
  if (!rec) { toast("Cette archive est introuvable."); return; }
  if (EV.archiveId) await archiveCurrent(false);
  EV = clone(rec.ev);
  if (copy) { EV.archiveId = null; EV.name = (EV.name || "").trim() + " (copie)"; }
  else EV.archiveId = rec.id;
  EV.cur = Math.min(EV.cur || 0, EV.formats.length - 1);
  await showEvent();
  saveWork();
  toast(copy ? "Copie ouverte : elle sera archivée à part à son premier export." : `« ${rec.titre} » rouvert. Modifie puis exporte : l'archive suit.`);
}
async function deleteArchive(id) {
  await storeOp("a", "readwrite", (st) => st.delete(id));
  if (EV.archiveId === id) { EV.archiveId = null; saveWork(); }
  renderArchives(); gcTracks();
  toast("Archive supprimée.");
}
async function gcTracks() {
  const recs = await arcAll(), keep = new Set();
  [EV].concat(recs.map((r) => r.ev)).forEach((ev) => ev.formats.forEach((f) => f.trackId && keep.add(f.trackId)));
  const keys = (await storeOp("t", "readonly", (st) => st.getAllKeys())) || [];
  keys.forEach((k) => { if (!keep.has(k)) { storeOp("t", "readwrite", (st) => st.delete(k)); tracks.delete(k); } });
}
function fmtDT(ms) { const d = new Date(ms); return d.toLocaleDateString("fr-FR") + " à " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
function arcBtn(t, fn) { const b = document.createElement("button"); b.type = "button"; b.className = "ghost sm"; b.textContent = t; b.onclick = fn; return b; }
async function renderArchives() {
  const ul = $("arcList"), q = ($("arcQ").value || "").toLowerCase().trim();
  let recs = (await arcAll()).sort((a, b) => b.maj - a.maj);
  $("arcCount").textContent = recs.length ? `(${recs.length})` : "";
  if (q) recs = recs.filter((r) => ((r.titre || "") + " " + (r.formats || "")).toLowerCase().includes(q));
  ul.textContent = "";
  if (!recs.length) {
    const li = document.createElement("li"); li.className = "arc-empty";
    li.textContent = q ? "Aucune archive ne correspond." : "Aucune archive pour l'instant. Ton prochain export PDF arrivera ici.";
    ul.append(li); return;
  }
  recs.forEach((r) => {
    const cur = r.id === EV.archiveId;
    const li = document.createElement("li"); li.className = "arc-item" + (cur ? " current" : "");
    const t = document.createElement("strong"); t.textContent = r.titre;
    const f = document.createElement("span"); f.className = "arc-meta"; f.textContent = r.formats;
    const m = document.createElement("span"); m.className = "arc-meta";
    m.textContent = (cur ? "Ouvert en ce moment · " : "") + (r.exporte ? "Export du " + fmtDT(r.exporte) : "Jamais exporté") + " · modifié le " + fmtDT(r.maj);
    const act = document.createElement("div"); act.className = "arc-act";
    const open = arcBtn("Ouvrir", () => openArchive(r.id, false)); open.disabled = cur;
    const dup = arcBtn("Dupliquer", () => openArchive(r.id, true));
    const del = arcBtn("Supprimer", () => {
      if (del.dataset.armed) { deleteArchive(r.id); return; }
      del.dataset.armed = "1"; del.textContent = "Confirmer"; del.classList.add("danger");
      setTimeout(() => { delete del.dataset.armed; del.textContent = "Supprimer"; del.classList.remove("danger"); }, 4000);
    });
    act.append(open, dup, del);
    li.append(t, f, m, act); ul.append(li);
  });
}

/* ---------- Calcul d'un format (sans toucher à la page) ---------- */
function optsOf(F) {
  return {
    startMs: F.start ? new Date(F.start).getTime() : Date.now(),
    idx: Math.min(990, Math.max(300, +F.idx || 800)),
    idxF: +F.idxF || null,
    tech: F.tech || "standard",
  };
}
const rawCache = new Map(); // trackId -> course rééchantillonnée
async function computeFormat(F) {
  const tr = await getTrack(F.trackId);
  if (!tr) return null;
  let raw = rawCache.get(F.trackId);
  if (!raw) { raw = TM.buildCourse(tr); rawCache.set(F.trackId, raw); }
  const course = TM.scaleDistance(TM.scaleElevation(raw, +F.dplus, +F.dminus), +F.dist);
  const ctx = { F, raw, course, nightFn: TM.makeNight(course) };
  ctx.res = TM.compute(course, F.points.filter((p) => (p.name || "").trim()), optsOf(F));
  applyBH(ctx.res, F);
  return ctx;
}
let S = null; // contexte du format affiché

/* ---------- Saisie ---------- */
function setIdx(id, v) { $(id).value = v; if (v) $(id + "R").value = v; }
function fillForm() {
  const F = curF();
  $("evName").value = EV.name || "";
  $("fmtLabel").value = F.label || "";
  $("start").value = F.start || "";
  $("tech").value = F.tech || "standard";
  $("dplus").value = F.dplus || "";
  $("dminus").value = F.dminus || "";
  $("dist").value = F.dist || "";
  setIdx("idx", F.idx || 850);
  $("idxF").value = F.idxF || "";
  $("gpxMsg").textContent = F.gpxInfo || (F.trackId ? "" : "Aucune trace pour ce format.");
  $("gpxMsg").classList.toggle("err", F.trackId === PRESET_TRACK || !F.trackId);
  $("delFmt").disabled = EV.formats.length < 2;
  $("pasteMsg").hidden = true;
  $("fmtRunners").value = F.runners || "";
}
async function showEvent() {
  fillForm(); renderTabs(); renderPts(); renderArchives();
  await recomputeNow();
}
function guessType(n) {
  const s = n.toLowerCase();
  if (/base\s*vie/.test(s)) return "base";
  if (/(ravito|ravitaillement|refuge|cabane|chalet)/.test(s)) return "complet";
  if (/(eau|liquide|boisson)/.test(s)) return "liquide";
  return "passage";
}
async function loadGPX(text) {
  const g = TM.parseGPX(text);
  const F = curF();
  const tmp = TM.buildCourse(g.track);
  const id = await putTrack(g.track);
  rawCache.set(id, tmp);
  const prevId = F.trackId;
  F.trackId = id;
  if (!g.wpts.length && F.points.length) {
    F.gpxInfo = `Trace remplacée : ${tmp.total.toFixed(1)} km, D+ mesuré ${Math.round(tmp.dplus)} m. Les ${F.points.length} points, barrières et réglages de ce format sont conservés.`;
  } else {
    F.points = TM.snapWaypoints(tmp, g.wpts).map((p) => ({ ...p, type: guessType(p.name) }));
    F.finishBh = "";
    F.points.forEach((p) => { p.raw = true; });   // km mesurés sur la trace, convertis si une distance officielle est saisie
    F.gpxInfo = `Trace chargée : ${tmp.total.toFixed(1)} km, D+ mesuré ${Math.round(tmp.dplus)} m, ${g.wpts.length} waypoint(s) dans le fichier, ${F.points.length} accroché(s) à la trace.`;
    if (!F.label) F.label = Math.round(tmp.total) + " km";
  }
  F.wpts = g.wpts.map((w) => ({ name: w.name, lat: w.lat, lon: w.lon }));
  if (!EV.name && g.name) EV.name = g.name;
  await convertRawPoints(F);
  fillForm(); renderTabs(); renderPts(); recompute();
  if (prevId && prevId !== id) gcTracks();
}

/* points accrochés depuis les waypoints du GPX : leurs km sont ceux de la trace ; on les passe en km officiels */
async function convertRawPoints(F) {
  if (!(+F.dist > 0) || !F.points.some((p) => p.raw)) return false;
  const tr = await getTrack(F.trackId); if (!tr) return false;
  let raw = rawCache.get(F.trackId); if (!raw) { raw = TM.buildCourse(tr); rawCache.set(F.trackId, raw); }
  const f = +F.dist / raw.total;
  F.points.forEach((p) => { if (p.raw) { p.km = +(p.km * f).toFixed(2); delete p.raw; } });
  return true;
}

/* ---------- Onglets des formats ---------- */
function renderTabs() {
  const box = $("tabs"); box.textContent = "";
  EV.formats.forEach((F, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tab" + (i === EV.cur ? " on" : "") + (F.trackId ? "" : " notrack");
    b.setAttribute("role", "tab"); b.setAttribute("aria-selected", i === EV.cur ? "true" : "false");
    b.textContent = (F.label || "").trim() || `Format ${i + 1}`;
    if (!F.trackId) { const s = document.createElement("small"); s.textContent = "sans trace"; b.append(s); }
    b.onclick = () => switchFormat(i);
    box.append(b);
  });
  const add = document.createElement("button");
  add.type = "button"; add.className = "tab add edit-only"; add.textContent = "+ Ajouter un format";
  add.onclick = () => {
    const F = newFormat("");
    const ref = curF();
    F.start = ref.start; F.idx = ref.idx; F.tech = ref.tech;
    EV.formats.push(F); EV.cur = EV.formats.length - 1;
    showEvent(); saveWork();
    toast("Format ajouté : donne-lui un nom et dépose sa trace GPX.");
    $("fmtLabel").focus();
  };
  box.append(add);
}
function switchFormat(i) {
  if (i === EV.cur) return;
  EV.cur = i; showEvent(); saveWork();
}

/* ---------- Points ---------- */
function renderPts() {
  const box = $("pts"), F = curF();
  box.innerHTML = "";
  F.points.sort((a, b) => a.km - b.km).forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "pt";
    row.innerHTML = `<input aria-label="Nom du point" id="pn${i}"><button type="button" aria-label="Supprimer ce point" title="Supprimer">✕</button><input class="km" type="number" step="0.1" min="0" aria-label="Kilomètre" id="pk${i}"><select aria-label="Type" id="pt${i}">${TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>`;
    const [n, del, k, t] = row.children;
    n.value = p.name; k.value = p.km; t.value = p.type;
    n.oninput = () => { p.name = n.value; recompute(); };
    k.onchange = () => { p.km = Math.max(0, +k.value || 0); delete p.raw; renderPts(); recompute(); };
    t.onchange = () => { p.type = t.value; recompute(); };
    del.onclick = () => { F.points.splice(F.points.indexOf(p), 1); renderPts(); recompute(); };
    box.appendChild(row);
  });
  if (!F.points.length) box.innerHTML = `<p class="hint">Aucun point intermédiaire. Le tableau contient seulement le départ et l'arrivée.</p>`;
}
function applyPaste() {
  const F = curF();
  const lines = $("paste").value.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const miss = [], added = [];
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const kf = S && S.course.kmFactor ? S.course.kmFactor : 1;
  const snapped = S && F.wpts && F.wpts.length ? TM.snapWaypoints(S.raw, F.wpts).map((w) => ({ ...w, km: +(w.km * kf).toFixed(2) })) : [];
  lines.forEach((l) => {
    const m = l.split(/[;\t|]/);
    const name = m[0].trim();
    const km = m[1] != null ? parseFloat(m[1].replace(",", ".")) : NaN;
    if (Number.isFinite(km)) { added.push({ name, km, type: guessType(name) }); return; }
    const hit = snapped.find((w) => norm(w.name) === norm(name)) || snapped.find((w) => norm(w.name).includes(norm(name)) || norm(name).includes(norm(w.name)));
    if (hit) added.push({ name, km: hit.km, type: guessType(name) }); else miss.push(name);
  });
  if (added.length) F.points = added;
  const msg = $("pasteMsg");
  msg.hidden = false;
  msg.classList.toggle("err", miss.length > 0);
  msg.textContent = `${added.length} point(s) créé(s).` + (miss.length ? ` Introuvable(s) dans le GPX, ajoute le km après un point-virgule : ${miss.join(", ")}.` : "");
  renderPts(); recompute();
}

/* ---------- Recalcul du format affiché ---------- */
let pending = 0, seq = 0;
function recompute() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => recomputeNow());
}
async function recomputeNow() {
  const my = ++seq;
  const ctx = await computeFormat(curF());
  if (my !== seq) return;
  S = ctx;
  renderAll();
  saveWork();
}

/* ---------- Format ---------- */
const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const p2 = (n) => String(n).padStart(2, "0");
function clock(ms, withDay) { const d = new Date(ms); return (withDay ? DAYS[d.getDay()] + " " : "") + `${p2(d.getHours())}:${p2(d.getMinutes())}`; }
function dur(h) { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h${p2(m % 60)}`; }
function multiDay(res) {
  const a = new Date(res.start), end = Math.max(res.rows[res.rows.length - 1].lastModel, ...res.rows.map((r) => r.bhMs || 0));
  return a.toDateString() !== new Date(end).toDateString();
}

/* ---------- Barrières horaires saisies ---------- */
const DAY_KEYS = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
// accepte « ven. 21:15 », « ven 21h15 », « vendredi 21:15 », « 21:15 », « 21h »
function parseBH(txt, refMs, startMs) {
  const s = String(txt || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (!s) return null;
  const m = s.match(/^(?:([a-z]{3})[a-z]*\.?\s*)?(\d{1,2})\s*[:h]\s*(\d{2})?$/);
  if (!m) return NaN;
  const hh = +m[2], mm = m[3] ? +m[3] : 0;
  if (hh > 23 || mm > 59) return NaN;
  if (m[1]) {
    const wd = DAY_KEYS.indexOf(m[1]);
    if (wd < 0) return NaN;
    const d = new Date(startMs); d.setHours(hh, mm, 0, 0);
    const add = (wd - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + add);
    if (d.getTime() < startMs) d.setDate(d.getDate() + 7);
    return d.getTime();
  }
  const d = new Date(refMs); d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= refMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}
/* Le dernier coureur ne peut pas passer un point après sa barrière : s'il est en retard,
   le nouveau dernier est celui qui passe pile à la barrière, et il continue à l'allure du dernier modélisé. */
function applyBH(res, F) {
  let ref = res.start, prev = res.start;
  res.bhErrors = [];
  res.rows.forEach((r, i) => {
    r.lastModel = r.last;
    const txt = i === 0 ? "" : (i === res.rows.length - 1 ? F.finishBh : (r.pt && r.pt.bh) || "");
    r.bhTxt = txt;
    r.bhMs = null; r.bind = false; r.bhBad = false; r.bhEarly = false;
    let t = i === 0 ? res.start : prev + (res.rows[i].lastModel - res.rows[i - 1].lastModel);
    if (txt) {
      const ms = parseBH(txt, ref, res.start);
      if (Number.isNaN(ms) || ms == null) { r.bhBad = true; res.bhErrors.push(r.name); }
      else {
        r.bhMs = ms; ref = ms;
        if (ms < r.lead) r.bhEarly = true;
        if (t > ms) { t = ms; r.bind = true; }
      }
    }
    r.last = t; prev = t;
  });
  res.lastModelH = res.lastH;
  res.lastH = (res.rows[res.rows.length - 1].last - res.start) / 3.6e6;
}
function hasBH(ctx) { return ctx.res.rows.some((r) => r.bhMs); }
function rowsOut(ctx) {
  const res = ctx.res, md = multiDay(res), fem = res.femH != null;
  return res.rows.map((r, i) => {
    const o = {
      n: i ? (i === res.rows.length - 1 ? "A" : String(i)) : "D", name: r.name, type: i && i < res.rows.length - 1 ? TYPE_LABEL[r.type] : "",
      km: r.km.toFixed(1), alt: Math.round(r.alt),
      dkm: i ? r.dkm.toFixed(1) : "", dup: i ? "+" + Math.round(r.dup) : "", ddown: i ? "-" + Math.round(r.ddown) : "",
      up: "+" + Math.round(r.up), down: "-" + Math.round(r.down),
      lead: clock(r.lead, md), leadE: dur((r.lead - res.start) / 3.6e6),
      last: clock(r.last, md), lastE: dur((r.last - res.start) / 3.6e6),
    };
    if (fem) { o.fem = clock(r.fem, md); o.femE = dur((r.fem - res.start) / 3.6e6); }
    o.bh = r.bhMs ? clock(r.bhMs, md) : "";
    return o;
  });
}
function fmtTitle(F) { const ev = (EV.name || "").trim() || "Course sans nom", l = (F.label || "").trim(); return l ? `${ev} - ${l}` : ev; }

/* ---------- Rendu ---------- */
function renderAll() {
  const F = curF();
  $("title").textContent = fmtTitle(F);
  $("fmtHead").textContent = (F.label || "").trim() ? "· " + F.label.trim() : "";
  $("emptyFmt").hidden = !!S; $("fmtView").hidden = !S;
  if (!S) return;
  const res = S.res, c = S.course, o = optsOf(F);
  const maxAlt = Math.max(...c.ele), fem = res.femH != null;
  $("stats").innerHTML = [
    ["Distance", c.total.toFixed(1) + " km"], ["D+ / D-", `${Math.round(c.dplus)} / ${Math.round(c.dminus)}`],
    ["Point haut", Math.round(maxAlt) + " m"], ["Km-effort", Math.round(res.kme)],
    ["Tête · " + o.idx, dur(res.leadH), "lead"],
    ...(fem ? [["1re femme · " + o.idxF, dur(res.femH), "fem"]] : []),
    ["Dernier finisher", dur(res.lastH), "last", Math.abs(res.lastH - res.lastModelH) > 0.01 ? `sans BH : ${dur(res.lastModelH)}` : ""],
  ].map(([l, v, k, note]) => `<div class="stat ${k || ""}"><span>${l}</span><b>${v}</b>${note ? `<small>${note}</small>` : ""}</div>`).join("");

  const R = rowsOut(S);
  let h = `<thead><tr><th colspan="4"></th><th colspan="3" class="grp">Section</th><th colspan="2" class="grp">Cumul</th><th class="grp g-lead" colspan="2">Tête de course</th>${fem ? `<th class="grp g-fem" colspan="2">1re femme</th>` : ""}<th class="grp g-last" colspan="2">Dernier coureur</th><th class="grp g-bh">BH</th></tr>
  <tr><th class="l">N°</th><th class="l">Point</th><th>Alt.</th><th>Km</th><th>Km</th><th>D+</th><th>D-</th><th>D+</th><th>D-</th><th>Heure</th><th>Temps</th>${fem ? "<th>Heure</th><th>Temps</th>" : ""}<th>Heure</th><th>Temps</th><th>Saisie</th></tr></thead><tbody>`;
  R.forEach((o, i) => {
    const r = res.rows[i];
    const tag = o.type ? ` <span class="tag ${r.type}">${o.type}</span>` : "";
    h += `<tr class="${i === R.length - 1 ? "end" : ""}"><td class="l num">${o.n}</td><td class="l name">${esc(o.name)}${tag}</td><td class="num">${o.alt}</td><td class="num">${o.km}</td><td class="num">${o.dkm}</td><td class="num">${o.dup}</td><td class="num">${o.ddown}</td><td class="num">${o.up}</td><td class="num">${o.down}</td>
    <td class="lead">${o.lead}</td><td class="num">${o.leadE}</td>${fem ? `<td class="fem">${o.fem}</td><td class="num">${o.femE}</td>` : ""}<td class="last${r.bind ? " bind" : ""}" title="${r.bind ? "Recalé sur la barrière horaire" : ""}">${o.last}</td><td class="num">${o.lastE}</td><td class="bhcell">${i ? `<input ${VIEWER ? "readonly tabindex=\"-1\" " : ""}class="bhin${r.bhBad ? " bad" : ""}${r.bhEarly ? " early" : ""}" data-row="${i}" value="${esc(r.bhBad ? r.bhTxt : o.bh)}" placeholder="—" aria-label="Barrière horaire ${esc(o.name)}" title="${r.bhEarly ? "Cette barrière tombe avant le passage de la tête" : ""}">` : ""}</td></tr>`;
  });
  $("tbl").innerHTML = h + "</tbody>";
  drawProfile($("prof"), S);
}
function esc(s) { return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])); }

function tokens() {
  const cs = getComputedStyle(document.documentElement), g = (k) => cs.getPropertyValue(k).trim();
  return { bg: g("--surface"), ink: g("--ink"), muted: g("--muted"), line: g("--line"), accent: g("--accent"), fill: g("--lead"), night: g("--night"), font: "IBM Plex Sans, sans-serif" };
}
const PRINT_PAL = { bg: "#ffffff", ink: "#17201d", muted: "#5a6762", line: "#d6ddd8", accent: "#e1502a", fill: "#1d6c88", night: "rgba(23,32,29,.07)", font: "Helvetica, Arial, sans-serif" };

function drawProfile(cv, ctx, pal, W, H) {
  if (!ctx) return;
  const c = ctx.course, res = ctx.res;
  pal = pal || tokens();
  const dpr = W ? 2 : (window.devicePixelRatio || 1);
  W = W || cv.clientWidth; H = H || cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.fillStyle = pal.bg; x.fillRect(0, 0, W, H);
  const L = 44, Rm = 40, T = 96, B = 24, pw = W - L - Rm, ph = H - T - B;
  let lo = Math.min(...c.ele), hi = Math.max(...c.ele);
  const span = Math.max(200, hi - lo), stepA = span > 1500 ? 500 : span > 600 ? 200 : 100;
  lo = Math.floor((lo - span * 0.05) / stepA) * stepA; hi = Math.ceil((hi + span * 0.05) / stepA) * stepA;
  const X = (k) => L + (k / c.total) * pw, Y = (a) => T + ph - ((a - lo) / (hi - lo)) * ph;
  // nuit (dernier coureur)
  x.fillStyle = pal.night;
  const rows = res.rows;
  for (let i = 1; i < rows.length; i++) {
    const n0 = ctx.nightFn(rows[i - 1].last), n1 = ctx.nightFn(rows[i].last);
    if (n0 || n1) x.fillRect(X(rows[i - 1].km), T, X(rows[i].km) - X(rows[i - 1].km), ph);
  }
  // grille
  x.font = `11px ${pal.font}`; x.fillStyle = pal.muted; x.strokeStyle = pal.line; x.lineWidth = 1;
  x.textAlign = "right"; x.textBaseline = "middle";
  for (let a = lo; a <= hi; a += stepA) { x.beginPath(); x.moveTo(L, Y(a) + .5); x.lineTo(W - Rm, Y(a) + .5); x.stroke(); x.fillText(a, L - 6, Y(a)); }
  const kStep = c.total > 120 ? 20 : c.total > 50 ? 10 : c.total > 20 ? 5 : 2;
  x.textAlign = "center"; x.textBaseline = "top";
  for (let k = 0; k <= c.total; k += kStep) x.fillText(k + " km", X(k), T + ph + 6);
  // profil
  x.beginPath(); x.moveTo(X(0), Y(lo));
  for (let i = 0; i < c.km.length; i += 2) x.lineTo(X(c.km[i]), Y(c.ele[i]));
  x.lineTo(X(c.total), Y(lo)); x.closePath();
  x.globalAlpha = .22; x.fillStyle = pal.fill; x.fill(); x.globalAlpha = 1;
  x.beginPath();
  for (let i = 0; i < c.km.length; i += 2) i ? x.lineTo(X(c.km[i]), Y(c.ele[i])) : x.moveTo(X(c.km[i]), Y(c.ele[i]));
  x.strokeStyle = pal.fill; x.lineWidth = 1.6; x.stroke();
  // points
  x.textAlign = "left"; x.textBaseline = "middle";
  rows.forEach((r, i) => {
    const px = X(r.km), py = Y(r.alt);
    x.strokeStyle = pal.accent; x.globalAlpha = .55; x.setLineDash([2, 3]);
    x.beginPath(); x.moveTo(px + .5, py); x.lineTo(px + .5, T - 4); x.stroke(); x.setLineDash([]); x.globalAlpha = 1;
    x.fillStyle = pal.accent; x.beginPath(); x.arc(px, py, i === 0 || i === rows.length - 1 ? 4 : 3.2, 0, 7); x.fill();
    x.save(); x.translate(px + 3, T - 6); x.rotate(-Math.PI / 4.2);
    x.fillStyle = pal.ink; x.font = `600 10.5px ${pal.font}`;
    const lbl = r.name.length > 20 ? r.name.slice(0, 19) + "…" : r.name;
    x.fillText(lbl, 0, 0); x.restore();
  });
  return cv;
}

/* ---------- Exports (tous les formats dans un seul document) ---------- */
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 4500); }
async function offer(filename, blob) {
  if (window.tempo) {
    const r = await window.tempo.saveFile(filename, new Uint8Array(await blob.arrayBuffer()));
    if (r && r.ok) { toast("Fichier enregistré : " + r.path.split("/").pop()); return true; }
    if (r && r.error) toast("Enregistrement impossible : " + r.error);
    return false;
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
function slug() { return ((EV.name || "").trim() || "course").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "course"; }
function subtitle(ctx) {
  const F = ctx.F, o = optsOf(F), c = ctx.course, d = new Date(o.startMs);
  const date = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return `Départ ${date} à ${clock(o.startMs)} · ${c.total.toFixed(1)} km · D+ ${Math.round(c.dplus)} m · D- ${Math.round(c.dminus)} m · cote UTMB tête ${o.idx}${o.idxF ? " · 1re femme " + o.idxF : ""} · technicité ${TECH_LABEL[o.tech] || "standard"}`;
}
const TECH_LABEL = { roulant: "roulant", standard: "standard", technique: "technique", tres: "très technique" };
function exportCols(ctx) {
  const fem = ctx.res.femH != null, bh = hasBH(ctx);
  const cols = [["N°", "n"], ["Point", "name"], ["Type", "type"], ["Alt.", "alt"], ["Km", "km"], ["Δ km", "dkm"], ["Δ D+", "dup"], ["Δ D-", "ddown"], ["D+ cumul", "up"], ["D- cumul", "down"], ["Tête", "lead"], ["Tps tête", "leadE"]];
  if (fem) cols.push(["1re femme", "fem"], ["Tps femme", "femE"]);
  cols.push(["Dernier", "last"], ["Tps dernier", "lastE"]);
  if (bh) cols.push(["BH", "bh"]);
  return cols;
}
function profilePNG(ctx) {
  const cv = document.createElement("canvas");
  drawProfile(cv, ctx, PRINT_PAL, 1100, 300);
  return cv.toDataURL("image/png");
}
async function allContexts() {
  const out = [];
  for (const F of EV.formats) { const ctx = await computeFormat(F); if (ctx) out.push(ctx); }
  return out;
}

$("bPdf").onclick = async () => {
  if (!window.jspdf) { toast("Le module PDF n'a pas pu se charger."); return; }
  const ctxs = await allContexts();
  if (!ctxs.length) { toast("Aucun format n'a de trace : dépose au moins un GPX avant d'exporter."); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const accent = [225, 80, 42];
  ctxs.forEach((ctx, n) => {
    if (n) doc.addPage();
    doc.setTextColor(0);
    doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text(`Temporisation - ${fmtTitle(ctx.F)}`, 12, 15);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90); doc.text(subtitle(ctx).replace(/·/g, "-"), 12, 21);
    doc.addImage(profilePNG(ctx), "PNG", 12, 25, 273, 74.5);
    const cols = exportCols(ctx), R = rowsOut(ctx);
    doc.autoTable({
      startY: 102, margin: { left: 12, right: 12 },
      head: [cols.map((c) => c[0].replace("Δ", "Sec."))],
      body: R.map((o) => cols.map((c) => o[c[1]] ?? "")),
      styles: { font: "helvetica", fontSize: 7.4, cellPadding: 1.4, halign: "right", lineColor: [214, 221, 216], lineWidth: 0.1 },
      headStyles: { fillColor: [23, 32, 29], textColor: 255, fontStyle: "bold", halign: "right" },
      columnStyles: { 0: { halign: "left" }, 1: { halign: "left", fontStyle: "bold", cellWidth: 40 }, 2: { halign: "left" } },
      alternateRowStyles: { fillColor: [244, 246, 244] },
      didParseCell: (d) => {
        if (d.section !== "body") return;
        const k = cols[d.column.index][1];
        if (k === "lead") d.cell.styles.textColor = [29, 108, 136];
        if (k === "fem") d.cell.styles.textColor = [168, 51, 106];
        if (k === "last") d.cell.styles.textColor = [148, 101, 16];
        if (k === "bh") d.cell.styles.textColor = accent;
        if (["lead", "fem", "last", "bh"].includes(k)) d.cell.styles.fontStyle = "bold";
      },
    });
  });
  const skipped = EV.formats.length - ctxs.length;
  if (!VIEWER) await archiveCurrent(true);
  const ok = await offer(`temporisation-${slug()}.pdf`, doc.output("blob"));
  if (VIEWER) return;
  if (ok) toast(`PDF enregistré (${ctxs.length} format${ctxs.length > 1 ? "s" : ""}) et rangé dans les archives.` + (skipped ? ` ${skipped} format(s) sans trace laissé(s) de côté.` : ""));
  else toast("Document rangé dans les archives." + (skipped ? ` ${skipped} format(s) sans trace laissé(s) de côté.` : ""));
};

/* --- DOCX écrit à la main (zip sans compression) --- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  files.forEach(([name, data]) => {
    const nb = enc.encode(name), d = typeof data === "string" ? enc.encode(data) : data, crc = crc32(d);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(h.buffer), nb, d);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nb);
    off += 30 + nb.length + d.length;
  });
  const csize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
function xe(s) { return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])); }
function buildDocx(ctxs) {
  const colorOf = { lead: "1D6C88", fem: "A8336A", last: "946510", bh: "E1502A" };
  const run = (t, o = {}) => `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${o.b ? "<w:b/>" : ""}${o.color ? `<w:color w:val="${o.color}"/>` : ""}<w:sz w:val="${o.sz || 16}"/></w:rPr><w:t xml:space="preserve">${xe(t)}</w:t></w:r>`;
  const cell = (t, o = {}) => `<w:tc><w:tcPr>${o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : ""}<w:tcMar><w:top w:w="30" w:type="dxa"/><w:bottom w:w="30" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:jc w:val="${o.left ? "left" : "right"}"/></w:pPr>${run(t, o)}</w:p></w:tc>`;
  const b = "single", bc = "D6DDD8";
  const imgW = 9144000, imgH = Math.round(imgW * 300 / 1100);
  const rels = [], media = [];
  const body = ctxs.map((ctx, n) => {
    const cols = exportCols(ctx), R = rowsOut(ctx);
    const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cols.map((c, i) => cell(c[0], { b: 1, fill: "17201D", color: "FFFFFF", left: i < 3 })).join("")}</w:tr>`;
    const rows = R.map((o, ri) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cols.map((c, i) => cell(o[c[1]] ?? "", { left: i < 3, b: i === 1 || !!colorOf[c[1]], color: colorOf[c[1]], fill: ri % 2 ? "F4F6F4" : null })).join("")}</w:tr>`).join("");
    const tbl = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="${b}" w:sz="4" w:color="${bc}"/><w:bottom w:val="${b}" w:sz="4" w:color="${bc}"/><w:insideH w:val="${b}" w:sz="4" w:color="${bc}"/></w:tblBorders><w:tblLayout w:type="autofit"/></w:tblPr>${head}${rows}</w:tbl>`;
    const rid = "rIdImg" + n, fn = `profil${n}.png`;
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fn}"/>`);
    media.push([`word/media/${fn}`, Uint8Array.from(atob(profilePNG(ctx).split(",")[1]), (ch) => ch.charCodeAt(0))]);
    const img = `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${imgW}" cy="${imgH}"/><wp:docPr id="${n + 1}" name="Profil ${n + 1}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n + 1}" name="${fn}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${imgW}" cy="${imgH}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    return `<w:p><w:pPr>${n ? '<w:pageBreakBefore/>' : ""}<w:spacing w:after="40"/></w:pPr>${run("Temporisation - " + fmtTitle(ctx.F), { b: 1, sz: 36 })}</w:p>
<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${run(subtitle(ctx), { sz: 18, color: "5A6762" })}</w:p>
${img}${tbl}`;
  }).join("");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
${body}
<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`],
    ["word/document.xml", doc],
    ...media,
  ]);
}
$("bDocx").onclick = async () => {
  const ctxs = await allContexts();
  if (!ctxs.length) { toast("Aucun format n'a de trace : dépose au moins un GPX avant d'exporter."); return; }
  await offer(`temporisation-${slug()}.docx`, buildDocx(ctxs));
};

/* ---------- Événements ---------- */
const file = $("file"), drop = $("drop");
drop.onclick = () => file.click();
drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } };
function readFile(f) {
  if (!f) return;
  f.text().then(async (t) => { try { await loadGPX(t); } catch (err) { $("gpxMsg").textContent = err.message; $("gpxMsg").classList.add("err"); } });
  file.value = "";
}
file.onchange = () => readFile(file.files[0]);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); readFile(e.dataTransfer.files[0]); };
const bind = (id, key, num) => $(id).addEventListener("input", () => { const v = $(id).value; curF()[key] = num ? (v === "" ? "" : +v) : v; recompute(); });
bind("start", "start"); bind("tech", "tech"); bind("dplus", "dplus", true); bind("dminus", "dminus", true);
$("dist").addEventListener("input", () => { const v = $("dist").value; curF().dist = v === "" ? "" : +v; convertRawPoints(curF()).then((ch) => { if (ch) renderPts(); recompute(); }); });
$("fmtRunners").addEventListener("input", () => { curF().runners = $("fmtRunners").value === "" ? "" : +$("fmtRunners").value; saveWork(); });
$("evName").addEventListener("input", () => { EV.name = $("evName").value; renderAll(); saveWork(); });
$("fmtLabel").addEventListener("input", () => { curF().label = $("fmtLabel").value; renderTabs(); renderAll(); saveWork(); });
$("idx").oninput = () => { $("idxR").value = $("idx").value; curF().idx = +$("idx").value; recompute(); };
$("idxR").oninput = () => { $("idx").value = $("idxR").value; curF().idx = +$("idxR").value; recompute(); };
$("idxF").oninput = () => { if ($("idxF").value) $("idxFR").value = $("idxF").value; curF().idxF = $("idxF").value; recompute(); };
$("idxFR").oninput = () => { $("idxF").value = $("idxFR").value; curF().idxF = $("idxFR").value; recompute(); };
$("addPt").onclick = () => { const k = S ? +(S.course.total / 2).toFixed(1) : 1; curF().points.push({ name: "Nouveau point", km: k, type: "passage" }); renderPts(); recompute(); };
$("clearPts").onclick = () => { curF().points = []; renderPts(); recompute(); };
$("applyPaste").onclick = applyPaste;
$("dupFmt").onclick = () => {
  const F = clone(curF()); F.id = uid("f"); F.label = ((F.label || "").trim() + " (copie)").trim();
  EV.formats.splice(EV.cur + 1, 0, F); EV.cur++;
  showEvent(); saveWork(); toast("Format dupliqué, avec sa trace, ses points et ses barrières.");
};
$("delFmt").onclick = () => {
  const b = $("delFmt");
  if (EV.formats.length < 2) return;
  if (!b.dataset.armed) {
    b.dataset.armed = "1"; b.textContent = "Confirmer la suppression"; b.classList.add("danger");
    setTimeout(() => { delete b.dataset.armed; b.textContent = "Supprimer ce format"; b.classList.remove("danger"); }, 4000);
    return;
  }
  delete b.dataset.armed; b.textContent = "Supprimer ce format"; b.classList.remove("danger");
  EV.formats.splice(EV.cur, 1); EV.cur = Math.max(0, EV.cur - 1);
  showEvent(); saveWork(); gcTracks();
};
$("newEvent").onclick = async () => {
  const b = $("newEvent");
  if (!EV.archiveId && !b.dataset.armed) {
    b.dataset.armed = "1"; b.textContent = "Repartir de zéro ? Confirmer"; b.classList.add("danger");
    setTimeout(() => { delete b.dataset.armed; b.textContent = "Nouvel événement"; b.classList.remove("danger"); }, 4000);
    return;
  }
  delete b.dataset.armed; b.textContent = "Nouvel événement"; b.classList.remove("danger");
  if (EV.archiveId) await archiveCurrent(false);
  EV = { name: "", formats: [newFormat("")], cur: 0, archiveId: null };
  await showEvent(); saveWork();
  toast("Nouvel événement : nomme-le, puis ajoute un onglet par format avec sa trace.");
  $("evName").focus();
};
/* import du fichier exporté depuis la version en ligne (ou depuis une autre appli) */
async function importArchives(text) {
  let d; try { d = JSON.parse(text); } catch (e) { toast("Ce fichier n'est pas un export d'archives Tempo Ultra."); return; }
  if (!d || d.type !== "tempo-ultra-archives" || !Array.isArray(d.archives)) { toast("Ce fichier n'est pas un export d'archives Tempo Ultra."); return; }
  for (const [id, a] of Object.entries(d.tracks || {})) await storeOp("t", "readwrite", (st) => st.put(a, id));
  let n = 0;
  for (const r of d.archives) { if (!r || !r.id || !r.ev) continue; await storeOp("a", "readwrite", (st) => st.put(r, r.id)); n++; }
  $("arcBox").open = true; await renderArchives();
  toast(`${n} archive(s) importée(s). Clique sur « Ouvrir » pour reprendre un événement.`);
}
$("arcImport").onclick = () => $("arcFile").click();
$("arcFile").onchange = () => { const f = $("arcFile").files[0]; if (f) f.text().then(importArchives); $("arcFile").value = ""; };
$("arcSave").onclick = async () => { await archiveCurrent(false); $("arcBox").open = true; toast("Événement enregistré dans les archives."); };
$("arcQ").addEventListener("input", renderArchives);
$("tbl").addEventListener("change", (e) => {
  const inp = e.target.closest(".bhin");
  if (!inp || !S) return;
  const i = +inp.dataset.row, r = S.res.rows[i];
  if (i === S.res.rows.length - 1) curF().finishBh = inp.value.trim(); else if (r.pt) r.pt.bh = inp.value.trim();
  recomputeNow().then(() => {
    if (S.res.bhErrors.length) toast("Format de barrière non reconnu : écris par exemple « ven. 21:15 » ou « 21:15 ».");
    else if (S.res.rows.some((x) => x.bhEarly)) toast("Une barrière tombe avant le passage prévu de la tête : vérifie le jour.");
  });
});
$("tbl").addEventListener("keydown", (e) => { if (e.target.classList.contains("bhin") && e.key === "Enter") e.target.blur(); });
$("prof").addEventListener("click", (e) => {
  if (!S || VIEWER) return;
  const r = e.target.getBoundingClientRect(), L = 44, pw = r.width - L - 40;
  const k = ((e.clientX - r.left - L) / pw) * S.course.total;
  if (k <= 0.1 || k >= S.course.total - 0.1) return;
  curF().points.push({ name: `Point km ${k.toFixed(1)}`, km: +k.toFixed(1), type: "passage" });
  renderPts(); recompute();
  toast(`Point ajouté au km ${k.toFixed(1)}. Renomme-le dans la liste.`);
});
const redraw = () => S && drawProfile($("prof"), S);
new ResizeObserver(redraw).observe($("prof"));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

/* ---------- Flux de course : animation de tous les formats ---------- */
const FX = { on: false, data: null, t: 0, playing: false, speed: 1800, last: 0, raf: 0 };
const FCOL = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"];
const fcol = (i) => getComputedStyle(document.documentElement).getPropertyValue(FCOL[i % FCOL.length]).trim();
const DOTS = () => Math.max(10, Math.min(300, Math.round(TM.getParams().flux.dots || 70)));   // points dessinés par format
const SPREAD_ = () => TM.getParams().flux.spread || 1;   // répartition du peloton entre la tête et le dernier
const wOf = (q) => Math.pow(q, SPREAD_());

async function buildFlux() {
  const ctxs = await allContexts();
  const fm = [];
  ctxs.forEach((ctx) => {
    const res = ctx.res, c = ctx.course, rows = res.rows;
    const L = res.leadCurve, Z = res.lastCurve;
    // le dernier recalé sur les barrières : on déforme sa courbe entre deux points de passage
    const zt = Z.map(([km, t]) => {
      let i = 1; while (i < rows.length - 1 && rows[i].km < km) i++;
      const a = rows[i - 1], b = rows[i], span = (b.lastModel - a.lastModel) || 1;
      return a.last + (t - a.lastModel) * (b.last - a.last) / span;
    });
    const km = L.map((p) => p[0]), lt = L.map((p) => p[1]);
    // pour chaque format : position géographique le long de la trace
    const n = c.km.length;
    const ll = (k) => { const x = Math.min(n - 1, Math.max(0, k / c.total * (n - 1))); const i = Math.floor(x), f = x - i, j = Math.min(n - 1, i + 1); return [c.lat[i] + f * (c.lat[j] - c.lat[i]), c.lon[i] + f * (c.lon[j] - c.lon[i])]; };
    const idx = EV.formats.indexOf(ctx.F);
    fm.push({ F: ctx.F, idx, label: (ctx.F.label || "").trim() || `Format ${idx + 1}`, color: fcol(idx), total: c.total, km, lt, zt, ll, rows, start: res.start,
      end: zt[zt.length - 1], leadEnd: lt[lt.length - 1], runners: +ctx.F.runners || 0, course: c, nightFn: ctx.nightFn, gpx: tracks.get(ctx.F.trackId) });
  });
  if (!fm.length) return null;
  return fluxFilter({ all: fm });
}
// ne garde que les formats cochés ; l'horloge s'adapte aux formats affichés
function fluxFilter(d) {
  const hid = new Set(EV.fxHidden || []);
  let fm = d.all.filter((f) => !hid.has(f.F.id));
  d.none = !fm.length;
  if (!fm.length) fm = [];
  const src = fm.length ? fm : d.all;
  d.fm = fm;
  d.tmin = Math.min(...src.map((f) => f.start)); d.tmax = Math.max(...src.map((f) => f.end)) + 20 * 60000;
  return d;
}
function renderFxFmts(d) {
  const hid = new Set(EV.fxHidden || []);
  $("fxFmts").innerHTML = `<span class="lbl">Formats affichés</span>` + d.all.map((f) =>
    `<label class="fxchip${hid.has(f.F.id) ? " off" : ""}" style="--fc:${f.color}"><input type="checkbox" data-fid="${f.F.id}" ${hid.has(f.F.id) ? "" : "checked"}>${esc(f.label)}</label>`).join("") +
    (d.all.length > 1 ? ` <button type="button" class="ghost sm" id="fxAll">Tout cocher</button>` : "");
}
function applyFxFilter() {
  const d = FX.data; if (!d) return;
  fluxFilter(d); renderFxFmts(d);
  const sl = $("fxTime"); sl.min = d.tmin; sl.max = d.tmax;
  if (!(FX.t >= d.tmin && FX.t <= d.tmax)) FX.t = d.tmin;
  sl.value = FX.t;
  mapBuild(d); drawFlux();
}
$("fxFmts").addEventListener("change", (e) => {
  const id = e.target.dataset.fid; if (!id) return;
  const hid = new Set(EV.fxHidden || []);
  if (e.target.checked) hid.delete(id); else hid.add(id);
  EV.fxHidden = [...hid]; if (!VIEWER) saveWork();
  applyFxFilter();
});
$("fxFmts").addEventListener("click", (e) => { if (e.target.id === "fxAll") { EV.fxHidden = []; if (!VIEWER) saveWork(); applyFxFilter(); } });
// position (km) d'un coureur de rang relatif w (0 = tête, 1 = dernier) à l'heure t
function kmAt(f, w, t) {
  const T = (s) => f.lt[s] + w * (f.zt[s] - f.lt[s]);
  const N = f.km.length;
  if (t < f.start) return null;
  if (t >= T(N - 1)) return f.total;
  let lo = 0, hi = N - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T(m) <= t) lo = m; else hi = m; }
  const a = T(lo), b = T(hi);
  return f.km[lo] + (b > a ? (t - a) / (b - a) : 0) * (f.km[hi] - f.km[lo]);
}
function placeName(f, km) {
  if (km == null) return "pas parti";
  if (km >= f.total - 0.05) return "arrivé";
  let last = null;
  f.rows.forEach((r) => { if (r.km <= km + 0.05) last = r; });
  return last && last.km > 0 ? `après ${last.name}` : "après le départ";
}
function fluxState(f, t) {
  const kLead = kmAt(f, 0, t), kLast = kmAt(f, 1, t);
  const kQ1 = kmAt(f, wOf(0.25), t), kQ3 = kmAt(f, wOf(0.75), t), kMed = kmAt(f, wOf(0.5), t);
  // part des coureurs arrivés : rang w tel que T_w(fin) = t
  const a = f.lt[f.lt.length - 1], b = f.zt[f.zt.length - 1];
  let done = 0;
  if (t >= b) done = 1; else if (t > a) done = Math.pow((t - a) / (b - a), 1 / SPREAD_());
  return { kLead, kLast, kQ1, kQ3, kMed, done, started: t >= f.start };
}

function openFlux(show) {
  showView(show ? "flux" : "table");
  if (!show) return;
  buildFlux().then((d) => {
    FX.data = d;
    $("fxEmpty").hidden = !!d; $("fxBody").hidden = !d;
    if (!d) return;
    renderFxFmts(d);
    mapBuild(d);
    const sl = $("fxTime");
    sl.min = d.tmin; sl.max = d.tmax; sl.step = 60000;
    if (!(FX.t >= d.tmin && FX.t <= d.tmax)) FX.t = d.tmin;
    sl.value = FX.t;
    $("fxTitle").textContent = (EV.name || "").trim() || "Événement";
    drawFlux();
  });
}
function setPlaying(p) {
  FX.playing = p;
  $("fxPlay").textContent = p ? "Pause" : "Lecture";
  if (p) { FX.last = performance.now(); FX.raf = requestAnimationFrame(tickFlux); }
  else cancelAnimationFrame(FX.raf);
}
function tickFlux(now) {
  if (!FX.playing || !FX.data) return;
  const dt = Math.min(0.1, (now - FX.last) / 1000); FX.last = now;
  FX.t += dt * FX.speed * 1000;
  if (FX.t >= FX.data.tmax) { FX.t = FX.data.tmax; setPlaying(false); }
  $("fxTime").value = FX.t;
  drawFlux();
  if (FX.playing) FX.raf = requestAnimationFrame(tickFlux);
}

function drawFlux() {
  const d = FX.data; if (!d) return;
  if (!d.fm.length) { mapUpdate(d, FX.t, false); $("fxList").innerHTML = `<li style="--fc:var(--line)"><b>Aucun format coché</b><span>Coche au moins un format au-dessus de la carte.</span></li>`; $("fxBands").style.height = "0px"; return; }
  const t = FX.t, tok = tokens();
  const multi = new Date(d.tmin).toDateString() !== new Date(d.tmax).toDateString();
  $("fxClock").textContent = new Date(t).toLocaleDateString("fr-FR", { weekday: "long" }) + " " + clock(t, false);
  const night = d.fm[0].nightFn(t);
  $("fxNight").textContent = night ? "Nuit" : "Jour";
  $("fxNight").className = "fxday" + (night ? " night" : "");

  /* --- carte (fond IGN, satellite…) --- */
  mapUpdate(d, t, night);
  const dpr = window.devicePixelRatio || 1;

  /* --- bandes par format --- */
  const bv = $("fxBands"), BW = bv.clientWidth, rowH = 54, BH = d.fm.length * rowH + 26;
  bv.style.height = BH + "px"; bv.width = BW * dpr; bv.height = BH * dpr;
  const y = bv.getContext("2d"); y.setTransform(dpr, 0, 0, dpr, 0, 0);
  y.fillStyle = tok.bg; y.fillRect(0, 0, BW, BH);
  const L0 = 110, R0 = 16, maxKm = Math.max(...d.fm.map((f) => f.total)), X = (k) => L0 + k / maxKm * (BW - L0 - R0);
  y.font = `11px ${tok.font}`; y.textBaseline = "top"; y.textAlign = "center"; y.fillStyle = tok.muted;
  const step = maxKm > 120 ? 20 : maxKm > 50 ? 10 : 5;
  for (let k = 0; k <= maxKm; k += step) { y.fillText(k + " km", X(k), BH - 16); y.strokeStyle = tok.line; y.beginPath(); y.moveTo(X(k) + .5, 6); y.lineTo(X(k) + .5, BH - 20); y.stroke(); }
  d.fm.forEach((f, i) => {
    const cy = 12 + i * rowH + rowH / 2 - 6, s = fluxState(f, t);
    y.textAlign = "left"; y.textBaseline = "middle"; y.font = `700 13px ${tok.font}`; y.fillStyle = f.color; y.fillText(f.label, 8, cy - 7);
    y.font = `11px ${tok.font}`; y.fillStyle = tok.muted;
    y.fillText(!s.started ? "départ " + clock(f.start, multi) : s.done >= 1 ? "tous arrivés" : Math.round(s.done * 100) + " % arrivés", 8, cy + 9);
    y.strokeStyle = tok.line; y.lineWidth = 6; y.lineCap = "round"; y.beginPath(); y.moveTo(X(0), cy); y.lineTo(X(f.total), cy); y.stroke(); y.lineCap = "butt";
    f.rows.forEach((r) => { y.fillStyle = tok.muted; y.fillRect(X(r.km) - .5, cy - 9, 1, 18); });
    if (s.kQ1 != null && s.done < 0.75) { y.strokeStyle = f.color; y.globalAlpha = .35; y.lineWidth = 14; y.beginPath(); y.moveTo(X(s.kQ3), cy); y.lineTo(X(s.kQ1), cy); y.stroke(); y.globalAlpha = 1; }
    y.fillStyle = f.color;
    const ND = DOTS(); for (let j = 0; j < ND; j++) { const k = kmAt(f, wOf((j + 0.5) / ND), t); if (k == null) continue; y.globalAlpha = .6; y.beginPath(); y.arc(X(k), cy + ((j * 7) % 11) - 5, 2.4, 0, 7); y.fill(); }
    y.globalAlpha = 1;
    if (s.started) {
      y.beginPath(); y.arc(X(s.kLead), cy, 6, 0, 7); y.fillStyle = f.color; y.fill(); y.strokeStyle = tok.bg; y.lineWidth = 2; y.stroke();
      y.beginPath(); y.arc(X(s.kLast), cy, 5.5, 0, 7); y.fillStyle = tok.bg; y.fill(); y.strokeStyle = f.color; y.lineWidth = 2.5; y.stroke();
    }
  });

  /* --- résumé texte --- */
  $("fxList").innerHTML = d.fm.map((f) => {
    const s = fluxState(f, t), n = f.runners;
    const kmTxt = (k) => k == null ? "—" : `km ${k.toFixed(1)}`;
    const cnt = n ? ` · ${Math.round(s.done * n)} / ${n} arrivés` : "";
    if (!s.started) return `<li style="--fc:${f.color}"><b>${esc(f.label)}</b><span>Départ ${clock(f.start, multi)}</span></li>`;
    return `<li style="--fc:${f.color}"><b>${esc(f.label)}</b>
      <span><i>Tête</i> ${s.kLead >= f.total ? "arrivée à " + clock(f.leadEnd, multi) : kmTxt(s.kLead) + ", " + esc(placeName(f, s.kLead))}</span>
      <span><i>Gros du peloton</i> ${s.done >= 0.75 ? "arrivé" : `${kmTxt(s.kQ3)} à ${kmTxt(s.kQ1).replace("km ", "")}, ${esc(placeName(f, s.kMed))}`}</span>
      <span><i>Dernier</i> ${s.kLast >= f.total ? "arrivé" : kmTxt(s.kLast) + ", " + esc(placeName(f, s.kLast))}</span>
      <span class="done">${Math.round(s.done * 100)} % arrivés${cnt}</span></li>`;
  }).join("");
}

$("bFlux").onclick = () => openFlux(!FX.on);
$("fxPlay").onclick = () => { if (FX.data && FX.t >= FX.data.tmax) FX.t = FX.data.tmin; setPlaying(!FX.playing); };
$("fxTime").addEventListener("input", () => { FX.t = +$("fxTime").value; drawFlux(); });
$("fxSpeed").addEventListener("change", () => { FX.speed = +$("fxSpeed").value; });
$("fxNames").addEventListener("change", () => { if (FX.data) mapBuild(FX.data); drawFlux(); });
$("fxFit").onclick = () => { if (MAP.map && MAP.bounds) MAP.map.fitBounds(MAP.bounds, { padding: [24, 24] }); };
document.querySelectorAll("[data-jump]").forEach((bt) => bt.addEventListener("click", () => {
  if (!FX.data) return;
  const what = bt.dataset.jump, d = FX.data;
  if (what === "start") FX.t = d.tmin;
  else if (what === "-1") FX.t = Math.max(d.tmin, FX.t - 3600000);
  else if (what === "+1") FX.t = Math.min(d.tmax, FX.t + 3600000);
  $("fxTime").value = FX.t; drawFlux();
}));
new ResizeObserver(() => { if (FX.on && MAP.map) MAP.map.invalidateSize(); }).observe($("fxMap"));

/* ---------- Carte Leaflet : fonds de carte et couches animées ---------- */
const IGN = (layer, fmt) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${fmt}`;
const BASES = {
  "Plan IGN": [IGN("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png"), { maxZoom: 19, maxNativeZoom: 19, attribution: "© IGN-F/Géoplateforme" }],
  "Photos aériennes IGN": [IGN("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg"), { maxZoom: 19, maxNativeZoom: 19, attribution: "© IGN-F/Géoplateforme" }],
  "Satellite (monde)": ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, maxNativeZoom: 18, attribution: "© Esri, Maxar, Earthstar Geographics" }],
  "OpenTopoMap": ["https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 19, maxNativeZoom: 17, subdomains: "abc", attribution: "© OpenStreetMap, SRTM · © OpenTopoMap (CC-BY-SA)" }],
  "OpenStreetMap": ["https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© les contributeurs d'OpenStreetMap" }],
};
const MAP = { map: null, base: null, dyn: null, stat: null, bounds: null, key: "" };
function prefGet(k, d) { try { const v = localStorage.getItem("tempo:" + k); return v == null ? d : v; } catch (e) { return d; } }
function prefSet(k, v) { try { localStorage.setItem("tempo:" + k, v); } catch (e) {} }
function mapInit() {
  if (MAP.map || !window.L) return;
  const m = L.map("fxMap", { zoomControl: true, preferCanvas: true, attributionControl: true });
  const layers = {};
  Object.entries(BASES).forEach(([n, [url, o]]) => { layers[n] = L.tileLayer(url, o); });
  const want = prefGet("fond", "Plan IGN");
  (layers[want] || layers["Plan IGN"]).addTo(m);
  L.control.layers(layers, null, { position: "topright", collapsed: false }).addTo(m);
  L.control.scale({ imperial: false }).addTo(m);
  m.on("baselayerchange", (e) => prefSet("fond", e.name));
  MAP.map = m; MAP.renderer = L.canvas({ padding: 0.3 });
  MAP.stat = L.layerGroup().addTo(m); MAP.dyn = L.layerGroup().addTo(m);
}
// couches fixes : traces, points de passage ; couches animées : peloton, coureurs, tête et dernier
function mapBuild(d) {
  if (!window.L) return;
  mapInit();
  const m = MAP.map; m.invalidateSize();
  MAP.stat.clearLayers(); MAP.dyn.clearLayers();
  const key = d.fm.map((f) => f.F.id + ":" + f.total.toFixed(2)).join("|");
  const all = [];
  d.fm.forEach((f) => {
    // trace dessinée avec tous les points du GPX (pas de simplification), sinon la trace rééchantillonnée tous les 25 m
    let ll;
    if (f.gpx && f.gpx.length > 1) ll = f.gpx.map((p) => [p.lat, p.lon]);
    else { const c = f.course; ll = c.lat.map((la, i) => [la, c.lon[i]]); }
    all.push(...ll);
    L.polyline(ll, { color: f.color, weight: 4, opacity: 0.8, smoothFactor: 0.3, renderer: MAP.renderer }).addTo(MAP.stat);
  });
  const seen = new Set(), names = $("fxNames").checked, moving = !VIEWER && $("fxMove").checked;
  $("fxMap").classList.toggle("moving", moving);
  d.fm.forEach((f) => f.rows.forEach((r, ri) => {
    const k = r.name.toLowerCase(); if (seen.has(k)) return; seen.add(k);
    const endpoint = ri === 0 || ri === f.rows.length - 1;
    const icon = L.divIcon({ className: "", html: `<div class="fxpt${r.type === "base" ? " base" : ""}${moving && !endpoint ? " drag" : ""}"></div>`, iconSize: moving && !endpoint ? [18, 18] : [12, 12] });
    const mk = L.marker(f.ll(r.km), { icon, draggable: moving && !endpoint, keyboard: false, zIndexOffset: moving ? 1000 : 0 })
      .bindTooltip(r.name, names ? { permanent: true, direction: "right", offset: [8, 0], className: "fxlbl" } : { direction: "top" });
    if (moving && !endpoint) mk.on("dragend", () => movePoint(r.name, r.km, mk.getLatLng()));
    mk.addTo(MAP.stat);
  }));
  MAP.bounds = all.length ? L.latLngBounds(all) : null;
  if (MAP.bounds && MAP.key !== key) { m.fitBounds(MAP.bounds, { padding: [24, 24] }); MAP.key = key; }
  // couches animées, créées une fois et déplacées à chaque image
  MAP.f = d.fm.map((f) => {
    const band = L.polyline([], { color: f.color, weight: 12, opacity: 0.5, lineCap: "round", renderer: MAP.renderer }).addTo(MAP.dyn);
    const dots = Array.from({ length: DOTS() }, () => L.circleMarker([0, 0], { radius: 3, stroke: false, fillColor: f.color, fillOpacity: 0.75, renderer: MAP.renderer }));
    const lead = L.circleMarker([0, 0], { radius: 8, color: "#ffffff", weight: 2.5, fillColor: f.color, fillOpacity: 1 }).bindTooltip("Tête " + f.label, { permanent: true, direction: "top", offset: [0, -8], className: "fxtag" });
    const last = L.circleMarker([0, 0], { radius: 7, color: f.color, weight: 3, fillColor: "#ffffff", fillOpacity: 1 }).bindTooltip("Dernier " + f.label, { permanent: true, direction: "bottom", offset: [0, 8], className: "fxtag" });
    return { band, dots, lead, last, on: new Set() };
  });
  setTimeout(() => d.fm.forEach((f, i) => { const g = MAP.f[i]; [g.lead, g.last].forEach((mk) => { const el = mk.getTooltip && mk.getTooltip(); if (el) el.options.className = "fxtag"; }); }), 0);
}
/* Un point glissé sur la carte se recale sur la trace (au passage le plus proche du km d'origine, pour les boucles)
   et son km est mis à jour dans tous les formats qui portent ce nom. */
function snapKm(c, ll, oldKm) {
  // passages de la trace à moins de 150 m du point lâché ; dans chaque passage, l'endroit le plus proche
  const passes = []; let cur = null, best = Infinity, bk = oldKm;
  for (let i = 0; i < c.lat.length; i++) {
    const dm = TM.hav({ lat: c.lat[i], lon: c.lon[i] }, { lat: ll.lat, lon: ll.lng }) * 1000;
    if (dm < best) { best = dm; bk = c.km[i]; }
    if (dm < 150) { if (!cur) { cur = { km: c.km[i], dist: dm }; passes.push(cur); } else if (dm < cur.dist) { cur.km = c.km[i]; cur.dist = dm; } }
    else cur = null;
  }
  if (passes.length) { passes.sort((a, b) => Math.abs(a.km - oldKm) - Math.abs(b.km - oldKm)); return passes[0]; }
  return { km: bk, dist: best };
}
async function movePoint(name, oldKm, ll) {
  const key = name.toLowerCase(), d = FX.data; let moved = 0, info = "";
  for (const f of d.all) {
    const p = f.F.points.find((q) => (q.name || "").trim().toLowerCase() === key);
    if (!p) continue;
    const s = snapKm(f.course, ll, p.km);
    info = `${name} : km ${(+p.km).toFixed(1)} → ${s.km.toFixed(1)}` + (s.dist > 200 ? ` (le point est à ${Math.round(s.dist)} m de la trace, recalé au plus près)` : "");
    p.km = +s.km.toFixed(2); delete p.raw; moved++;
  }
  if (!moved) { toast("Ce point n'est pas modifiable ici."); return; }
  saveWork();
  const keepT = FX.t;
  await recomputeNow(); renderPts();
  FX.data = await buildFlux(); FX.t = keepT;
  applyFxFilter();
  toast(info + (moved > 1 ? ` · mis à jour dans ${moved} formats` : "") + ". Le tableau est recalculé.");
}
$("fxMove").addEventListener("change", () => { if (FX.data) mapBuild(FX.data); drawFlux(); });
function show(layer, on) { const g = MAP.dyn; if (on && !g.hasLayer(layer)) g.addLayer(layer); else if (!on && g.hasLayer(layer)) g.removeLayer(layer); }
function mapUpdate(d, t, night) {
  if (!MAP.map || !MAP.f) return;
  $("fxMap").classList.toggle("night", !!night);
  d.fm.forEach((f, i) => {
    const g = MAP.f[i], s = fluxState(f, t);
    if (s.kQ1 != null && s.kQ3 != null && s.done < 0.75) {
      const k0 = Math.max(0, s.kQ3), k1 = Math.min(f.total, s.kQ1), pts = [];
      for (let k = k0; k <= k1 + 0.01; k += Math.max(0.1, (k1 - k0) / 60)) pts.push(f.ll(k));
      g.band.setLatLngs(pts); show(g.band, true);
    } else show(g.band, false);
    const ND = g.dots.length;
    g.dots.forEach((mk, j) => {
      const k = kmAt(f, wOf((j + 0.5) / ND), t);
      const on = k != null && k < f.total - 0.01;
      if (on) mk.setLatLng(f.ll(k));
      show(mk, on);
    });
    const onL = s.started && s.kLead < f.total, onZ = s.started && s.kLast < f.total;
    if (onL) g.lead.setLatLng(f.ll(s.kLead)); show(g.lead, onL);
    if (onZ) g.last.setLatLng(f.ll(s.kLast)); show(g.last, onZ);
    [g.lead, g.last].forEach((mk) => { const tt = mk.getTooltip(); if (tt && tt.getElement()) tt.getElement().style.background = f.color; });
  });
}

/* ---------- Vues : tableau, flux, réglages, calage ---------- */
const VIEWS = { table: "vTable", flux: "flux", settings: "vSettings", calib: "vCalib", assist: "vAssist" };
let VIEW = "table";
function showView(v) {
  if (VIEW === "flux" && v !== "flux") { FX.playing = false; cancelAnimationFrame(FX.raf); $("fxPlay").textContent = "Lecture"; }
  VIEW = v; FX.on = v === "flux";
  Object.entries(VIEWS).forEach(([k, id]) => { $(id).hidden = k !== v; });
  $("bFlux").textContent = v === "flux" ? "Retour au tableau" : "Flux de course";
  $("bFlux").classList.toggle("primary", v !== "flux");
  $("bSet").classList.toggle("primary", v === "settings");
  $("bCal").classList.toggle("primary", v === "calib");
  $("bAssist").classList.toggle("primary", v === "assist");
  window.scrollTo(0, 0);
}

/* ---------- Réglages du modèle ---------- */
const SET_SCHEMA = [
  ["Tête de course", [
    ["law.win", "Effet meilleure journée du vainqueur", "0,92 = le vainqueur court 8 % plus vite que sa cote ne le prévoit"],
    ["law.a", "Niveau général de la loi", "plus haut = tout le monde plus lent"],
    ["law.b", "Exposant distance-effort", "comment le temps grandit avec les km-effort"],
    ["law.k", "Mètres de D+ valant 1 km", "dans le calcul des km-effort"],
    ["law.steep", "Effet de la raideur du parcours", "par 100 m de D+ par km"],
    ["law.alt", "Effet de l'altitude", "par 1 000 m au-dessus de 1 500 m"],
    ["law.c0", "Écart entre cotes (base)", "plus haut = les cotes basses perdent plus de temps"],
    ["law.c1", "Écart entre cotes selon la longueur", "l'écart entre cotes grandit sur les longs formats"],
  ]],
  ["Usure et formats courts", [
    ["law.wear", "Usure des kilomètres", "sur les longs parcours roulants"],
    ["law.wearKm", "L'usure démarre à (km)", ""],
    ["law.wearSteep", "Plus d'usure au-dessus de (m D+/km)", "parcours plus raides : usure nulle"],
    ["law.short", "Frein des formats courts", "ralentit tête et dernier sous le seuil"],
    ["law.shortKe", "Seuil des formats courts (km-effort)", ""],
  ]],
  ["Technicité", [
    ["tech.roulant", "Roulant (tête)", "multiplie le temps de la tête"],
    ["tech.technique", "Technique", ""],
    ["tech.tres", "Très technique", ""],
    ["tech.lastAmp", "Amplification pour le dernier", "1,5 = le dernier subit 1,5 fois l'effet technique"],
  ]],
  ["Dernier finisher", [
    ["last.r0", "Rapport dernier / cote 945 (base)", ""],
    ["last.r1", "Baisse du rapport par km-effort", ""],
    ["last.rMin", "Rapport minimum", ""], ["last.rMax", "Rapport maximum", ""],
    ["last.tailB", "Traîne des formats courts", "plus haut = derniers plus loin sur les formats courts"],
    ["last.tailP", "Forme de la traîne", ""],
    ["last.tailK", "Traîne nulle au-delà de (km-effort)", ""],
    ["last.tailCap", "Traîne maximale (×)", ""],
  ]],
  ["Profil de la tête", [
    ["profiles.tete.gamma", "Fatigue accumulée", "plus haut = fin de course plus lente"],
    ["profiles.tete.kd", "Coût des descentes raides", ""],
    ["profiles.tete.altSens", "Sensibilité à l'altitude", ""],
    ["profiles.tete.night", "Ralentissement de nuit (×)", ""],
    ["profiles.tete.stops.liquide", "Arrêt ravito liquide (min)", ""],
    ["profiles.tete.stops.complet", "Arrêt ravito complet (min)", ""],
    ["profiles.tete.stops.base", "Arrêt base vie (min)", ""],
  ]],
  ["Profil du dernier", [
    ["profiles.dernier.gamma", "Fatigue accumulée", ""],
    ["profiles.dernier.kd", "Coût des descentes raides", ""],
    ["profiles.dernier.altSens", "Sensibilité à l'altitude", ""],
    ["profiles.dernier.night", "Ralentissement de nuit (×)", ""],
    ["profiles.dernier.stops.liquide", "Arrêt ravito liquide (min)", ""],
    ["profiles.dernier.stops.complet", "Arrêt ravito complet (min)", ""],
    ["profiles.dernier.stops.base", "Arrêt base vie (min)", ""],
  ]],
  ["Flux de course", [
    ["flux.spread", "Répartition du peloton", "1 = la moitié du peloton à mi-chemin entre tête et dernier ; plus haut = peloton tassé derrière la tête"],
    ["flux.dots", "Points par format sur la carte", ""],
  ]],
];
const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => { const ks = p.split("."), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
function renderSettings(p) {
  const box = $("setForm"), D = TM.DEFAULTS;
  box.innerHTML = SET_SCHEMA.map(([title, rows]) => `<section class="panel"><h2>${title}</h2>${rows.map(([path, lbl, help]) =>
    `<div class="setrow"><label for="s_${path}">${lbl}${help ? `<small>${help}</small>` : ""}</label><input id="s_${path}" data-path="${path}" type="number" step="any" value="${getPath(p, path)}" title="Valeur d'origine : ${getPath(D, path)}"></div>`).join("")}</section>`).join("");
  box.querySelectorAll("input").forEach((inp) => { const mark = () => inp.classList.toggle("chg", +inp.value !== +getPath(D, inp.dataset.path)); mark(); inp.addEventListener("input", mark); });
}
function readSettings() {
  const p = TM.getParams();
  $("setForm").querySelectorAll("input").forEach((inp) => { if (inp.value !== "" && Number.isFinite(+inp.value)) setPath(p, inp.dataset.path, +inp.value); });
  return p;
}
async function applyParams(p, save) {
  TM.setParams(p);
  rawCache.clear();
  if (save && !VIEWER) await storeOp("s", "readwrite", (st) => st.put(TM.getParams(), "model"));
  await recomputeNow();
  if (FX.on) openFlux(true);
  shareChanged();
}
$("bSet").onclick = () => { if (VIEW === "settings") { showView("table"); return; } renderSettings(TM.getParams()); showView("settings"); };
$("setCancel").onclick = () => showView("table");
$("setReset").onclick = () => { renderSettings(TM.DEFAULTS); toast("Valeurs d'origine affichées : enregistre pour les appliquer."); };
$("setSave").onclick = async () => { await applyParams(readSettings(), true); toast("Réglages enregistrés : les tableaux sont recalculés."); showView("table"); };
$("openDataDir").onclick = () => window.tempo && window.tempo.openDataDir();

/* ---------- Résultats de courses et recalage ---------- */
let RACES = [], CAL = null, EDIT = null;
const hms = (h) => { if (h == null || !Number.isFinite(h)) return "—"; const m = Math.round(h * 60); return `${Math.floor(m / 60)}h${p2(m % 60)}`; };
function parseDur(s) {
  const m = String(s || "").trim().match(/^(\d{1,3})\s*[:h]\s*(\d{1,2})?(?:\s*[:m']\s*(\d{1,2}))?/);
  return m ? +m[1] + (m[2] ? +m[2] / 60 : 0) + (m[3] ? +m[3] / 3600 : 0) : null;
}
async function loadRaces() {
  RACES = (await storeOp("r", "readonly", (st) => st.getAll())) || [];
  if (!RACES.length && !VIEWER) {
    RACES = RACES_SEED.map((r) => ({ ...r }));
    for (const r of RACES) await storeOp("r", "readwrite", (st) => st.put(r, r.id));
  }
  RACES.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? 1 : -1));
}
function errCell(obs, pred) {
  if (!obs || !pred) return "<td class=\"num\">—</td>";
  const e = pred / obs - 1, c = Math.abs(e) <= 0.05 ? "good" : Math.abs(e) > 0.12 ? "bad" : "";
  return `<td class="num ${c}">${hms(pred)} <small>${e >= 0 ? "+" : ""}${Math.round(e * 100)} %</small></td>`;
}
function renderRaces() {
  const ev = FIT.evaluate(TM, RACES, TM.getParams()), byId = Object.fromEntries(ev.map((o) => [o.id, o]));
  $("calTbl").innerHTML = `<thead><tr><th>Calage</th><th class="l">Course</th><th>Km</th><th>D+</th><th>Pt haut</th><th>Finishers avec cote</th><th>Vainqueur réel</th><th>Modèle</th><th>Dernier réel</th><th>Modèle</th><th></th></tr></thead><tbody>` +
    RACES.map((r) => { const o = byId[r.id] || {};
      return `<tr class="${r.active === false ? "off" : ""}"><td><input type="checkbox" data-act="${r.id}" ${r.active === false ? "" : "checked"} aria-label="Utiliser pour le calage"></td>
      <td class="l"><b>${esc(r.name)}</b>${r.source ? `<small>${esc(r.source)}</small>` : ""}</td><td class="num">${(+r.km).toFixed(1)}</td><td class="num">${Math.round(r.dp)}</td><td class="num">${Math.round(r.alt)}</td>
      <td class="num">${(r.results || []).length || "—"}${r.full ? " <small>complet</small>" : ""}</td><td class="num">${hms(o.winObs)}</td>${errCell(o.winObs, o.winPred)}<td class="num">${hms(o.lastObs)}</td>${errCell(o.lastObs, o.lastPred)}
      <td><button type="button" class="ghost sm" data-edit="${r.id}">Modifier</button> <button type="button" class="ghost sm" data-del="${r.id}">Supprimer</button></td></tr>`; }).join("") + "</tbody>";
}
$("calTbl").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.edit) openRace(RACES.find((r) => r.id === b.dataset.edit));
  if (b.dataset.del) {
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Confirmer"; b.classList.add("danger"); setTimeout(() => { delete b.dataset.armed; b.textContent = "Supprimer"; b.classList.remove("danger"); }, 4000); return; }
    await storeOp("r", "readwrite", (st) => st.delete(b.dataset.del));
    await loadRaces(); renderRaces(); toast("Course retirée de la base.");
  }
});
$("calTbl").addEventListener("change", async (e) => {
  const id = e.target.dataset.act; if (!id) return;
  const r = RACES.find((x) => x.id === id); r.active = e.target.checked;
  await storeOp("r", "readwrite", (st) => st.put(r, r.id)); renderRaces();
});
function openRace(r) {
  EDIT = r || null;
  $("calFormTitle").textContent = r ? "Modifier la course" : "Nouvelle course";
  $("cfName").value = r ? r.name : ""; $("cfKm").value = r ? r.km : ""; $("cfDp").value = r ? r.dp : ""; $("cfAlt").value = r ? r.alt : "";
  $("cfTech").value = r ? r.tech || "standard" : "standard"; $("cfLast").value = r && r.lastH ? hms(r.lastH).replace("h", ":") : "";
  $("cfWinIdx").value = r && r.winner ? r.winner.idx : ""; $("cfWinT").value = r && r.winner ? hms(r.winner.h).replace("h", ":") : "";
  $("cfFull").checked = !!(r && r.full); $("cfSrc").value = r ? r.source || "" : "";
  $("cfRes").value = r && r.results && r.results.length ? r.results.map(([i, h]) => `${i} ; ${hms(h).replace("h", ":")}`).join("\n") : "";
  resInfo(); $("calForm").hidden = false; $("cfName").focus();
}
function resInfo() {
  const p = FIT.parseResults($("cfRes").value);
  $("cfResInfo").textContent = $("cfRes").value.trim() ? `${p.withIdx.length} coureur(s) lu(s) avec cote et temps` + (p.times.length > p.withIdx.length ? `, ${p.times.length - p.withIdx.length} sans cote (servent seulement au temps du dernier si le classement est complet).` : ".") : "";
}
$("cfRes").addEventListener("input", resInfo);
$("calNew").onclick = () => openRace(null);
$("cfCancel").onclick = () => { $("calForm").hidden = true; };
$("cfSave").onclick = async () => {
  const p = FIT.parseResults($("cfRes").value);
  const r = EDIT ? { ...EDIT } : { id: uid("c"), builtin: false, active: true };
  Object.assign(r, { name: $("cfName").value.trim() || "Course sans nom", km: +$("cfKm").value, dp: +$("cfDp").value, alt: +$("cfAlt").value || 0, tech: $("cfTech").value,
    full: $("cfFull").checked, source: $("cfSrc").value.trim(), results: p.withIdx, lastH: parseDur($("cfLast").value) });
  if ($("cfFull").checked && !r.lastH && p.times.length) r.lastH = Math.max(...p.times);
  const wi = +$("cfWinIdx").value, wt = parseDur($("cfWinT").value);
  r.winner = wi && wt ? { idx: wi, h: wt } : null;
  if (!(r.km > 0)) { toast("Indique au moins la distance de la course."); return; }
  if (!r.results.length && !r.winner && !r.lastH) { toast("Donne un classement avec les cotes, le vainqueur ou le temps du dernier : sinon la course n'apporte rien au calage."); return; }
  await storeOp("r", "readwrite", (st) => st.put(r, r.id));
  $("calForm").hidden = true; await loadRaces(); renderRaces();
  toast("Course enregistrée. Clique sur « Recaler le modèle » pour en tenir compte.");
};
$("bCal").onclick = async () => { if (VIEW === "calib") { showView("table"); return; } await loadRaces(); renderRaces(); $("calOut").hidden = true; showView("calib"); };
$("calFit").onclick = async () => {
  const use = RACES.filter((r) => r.active !== false);
  if (!use.length) { toast("Coche au moins une course à utiliser."); return; }
  $("calFit").disabled = true; $("calFit").textContent = "Recalage en cours…";
  await new Promise((r) => setTimeout(r, 30));
  try {
    const before = TM.getParams();
    CAL = FIT.fit(TM, use, before, ["law.k", "law.wearKm", "law.wearSteep", "law.shortKe", "last.tailK"]);
    const A = FIT.evaluate(TM, use, before), B = FIT.evaluate(TM, use, CAL.params);
    const mean = (L, k1, k2) => { const v = L.filter((o) => o[k1] && o[k2]).map((o) => Math.abs(o[k2] / o[k1] - 1)); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 100) : null; };
    $("calReport").innerHTML = CAL.report.map((t) => `<li>${esc(t)}</li>`).join("") +
      `<li>Écart moyen sur le vainqueur : ${mean(A, "winObs", "winPred") ?? "—"} % avant, ${mean(B, "winObs", "winPred") ?? "—"} % après. Sur le dernier : ${mean(A, "lastObs", "lastPred") ?? "—"} % avant, ${mean(B, "lastObs", "lastPred") ?? "—"} % après.</li>`;
    $("calCmp").innerHTML = `<thead><tr><th class="l">Course</th><th>Vainqueur réel</th><th>Avant</th><th>Après</th><th>Dernier réel</th><th>Avant</th><th>Après</th></tr></thead><tbody>` +
      A.map((a, i) => { const b = B[i]; return `<tr><td class="l">${esc(a.name)}</td><td class="num">${hms(a.winObs)}</td>${errCell(a.winObs, a.winPred)}${errCell(b.winObs, b.winPred)}<td class="num">${hms(a.lastObs)}</td>${errCell(a.lastObs, a.lastPred)}${errCell(b.lastObs, b.lastPred)}</tr>`; }).join("") + "</tbody>";
    $("calOut").hidden = false; $("calOut").scrollIntoView({ behavior: "smooth" });
  } finally { $("calFit").disabled = false; $("calFit").textContent = "Recaler le modèle"; }
};
$("calApply").onclick = async () => { if (!CAL) return; await applyParams(CAL.params, true); CAL = null; $("calOut").hidden = true; renderRaces(); toast("Nouveaux réglages appliqués à tous tes événements. Tu peux revenir en arrière dans Réglages > Valeurs d'origine."); };
$("calDrop").onclick = () => { CAL = null; $("calOut").hidden = true; };

/* ---------- Partage en lecture seule (GitHub Pages) ---------- */
const GH = { cfg: null, token: null, timer: 0, busy: false };
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const utf8 = (str) => new TextEncoder().encode(str);
async function ghLoad() {
  if (GH.cfg || !window.tempo) return GH.cfg;
  GH.cfg = (await storeOp("g", "readonly", (st) => st.get("config"))) || null;
  GH.token = await window.tempo.secretGet("github");
  return GH.cfg;
}
async function gh(method, path, body, accept) {
  const r = await fetch("https://api.github.com" + path, { method, headers: { Authorization: "Bearer " + GH.token, Accept: accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok && !(method === "GET" && r.status === 404)) { const err = new Error((j && j.message) || "HTTP " + r.status); err.status = r.status; throw err; }
  return r.ok ? j : null;
}
async function ghPut(path, u8, msg) {
  const { owner, repo, branch } = GH.cfg;
  const cur = await gh("GET", `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, null, "application/vnd.github.object");   // marche aussi au-delà de 1 Mo
  return gh("PUT", `/repos/${owner}/${repo}/contents/${path}`, { message: msg, content: b64(u8), branch, ...(cur && cur.sha ? { sha: cur.sha } : {}) });
}
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
const shareUrl = (id) => `https://${GH.cfg.owner.toLowerCase()}.github.io/${GH.cfg.repo}/?s=${id}`;
async function sharePayload() {
  const ev = clone(EV), trk = {};
  for (const F of ev.formats) { if (F.trackId && !trk[F.trackId]) { const t = await getTrack(F.trackId); if (t) trk[F.trackId] = packTrack(t).map((v, i) => (i % 3 === 2 ? Math.round(v) : +v.toFixed(5))); } }
  delete ev.archiveId; delete ev.share;
  return { v: 1, updated: Date.now(), name: (EV.name || "").trim(), ev, tracks: trk, params: TM.getParams() };
}
async function sharePush(quiet) {
  if (!EV.share || !EV.share.id || GH.busy) return;
  if (!(await ghLoad()) || !GH.token) { if (!quiet) toast("Configure d'abord l'espace de partage GitHub."); return; }
  GH.busy = true; $("shState").textContent = "Publication en cours…";
  try {
    // l'appli a évolué (assistant) : la page de consultation suit
    if (window.tempo.appSig) {
      const as = await window.tempo.appSig();
      if (GH.cfg.appSig !== as) {
        const files = await window.tempo.viewerFiles();
        for (const f of files) await ghPut(f.path, f.data, "Tempo : page de consultation mise à jour");
        GH.cfg.appSig = as; await storeOp("g", "readwrite", (st) => st.put(GH.cfg, "config"));
        EV.share.sig = "";
      }
    }
    const p = await sharePayload();
    const sig = hashStr(JSON.stringify([p.ev, p.params, Object.keys(p.tracks)]));
    if (quiet && sig === EV.share.sig && !EV.share.err) { GH.busy = false; renderShare(); return; }   // rien n'a changé depuis la dernière publication
    EV.share.sig = sig;
    await ghPut(`s/${EV.share.id}.json`, utf8(JSON.stringify(p)), `Tempo : ${p.name || "événement"} (${new Date().toLocaleString("fr-FR")})`);
    EV.share.last = p.updated; EV.share.err = "";
    if (!quiet) toast("Publié : la page de ton prestataire sera à jour d'ici 1 à 2 minutes.");
  } catch (e) { EV.share.err = e.message; if (!quiet) toast("Publication impossible : " + e.message); }
  GH.busy = false;
  await storeOp("w", "readwrite", (st) => st.put(clone(EV), "current"));
  if (EV.archiveId) archiveCurrent(false);
  renderShare();
}
function shareChanged() {
  if (VIEWER || !EV || !EV.share || !EV.share.id || EV.share.auto === false) return;
  clearTimeout(GH.timer); GH.timer = setTimeout(() => sharePush(true), 8000);
}
function renderShare() {
  if (!EV) return;
  const on = !!(EV.share && EV.share.id), cfg = GH.cfg;
  $("shCfgState").textContent = cfg && GH.token ? `(${cfg.owner}/${cfg.repo})` : "(à configurer)";
  $("shEvName").textContent = (EV.name || "").trim() || "Cet événement";
  $("shOff").hidden = on; $("shOn").hidden = !on;
  $("shStart").disabled = !(cfg && GH.token);
  if (on && cfg) {
    $("shLink").value = shareUrl(EV.share.id);
    $("shAuto").checked = EV.share.auto !== false;
    $("shState").textContent = EV.share.err ? "Dernière publication en échec : " + EV.share.err : EV.share.last ? "Dernière publication : " + fmtDT(EV.share.last) : "Pas encore publié.";
  }
  $("bShare").textContent = on ? "Partagé" : "Partager";
}
$("bShare").onclick = async () => {
  await ghLoad();
  $("shOwner").value = GH.cfg ? GH.cfg.owner : ""; $("shRepo").value = GH.cfg ? GH.cfg.repo : "tempo-partage"; $("shToken").value = "";
  $("shToken").placeholder = GH.token ? "jeton enregistré (laisser vide pour le garder)" : "github_pat_…";
  $("shCfgBox").open = !(GH.cfg && GH.token); $("shCfgMsg").hidden = true;
  renderShare(); $("shareDlg").hidden = false;
};
$("shClose").onclick = () => { $("shareDlg").hidden = true; };
$("shareDlg").addEventListener("click", (e) => { if (e.target === $("shareDlg")) $("shareDlg").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("shareDlg").hidden = true; });
function shMsg(t, err) { const m = $("shCfgMsg"); m.hidden = false; m.textContent = t; m.classList.toggle("err", !!err); }
$("shSetup").onclick = async () => {
  const owner = $("shOwner").value.trim(), repo = $("shRepo").value.trim(), tok = $("shToken").value.trim() || GH.token;
  if (!owner || !repo || !tok) { shMsg("Renseigne ton identifiant GitHub, le nom du dépôt et le jeton.", true); return; }
  GH.token = tok; GH.cfg = { owner, repo, branch: "main" };
  const b = $("shSetup"); b.disabled = true;
  try {
    shMsg("Connexion au dépôt…");
    const info = await gh("GET", `/repos/${owner}/${repo}`);
    if (!info) throw new Error(`le dépôt ${owner}/${repo} est introuvable. Crée-le d'abord sur github.com (public).`);
    if (info.private) throw new Error("le dépôt est privé : GitHub Pages gratuit demande un dépôt public.");
    GH.cfg.branch = info.default_branch || "main";
    await window.tempo.secretSet("github", tok);
    await storeOp("g", "readwrite", (st) => st.put(GH.cfg, "config"));
    shMsg("Envoi de la page de consultation…");
    const files = await window.tempo.viewerFiles();
    for (const f of files) await ghPut(f.path, f.data, "Tempo : page de consultation");
    if (window.tempo.appSig) { GH.cfg.appSig = await window.tempo.appSig(); await storeOp("g", "readwrite", (st) => st.put(GH.cfg, "config")); }
    await ghPut(".nojekyll", utf8(""), "Tempo : configuration");
    shMsg("Activation de GitHub Pages…");
    let pagesNote = "";
    try { await gh("POST", `/repos/${owner}/${repo}/pages`, { build_type: "legacy", source: { branch: GH.cfg.branch, path: "/" } }); }
    catch (e) {
      if (e.status !== 409) {
        const pg = await gh("GET", `/repos/${owner}/${repo}/pages`).catch(() => null);
        if (!pg) pagesNote = " Vérifie que GitHub Pages est activé sur le dépôt (Settings > Pages > Branch : " + GH.cfg.branch + " / (root) > Save).";
      }
    }
    shMsg(`Espace prêt : https://${owner.toLowerCase()}.github.io/${repo}/.` + pagesNote);
    $("shCfgBox").open = false; renderShare();
  } catch (e) { shMsg("Problème : " + e.message, true); }
  b.disabled = false;
};
$("shStart").onclick = async () => {
  const a = new Uint8Array(12); crypto.getRandomValues(a);
  EV.share = { id: [...a].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 18), auto: true, last: null };
  renderShare(); await sharePush(false);
};
$("shPush").onclick = () => sharePush(false);
$("shAuto").onchange = () => { EV.share.auto = $("shAuto").checked; saveWork(); };
$("shCopy").onclick = () => { navigator.clipboard.writeText($("shLink").value).then(() => toast("Lien copié.")); };
$("shOpen").onclick = () => window.tempo ? window.tempo.openExternal($("shLink").value) : window.open($("shLink").value);
$("shStop").onclick = async () => {
  const b = $("shStop");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Le lien ne marchera plus : confirmer"; b.classList.add("danger"); setTimeout(() => { delete b.dataset.armed; b.textContent = "Arrêter le partage"; b.classList.remove("danger"); }, 5000); return; }
  try {
    await ghLoad();
    const { owner, repo, branch } = GH.cfg, path = `s/${EV.share.id}.json`;
    const cur = await gh("GET", `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, null, "application/vnd.github.object");
    if (cur) await gh("DELETE", `/repos/${owner}/${repo}/contents/${path}`, { message: "Tempo : fin du partage", sha: cur.sha, branch });
    delete EV.share; saveWork(); renderShare(); toast("Partage arrêté : le lien ne fonctionne plus.");
  } catch (e) { toast("Impossible d'arrêter le partage : " + e.message); }
};

/* ---------- Visionneuse (lecture seule) ---------- */
const VW = { id: null, updated: 0 };
async function viewerLoad(first) {
  const r = await fetch(`s/${VW.id}.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status === 404 ? "Ce partage n'existe pas ou a été arrêté." : "Chargement impossible (" + r.status + ").");
  const p = await r.json();
  if (!first && p.updated <= VW.updated) return false;
  VW.updated = p.updated;
  TM.setParams(p.params || {});
  tracks.clear(); rawCache.clear();
  Object.entries(p.tracks || {}).forEach(([id, a]) => tracks.set(id, unpackTrack(a)));
  const cur = EV ? EV.cur : 0;
  EV = p.ev; EV.cur = Math.min(cur || 0, EV.formats.length - 1);
  $("roBadge").hidden = false; $("roBadge").textContent = "Lecture seule · mis à jour le " + fmtDT(p.updated);
  document.title = ((p.name || "Tempo Ultra") + " · temporisation");
  return true;
}

/* ---------- Assistant Claude : faire évoluer l'appli ---------- */
let AI_HIST = [];
async function renderAssist() {
  if (!window.tempo || !window.tempo.ai) return;
  const key = await window.tempo.secretGet("anthropic");
  $("aiKey").value = ""; $("aiKey").placeholder = key ? "clé enregistrée (laisser vide pour la garder)" : "sk-ant-…";
  $("aiKeyState").textContent = key ? "Clé enregistrée." : "Pas encore de clé.";
  $("aiModel").value = await window.tempo.ai.model();
  AI_HIST = (await window.tempo.ai.history()).filter((h) => h.kind === "assistant");
  const all = await window.tempo.ai.history();
  $("aiHist").innerHTML = all.length ? all.map((h) => `<li><b>${esc(h.instruction || "")}</b>${h.resume ? `<span>${esc(h.resume)}</span>` : ""}<span>${fmtDT(h.date)}${h.kind !== "assistant" ? " · sauvegarde" : ""}</span></li>`).join("")
    : `<li><span>Aucune évolution pour l'instant : l'appli est dans sa version d'origine.</span></li>`;
  $("aiUndo").disabled = !all.length;
}
function aiShow(txt, err) { const o = $("aiOut"); o.hidden = !txt; o.textContent = txt || ""; o.classList.toggle("err", !!err); }
if (window.tempo && window.tempo.ai) window.tempo.ai.onProgress((p) => {
  if (p.step) $("aiProg").dataset.step = p.step;
  $("aiProg").textContent = ($("aiProg").dataset.step || "") + (p.chars ? ` (${Math.round(p.chars / 1000)} k caractères écrits)` : "");
});
$("bAssist").onclick = async () => { if (VIEW === "assist") { showView("table"); return; } await renderAssist(); showView("assist"); };
$("aiSaveKey").onclick = async () => {
  const k = $("aiKey").value.trim();
  if (k) await window.tempo.secretSet("anthropic", k);
  await window.tempo.ai.model($("aiModel").value);
  await renderAssist(); toast("Connexion à Claude enregistrée.");
};
$("aiModel").onchange = () => window.tempo.ai.model($("aiModel").value);
$("aiSend").onclick = async () => {
  const instr = $("aiInstr").value.trim();
  if (!instr) { toast("Écris d'abord ta demande."); return; }
  if ($("aiKey").value.trim()) await window.tempo.secretSet("anthropic", $("aiKey").value.trim());
  const b = $("aiSend"); b.disabled = true; aiShow("");
  $("aiProg").dataset.step = "Envoi à Claude…"; $("aiProg").textContent = "Envoi à Claude…";
  try {
    await new Promise((r) => { saveWork(); setTimeout(r, 700); });   // on enregistre l'événement avant un éventuel rechargement
    const r = await window.tempo.ai.ask(instr, AI_HIST.slice(0, 6).reverse().map((h) => ({ instruction: h.instruction, resume: h.resume })));
    if (!r.ok) { aiShow(r.error, true); return; }
    if (r.applied) { aiShow(r.resume + "\n\nRechargement de l'appli…"); $("aiProg").textContent = ""; return; }
    aiShow(r.resume);
  } catch (e) { aiShow("Erreur : " + e.message, true); }
  finally { b.disabled = false; if (!$("aiOut").textContent.includes("Rechargement")) $("aiProg").textContent = ""; }
};
$("aiUndo").onclick = async () => { const r = await window.tempo.ai.undo(); if (!r.ok) toast(r.error); };
$("aiReset").onclick = async () => {
  const b = $("aiReset");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Confirmer le retour à l'origine"; b.classList.add("danger"); setTimeout(() => { delete b.dataset.armed; b.textContent = "Revenir à la version d'origine"; b.classList.remove("danger"); }, 5000); return; }
  await window.tempo.ai.reset();
};
// au démarrage : l'appli signale qu'elle fonctionne, et affiche le résultat d'une évolution qui vient d'être appliquée
async function aiAfterBoot() {
  if (!window.tempo || !window.tempo.ready) return;
  const r = await window.tempo.ready();
  if (!r) return;
  await renderAssist(); showView("assist");
  if (r.instruction) $("aiInstr").value = r.ok ? "" : r.instruction;
  aiShow(r.ok ? (r.applied ? "C'est fait. " : "") + (r.resume || "") : r.error, !r.ok);
}

/* ---------- Démarrage ---------- */
(async () => {
  if (VIEWER) {
    VW.id = new URLSearchParams(location.search).get("s");
    try {
      if (!VW.id) throw new Error("Lien incomplet : il manque l'identifiant du partage.");
      await viewerLoad(true);
    } catch (e) { $("title").textContent = e.message; $("tabs").hidden = true; $("fmtView").hidden = true; return; }
    await showEvent();
    setInterval(async () => {
      try { if (await viewerLoad(false)) { await showEvent(); if (FX.on) openFlux(true); toast("Mise à jour reçue de l'organisation."); } } catch (e) {}
    }, 60000);
    return;
  }
  const sp = await storeOp("s", "readonly", (st) => st.get("model"));
  if (sp) TM.setParams(sp);
  if (window.tempo) $("dataDirTxt").textContent = "Tes événements, archives, traces et réglages sont rangés dans : " + (await window.tempo.dataDir());
  EV = await loadWork();
  EV.cur = Math.min(Math.max(0, EV.cur || 0), EV.formats.length - 1);
  await showEvent();
  ghLoad().then(renderShare);
  aiAfterBoot();
})();
