"use strict";
const $ = (id) => document.getElementById(id);
const state = { text: "", level: "", mode: "grammar", edits: [], photo: null, fromPhoto: false, origin: "write" };
const MEMORY_KEY = "vogi.mistakes.v1";
const TRY_KEY = "vogi.tryfirst";
const LEVEL_KEY = "vogi.level";
const EST_KEY = "vogi.level.estimates";
const DISMISS_KEY = "vogi.level.dismissed";
const LESSONS_KEY = "vogi.lessons.v1";
const LESSON_KEEP = 10; // the newest lesson plans kept in this browser
// The learner picks one of four plain answers (A1 to B2). Vogi moves the level from their texts,
// up to C2.
const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const LEVEL_WORDS = { A1: "Just starting", A2: "Simple things", B1: "Everyday things", B2: "Quite good", C1: "Fluent", C2: "Near native" };
const main = (lv) => (lv === "A0" ? "A1" : String(lv).slice(0, 2)); // also maps steps saved before 02.11, like A2.1
const MODE_WORDS = { grammar: "Grammar only", words: "Better words", natural: "Sound natural" };

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else n.setAttribute(k, v);
  }
  for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}

function status(msg) { $("status").textContent = msg || ""; }
function store(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } }
function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }

// Access code (only on a hosted copy): asked once, kept in this browser, sent with every call.
const CODE_KEY = "vogi.code";
const codeHeader = () => ({ "X-Vogi-Code": stored(CODE_KEY) || "" });
async function getJSON(path) {
  const res = await fetch(path, { headers: codeHeader() });
  if (res.status === 401) { askCode(); throw new Error("access code needed"); }
  return res.json();
}
function askCode(msg = "") {
  $("code-msg").textContent = msg;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.id !== "v-code"));
  $("code-in").focus();
}

async function api(path, body, isForm = false) {
  const res = await fetch(path, isForm
    ? { method: "POST", headers: codeHeader(), body }
    : { method: "POST", headers: { "Content-Type": "application/json", ...codeHeader() }, body: JSON.stringify(body) });
  if (res.status === 401) { askCode(); throw new Error("access code needed"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Error ${res.status}`);
  return data;
}

function picked(name) { return document.querySelector(`input[name=${name}]:checked`).value; }
function provider() { return $("provider").value || null; }

// Screens: one visible at a time. A stack so "Back" returns where the learner came from.
const nav = [];
let view = "home";
function show(name, push = true) {
  if (push && name !== view) nav.push(view);
  view = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.id !== "v-" + name));
  window.scrollTo({ top: 0 });
  if (name === "home") { nav.length = 0; renderProgressLine(); }
  if (name === "lesson-pick") $("chip-mistakes").classList.toggle("hidden", !loadMemory().length);
  if (name === "talk" && (talk.ended || !talk.scene)) { $("talk").classList.add("hidden"); $("own").classList.add("hidden"); $("scene-pick").classList.remove("hidden"); }
  if (name !== "talk" && typeof rec !== "undefined" && rec && talk.scene) { talk.handsFree = false; stopListening(); }
}
function back() { show(nav.pop() || "home", false); }

// Level: asked once in plain words, kept in this browser, shown as a chip.
function setLevel(lv) {
  lv = main(lv || "");
  if (!LEVELS.includes(lv)) return;
  state.level = lv; store(LEVEL_KEY, lv);
  $("level-chip").replaceChildren(el("span", { class: "lvw" }, "Level: "), el("b", {}, el("span", { class: "lvw" }, `${LEVEL_WORDS[lv]} `), `(${lv})`), " ", el("u", {}, "change"));
  $("level-chip").classList.remove("hidden");
}
function askLevel() {
  const now = ["C1", "C2"].includes(state.level) ? "B2" : state.level;
  document.querySelectorAll("[data-level]").forEach((b) => b.classList.toggle("picked", b.dataset.level === now));
  show("level");
}
function estimates() { try { return JSON.parse(stored(EST_KEY) || "[]").filter((x) => LEVELS.includes(main(x))); } catch { return []; } }
// Three texts in a row above (or below) the level: Vogi switches by itself and says so, with an undo.
function noteEstimate(lv) {
  $("suggest").classList.add("hidden");
  if (!LEVELS.includes(main(lv || ""))) return;
  const list = estimates().concat(lv).slice(-5);
  store(EST_KEY, JSON.stringify(list));
  const last = list.slice(-3);
  if (last.length < 3) return;
  const me = LEVELS.indexOf(state.level), idx = last.map((x) => LEVELS.indexOf(main(x)));
  const above = idx.every((i) => i > me), below = idx.every((i) => i < me);
  if (!above && !below) return;
  // The gentlest step: the estimate nearest to the learner's level.
  const target = last.map(main).sort((a, b) => Math.abs(LEVELS.indexOf(a) - me) - Math.abs(LEVELS.indexOf(b) - me))[0];
  if (stored(DISMISS_KEY) === target) return;
  const before = state.level;
  setLevel(target); store(EST_KEY, "[]");
  $("suggest-text").textContent = `Your last texts look like ${target}, so Vogi now uses ${target}.`;
  $("suggest-no").textContent = `Keep ${before}`;
  $("suggest").classList.remove("hidden");
  $("suggest-yes").onclick = () => $("suggest").classList.add("hidden");
  $("suggest-no").onclick = () => { setLevel(before); store(DISMISS_KEY, target); $("suggest").classList.add("hidden"); };
}

// Word-level diff: longest common subsequence over words. Runs of the same kind are grouped.
function diff(a, b) {
  const A = a.split(/\s+/).filter(Boolean), B = b.split(/\s+/).filter(Boolean);
  if (A.length * B.length > 250000) return [["ins", B]];
  const L = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  const push = (t, w) => { const last = out[out.length - 1]; if (last && last[0] === t) last[1].push(w); else out.push([t, [w]]); };
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { push("eq", A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { push("del", A[i]); i++; }
    else { push("ins", B[j]); j++; }
  }
  while (i < A.length) push("del", A[i++]);
  while (j < B.length) push("ins", B[j++]);
  return out;
}

function renderDiff(a, b) {
  const box = $("diff"); box.replaceChildren();
  // Keep one line per line (a spoken turn in Talk) when both texts have the same number of lines.
  const la = a.split("\n"), lb = b.split("\n");
  const pairs = la.length === lb.length ? la.map((x, i) => [x, lb[i]]) : [[a, b]];
  pairs.forEach(([x, y], line) => {
    if (line) box.append(el("br"));
    diff(x, y).forEach(([t, words], k) => {
      if (k) box.append(" ");
      box.append(t === "eq" ? words.join(" ") : el(t, {}, words.join(" ")));
    });
  });
}

const CAT = {
  verb_position: "verb position", verb_form: "verb form", auxiliary: "haben / sein", case: "case",
  gender: "der / die / das", adjective_ending: "adjective ending", preposition: "preposition",
  plural: "plural", spelling: "spelling", capitalisation: "capital letter", punctuation: "punctuation",
  word_choice: "better word", register: "register", idiom: "idiom", style: "style", other: "other",
};

function renderResult(data) {
  const r = data.result, c = data.checks;
  state.edits = r.edits;
  renderDiff(state.text, r.corrected_text);
  $("summary").textContent = r.summary;
  const list = $("edits"); list.replaceChildren();
  r.edits.forEach((e, k) => {
    const chips = [el("span", { class: "chip" + (e.severity === "style" ? " style" : "") }, CAT[e.category] || e.category)];
    if (c.edits[k] && !c.edits[k].grounded) chips.push(el("span", { class: "chip bad" }, "not found in your text"));
    list.append(el("li", {},
      el("span", { class: "from" }, e.original || "(nothing)"), " → ",
      el("span", { class: "to" }, e.replacement || "(remove)"), ...chips,
      el("span", { class: "rule" }, e.rule)));
  });
  if (!r.edits.length) list.append(el("li", {}, "No changes. Well done!"));
  const box = $("checks"); box.replaceChildren();
  box.className = "checks" + (c.warnings.length ? " warn" : "");
  box.append(el("strong", {}, "Vogi checked its own answer: "),
    c.total ? `${c.grounded} of ${c.total} changes point at words that are really in your text.` : "Nothing to change.");
  for (const w of c.warnings) box.append(el("br"), "⚠ " + w);
  const m = data.meta;
  $("meta").textContent = `${m.model}${m.open_weight ? " (open weights)" : ""} · ${(m.ms / 1000).toFixed(1)} s · ` +
    `${m.tokens_in + m.tokens_out} tokens` + (m.usd_estimate != null ? ` · about $${m.usd_estimate.toFixed(4)}` : "") +
    ` · format: ${m.format}` + (r.level_estimate ? ` · text looks like ${r.level_estimate}` : "");
  $("practise").classList.toggle("hidden", !r.edits.some((e) => e.severity === "error"));
  const more = $("more-line");
  more.classList.toggle("hidden", state.mode !== "grammar" || state.origin === "talk");
  const tryable = r.edits.map((e, k) => ({ e, n: k + 1 })).filter(({ e }, i) => e.severity === "error" && c.edits[i].grounded);
  const trying = $("tryfirst").checked && tryable.length > 0;
  $("try").classList.toggle("hidden", !trying);
  $("full").classList.toggle("hidden", trying);
  $("show-full").classList.remove("hidden");
  $("result-title").textContent = trying ? "Fix your mistakes" : "Your text, corrected";
  if (trying) renderTry(tryable);
  noteEstimate(r.level_estimate);
}

// Try first: Vogi marks where each mistake is and gives a hint. The learner fixes one at a time.
function renderTry(items) {
  const text = state.text, marked = $("marked"); marked.replaceChildren();
  let cursor = 0;
  const markEl = {};
  for (const { e, n } of items) {
    const i = text.indexOf(e.original, cursor);
    if (i < 0) continue;
    marked.append(text.slice(cursor, i));
    markEl[n] = el("mark", { class: "miss" }, el("sup", {}, n), e.original);
    marked.append(markEl[n]);
    cursor = i + e.original.length;
  }
  marked.append(text.slice(cursor));
  let done = 0, self = 0;
  const rows = [];
  const progress = () => {
    $("try-progress").textContent = done < items.length
      ? `${items.length} mistake${items.length > 1 ? "s" : ""}. Fix them one by one. Fixed by you: ${self} of ${items.length}.`
      : `You fixed ${self} of ${items.length} mistake${items.length > 1 ? "s" : ""} yourself.`;
    if (done === items.length) { $("full").classList.remove("hidden"); $("show-full").classList.add("hidden"); }
  };
  const open = (k) => {
    rows.forEach((row, i) => row.li.classList.toggle("hidden", i > k));
    Object.values(markEl).forEach((m) => m.classList.remove("now"));
    if (!rows[k]) return;
    if (markEl[rows[k].n]) markEl[rows[k].n].classList.add("now");
    rows[k].inp.focus({ preventScroll: true });
  };
  const list = $("try-list"); list.replaceChildren();
  items.forEach(({ e, n }, k) => {
    const spoils = e.replacement && e.hint.toLowerCase().includes(e.replacement.toLowerCase()) && !e.original.toLowerCase().includes(e.replacement.toLowerCase());
    const hint = spoils ? `Look at the ${CAT[e.category] || e.category}.` : e.hint;
    const inp = el("input", { type: "text", value: e.original, autocomplete: "off", spellcheck: "false", "aria-label": `Your fix for mistake ${n}` });
    const check = el("button", { class: "btn primary" }, "Check"), show = el("button", { class: "link" }, "Show answer");
    const fb = el("div", { class: "fb" });
    const li = el("li", { value: n },
      el("span", { class: "chip" }, CAT[e.category] || e.category),
      el("span", { class: "hint" }, hint),
      inp, el("div", { class: "acts" }, check, show), fb);
    let tries = 0, closed = false;
    const close = (byLearner, msg) => {
      closed = true; done++; if (byLearner) self++;
      inp.disabled = true; check.disabled = true; show.disabled = true;
      fb.className = "fb " + (byLearner ? "ok" : "no");
      fb.replaceChildren((byLearner ? "✓ " : "") + msg, el("span", { class: "rule" }, e.rule));
      li.classList.add("closed");
      if (markEl[n]) markEl[n].classList.add(byLearner ? "done" : "shown"); // fixed: green, shown: amber
      progress(); open(k + 1);
    };
    check.onclick = async () => {
      const answer = inp.value.trim();
      if (closed || !answer || answer === e.original) return;
      if (_norm(answer) === _norm(e.replacement)) return close(true, "Right!");
      check.disabled = true; fb.className = "fb"; fb.textContent = "…";
      try {
        const v = await api("/api/check", { provider: provider(), answer, exercise: {
          type: "fix_sentence", instruction: `Fix the words '${e.original}' in this text.`, prompt: state.text,
          options: [], answer: e.replacement, category: e.category, hint: e.hint } });
        if (v.correct) return close(true, "Right! " + v.feedback);
        tries++;
        if (tries >= 2) return close(false, `The answer: ${e.original} → ${e.replacement}`);
        fb.className = "fb no"; fb.textContent = "Not yet. " + v.feedback;
      } catch (err) { fb.textContent = err.message; }
      if (!closed) check.disabled = false;
    };
    inp.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); check.click(); } };
    show.onclick = () => { if (!closed) close(false, `The answer: ${e.original} → ${e.replacement}`); };
    rows.push({ li, inp, n });
    list.append(li);
  });
  progress(); open(0);
}

function _norm(s) { return s.replace(/[\s.!?,;:]+/g, " ").trim(); }

async function runCorrect(text, fromPhoto = false, spoken = false) {
  if (state.checking) return; // one check at a time: a double click must not send twice
  state.checking = true;
  try { await doCorrect(text, fromPhoto, spoken); } finally { state.checking = false; }
}

async function doCorrect(text, fromPhoto, spoken) {
  state.text = text.trim(); state.fromPhoto = fromPhoto && !!state.photo;
  state.mode = spoken ? "grammar" : picked("mode");
  state.origin = spoken ? "talk" : "write";
  if (!state.text) { status("Write a sentence first."); return; }
  $("go").disabled = true; status("Vogi is reading your text …");
  try {
    const data = await api("/api/correct", { text: state.text, level: state.level, mode: state.mode, spoken, provider: provider() });
    renderResult(data);
    remember(data.result.edits.filter((e, k) => e.severity === "error" && data.checks.edits[k].grounded));
    status("");
    $("redpen").classList.add("hidden");
    $("talk-note").classList.toggle("hidden", !spoken);
    $("again").textContent = spoken ? "Talk again" : "Check another text";
    $("other-scene").classList.toggle("hidden", !spoken);
    show("result");
    if (state.fromPhoto) redPen(data.result.edits);
  } catch (e) { status(e.message); } finally { $("go").disabled = false; }
}

async function runPractice(errs = state.edits.filter((e) => e.severity === "error")) {
  if (!errs.length) return;
  $("practise").disabled = true; $("practise-top").disabled = true; status("Vogi is writing exercises from your mistakes …");
  try {
    const data = await api("/api/exercises", { level: state.level, edits: errs, provider: provider() });
    const list = $("ex"); list.replaceChildren();
    for (const ex of data.result.exercises) list.append(exerciseItem(ex));
    status(""); show("practice");
  } catch (e) { status(e.message); } finally { $("practise").disabled = false; $("practise-top").disabled = false; }
}

function exerciseItem(ex) {
  const li = el("li", {}, el("div", { class: "note" }, ex.instruction), el("div", { class: "task" }, ex.prompt));
  let get;
  if (ex.type === "choose" && ex.options.length) {
    const name = "o" + Math.random().toString(36).slice(2);
    const opts = el("div", { class: "opts" });
    for (const o of ex.options) opts.append(el("label", {}, el("input", { type: "radio", name, value: o }), " " + o));
    li.append(opts);
    get = () => (li.querySelector(`input[name=${name}]:checked`) || {}).value || "";
  } else {
    const inp = el("input", { type: "text", autocomplete: "off", spellcheck: "false",
      placeholder: ex.type === "fix_sentence" ? "Write the correct sentence" : "Missing word(s)" });
    li.append(inp); get = () => inp.value;
    inp.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); btn.click(); } };
  }
  const fb = el("div", { class: "fb" });
  const btn = el("button", { class: "btn primary" }, "Check");
  const hint = el("button", { class: "link" }, "Hint");
  btn.onclick = async () => {
    const answer = get().trim(); if (!answer) return;
    btn.disabled = true; fb.textContent = "…";
    try {
      const v = await api("/api/check", { exercise: ex, answer, provider: provider() });
      fb.className = "fb " + (v.correct ? "ok" : "no"); fb.textContent = (v.correct ? "✓ " : "✗ ") + v.feedback;
    } catch (e) { fb.textContent = e.message; } finally { btn.disabled = false; }
  };
  hint.onclick = () => { fb.className = "fb"; fb.textContent = "Hint: " + ex.hint; };
  li.append(el("div", { class: "acts" }, btn, hint), fb);
  return li;
}

// Red pen: Muse Spark finds each wrong word on the photo, Vogi draws the marks.
async function redPen(edits) {
  $("redpen").classList.add("hidden");
  if (!edits.length) return;
  $("redpen-img").src = URL.createObjectURL(state.photo);
  $("redpen-note").textContent = "Vogi is marking your page …";
  const form = new FormData();
  form.append("image", state.photo);
  form.append("originals", JSON.stringify(edits.map((e) => e.original)));
  form.append("text", state.text);
  if (provider()) form.append("provider", provider());
  try {
    const data = await api("/api/locate", form, true);
    const found = drawMarks($("redpen-marks"), data.result.marks);
    savePage(edits, data.result.marks);
    $("redpen-note").textContent = `${found} of ${edits.length} mistakes marked on your page. The numbers match the list below.`;
    $("redpen").classList.remove("hidden");
  } catch (e) { $("redpen-note").textContent = "Red pen failed: " + e.message; $("redpen").classList.remove("hidden"); }
}

// Boxes come on a 0-1000 grid and can be a little off, so each mark is a padded highlighter band, not a box.
function drawMarks(layer, marks) {
  layer.replaceChildren();
  let found = 0;
  const PX = 10, PY = 4; // padding on the 0-1000 grid; small in height so a band stays on its line
  for (const m of marks) {
    if (!m.found) continue;
    found++;
    const [x0, y0, x1, y1] = m.box;
    const l = Math.max(0, x0 - PX), t = Math.max(0, y0 - PY), r = Math.min(1000, x1 + PX), b = Math.min(1000, y1 + PY);
    const band = el("div", { class: "mark" }), badge = el("span", { class: "badge" }, m.edit);
    Object.assign(band.style, { left: l / 10 + "%", top: t / 10 + "%", width: (r - l) / 10 + "%", height: (b - t) / 10 + "%" });
    Object.assign(badge.style, { left: l / 10 + "%", top: (t + b) / 20 + "%" });
    layer.append(band, badge);
  }
  return found;
}

// My pages: checked photos with their marks, in this browser's IndexedDB.
function pagesDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("vogi", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("pages", { keyPath: "id" });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function pagesTx(mode, fn) {
  const d = await pagesDb();
  return new Promise((res, rej) => {
    const tx = d.transaction("pages", mode);
    const req = fn(tx.objectStore("pages"));
    tx.oncomplete = () => { d.close(); res(req && req.result); };
    tx.onerror = () => { d.close(); rej(tx.error); };
  });
}
async function savePage(edits, marks) {
  try {
    const page = {
      id: Date.now().toString(36), t: new Date().toISOString(), level: state.level, photo: state.photo,
      text: state.text, marks, edits: edits.map((e) => ({ original: e.original, replacement: e.replacement, category: e.category, rule: e.rule })),
    };
    await pagesTx("readwrite", (st) => st.put(page));
    renderPages();
  } catch { /* private window or storage blocked: the page still works */ }
}
let pageUrls = [], openPage = null, pageCount = 0;
async function renderPages() {
  let pages = [];
  try { pages = (await pagesTx("readonly", (st) => st.getAll())) || []; } catch { /* no IndexedDB */ }
  pageCount = pages.length;
  $("pages-note").classList.toggle("hidden", pages.length > 0);
  pageUrls.forEach((u) => URL.revokeObjectURL(u)); pageUrls = [];
  pages.sort((a, b) => b.t.localeCompare(a.t));
  $("thumbs").replaceChildren(...pages.map((pg) => {
    const url = URL.createObjectURL(pg.photo); pageUrls.push(url);
    const n = pg.edits.length;
    const b = el("button", { class: "thumb" + (openPage === pg.id ? " on" : "") }, el("img", { src: url, alt: "" }),
      el("span", {}, `${new Date(pg.t).toLocaleDateString()} · ${pg.level} · ${n} mistake${n === 1 ? "" : "s"}`));
    b.onclick = () => showPage(pg, url);
    return b;
  }));
  if (openPage && !pages.some((p) => p.id === openPage)) closePage();
  renderProgressLine();
}
function showPage(pg, url) {
  openPage = pg.id;
  $("pv-img").src = url;
  $("pv-meta").textContent = `Checked ${new Date(pg.t).toLocaleString()} at level ${pg.level}.`;
  drawMarks($("pv-marks"), pg.marks);
  $("pv-edits").replaceChildren(...pg.edits.map((e) => el("li", {},
    el("span", { class: "from" }, e.original), " → ", el("span", { class: "to" }, e.replacement),
    el("span", { class: "chip" }, CAT[e.category] || e.category), el("span", { class: "rule" }, e.rule))));
  $("page-view").classList.remove("hidden");
  document.querySelectorAll(".thumb").forEach((t) => t.classList.toggle("on", t.querySelector("img").src === url));
  $("page-view").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function closePage() { openPage = null; $("page-view").classList.add("hidden"); document.querySelectorAll(".thumb").forEach((t) => t.classList.remove("on")); }

// My mistakes: kept in this browser only.
function loadMemory() {
  try { return JSON.parse(localStorage.getItem(MEMORY_KEY) || "[]"); } catch { return []; }
}
function saveMemory(list) {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(list.slice(-300))); } catch { /* private window */ }
}
function remember(errs) {
  if (!errs.length) return;
  const t = new Date().toISOString();
  saveMemory(loadMemory().concat(errs.map((e) => ({ t, level: state.level, category: e.category, original: e.original, replacement: e.replacement, hint: e.hint, rule: e.rule }))));
  renderMemory();
}
function topCategories(list) {
  const by = new Map();
  for (const m of list) { if (!by.has(m.category)) by.set(m.category, []); by.get(m.category).push(m); }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
}
function renderMemory() {
  const list = loadMemory(), body = $("memory-body");
  $("practise-top").classList.toggle("hidden", !list.length);
  $("forget").classList.toggle("hidden", !list.length);
  renderProgressLine();
  if (!list.length) { body.replaceChildren(el("p", { class: "note" }, "No mistakes saved yet. Check a text first.")); return; }
  const cats = topCategories(list), max = cats[0][1].length;
  const ul = el("ul", { class: "bars" });
  for (const [cat, items] of cats.slice(0, 6)) {
    const last = items[items.length - 1];
    const bar = el("div", { class: "bar" }); bar.style.width = Math.max(6, (100 * items.length) / max) + "%";
    ul.append(el("li", {}, el("span", {}, CAT[cat] || cat), el("div", {}, bar), el("span", {}, "× " + items.length),
      el("span", { class: "ex1" }, `Last: ${last.original} → ${last.replacement}`)));
  }
  const days = new Set(list.map((m) => m.t.slice(0, 10))).size;
  body.replaceChildren(el("p", { class: "note" }, `${list.length} mistakes from ${days} day${days > 1 ? "s" : ""}. Your most frequent:`), ul);
}
function renderProgressLine() {
  const n = loadMemory().length;
  const parts = [];
  if (n) parts.push(`${n} mistake${n === 1 ? "" : "s"} saved`);
  if (pageCount) parts.push(`${pageCount} page${pageCount === 1 ? "" : "s"}`);
  $("progress-line").textContent = parts.length ? parts.join(" · ") : "Your mistakes and your pages";
}
function practiseTop() {
  const cats = topCategories(loadMemory()).slice(0, 3);
  runPractice(cats.flatMap(([, items]) => items.slice(-2))
    .map(({ t, level, ...m }) => ({ ...m, severity: "error", hint: m.hint || `Look at the ${CAT[m.category] || m.category}.` })));
}

// Talk: a role-play with a mission. The partner never corrects; the feedback comes after.
const talk = { scene: null, history: [], busy: false };
const MAX_TURNS = 8;
const OWN_KEY = "vogi.scenes.v1";
const WAIT_KEY = "vogi.wait";
let serverScenes = [];

async function loadScenes() {
  try { serverScenes = await getJSON("/api/scenes"); } catch { /* the server is down: loadProviders says so */ }
  renderScenes();
}

// The learner's own scenes live in this browser, newest first, with their picture.
function ownScenes() { try { return JSON.parse(stored(OWN_KEY) || "[]"); } catch { return []; } }
function saveOwn(sc) {
  let list = [sc].concat(ownScenes().filter((x) => x.id !== sc.id)).slice(0, 6);
  try { localStorage.setItem(OWN_KEY, JSON.stringify(list)); }
  catch { list = list.map(({ picture, ...x }) => x); store(OWN_KEY, JSON.stringify(list)); } // storage full: keep the text
  renderScenes();
}
function renderScenes() {
  const card = (sc) => {
    const pic = el("img", { class: "scene-pic", alt: "" });
    const b = el("button", { class: "scene" }, pic, el("strong", {}, sc.title),
      sc.own ? el("span", { class: "own-tag" }, "My scene") : "", el("small", {}, sc.goals.join(" · ")));
    b.onclick = () => startScene(sc);
    pictureFor(sc).then((url) => { if (url) pic.src = url; else pic.remove(); });
    return b;
  };
  const add = el("button", { class: "scene add" }, el("strong", {}, "+"), el("small", {}, "Make your own scene"));
  add.onclick = openOwn;
  $("scenes").replaceChildren(add, ...ownScenes().map(card), ...serverScenes.map(card));
}
function pictureFor(sc) { return sc.own ? Promise.resolve(sc.picture || null) : scenePicture(sc.id); }
const sceneBody = ({ title, partner, setting, words, goals }) => ({ title, partner, setting, words, goals });

// Make your own scene: the learner describes a situation, Muse Spark writes the scene, Muse Image draws it.
let draft = null;
function openOwn() {
  draft = null;
  $("own-preview").classList.add("hidden");
  $("scene-pick").classList.add("hidden"); $("own").classList.remove("hidden");
  $("own-text").focus();
}
// The learner can also tell the situation, in any language: the recogniser detects it.
const ownMic = () => dictate($("own-mic"), $("own-text"), ownMic, "Fix any word if needed, then press Make the scene.", "any");
// Dictation into a text box: the words appear while the learner speaks, Stop keeps them in the box.
// The own scene, the lesson topic and a spoken lesson answer all use it.
async function dictate(b, box, again, done, lang) {
  const idle = b.dataset.idle || (b.dataset.idle = b.textContent);
  if (!rec) {
    try { startLive({ box, lang, keywords: [] }); await startRec(again); }
    catch { finishLive(); status("Vogi cannot use the microphone. Type it instead."); return; }
    b.classList.add("on"); b.textContent = "■ Stop"; status("Listening … say it, then press Stop.");
    return;
  }
  b.classList.remove("on"); b.textContent = idle;
  await stopRec();
  const heard = await finishLive();
  if (heard) { box.value = heard; status(done); }
  else status("Vogi did not hear anything. Try again, or type it.");
}
async function makeOwn() {
  if (rec) await ownMic();
  const text = $("own-text").value.trim();
  if (text.length < 3 || $("own-go").disabled) return;
  $("own-go").disabled = $("own-again").disabled = true;
  status("Vogi is writing your scene …");
  try {
    const data = await api("/api/scene", { description: text, level: state.level, provider: provider() });
    const sc = { ...data.result, id: "own-" + Date.now().toString(36), own: true };
    draft = sc;
    // Muse Image starts drawing while the learner reads the mission, so the picture is there before the talk.
    $("own-pic").classList.add("hidden");
    sc.drawing = api("/api/scene-picture", { scene: sceneBody(sc) }).then((d) => d.image).catch(() => null);
    sc.drawing.then((img) => { if (img && draft === sc) { $("own-pic").src = img; $("own-pic").classList.remove("hidden"); } });
    $("own-title").textContent = draft.title;
    $("own-partner").textContent = `${draft.partner} ${draft.setting}`;
    $("own-goals").replaceChildren(...draft.goals.map((g) => el("li", {}, g)));
    $("own-preview").classList.remove("hidden");
    status("");
  } catch (e) { status(e.message); }
  $("own-go").disabled = $("own-again").disabled = false;
}
async function startOwn() {
  if (!draft || $("own-start").disabled) return;
  const sc = draft;
  $("own-start").disabled = true;
  status("Vogi is drawing your scene …");
  // Wait a few seconds for the picture, never long. A picture that comes later is kept for next
  // time and does not pop up during the talk.
  const drawing = sc.drawing; delete sc.drawing;
  const late = (img) => { if (img) { sc.picture = img; saveOwn(sc); } };
  const img = await Promise.race([drawing, new Promise((r) => setTimeout(() => r(undefined), 8000))]);
  if (img === undefined) drawing.then(late); else late(img);
  saveOwn(sc);
  status(""); $("own-start").disabled = false;
  $("own").classList.add("hidden");
  startScene(sc);
}

// Scene pictures come from Muse Image. The server makes each one once; the page keeps the URL.
const pictures = {};
function scenePicture(id) {
  if (!pictures[id]) {
    pictures[id] = fetch(`/api/scene-image/${id}`, { headers: codeHeader() })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .catch(() => null);
  }
  return pictures[id];
}

function bubble(role, text, turn = null) {
  const txt = el("span", { class: "txt" }, text);
  const b = el("div", { class: "bubble " + role }, el("span", { class: "who" }, role === "partner" ? talk.scene.title : "You"), txt);
  if (role === "partner") {
    const again = el("button", { class: "again", title: "Say it again", "aria-label": "Say it again" }, "🔊");
    again.onclick = () => speak(text, true);
    b.append(again);
  } else if (turn) {
    // A misheard word is not the learner's mistake: they fix it right on their line, or remove a line that was noise.
    const fix = el("button", { class: "again", title: "Fix what Vogi heard", "aria-label": "Fix what Vogi heard" }, "✎");
    const drop = el("button", { class: "again", title: "Remove this line", "aria-label": "Remove this line" }, "✕");
    fix.onclick = () => {
      const inp = el("input", { type: "text", value: turn.text, maxlength: "300", "aria-label": "What you said" });
      const save = () => { turn.text = inp.value.trim() || turn.text; txt.textContent = turn.text; inp.replaceWith(txt); };
      inp.onkeydown = (e) => { if (e.key === "Enter") save(); };
      inp.onblur = save;
      txt.replaceWith(inp); inp.focus();
    };
    drop.onclick = () => { turn.removed = true; b.remove(); };
    b.append(fix, drop);
    $("talk-hint").classList.remove("hidden");
  }
  $("chat").append(b); $("chat").scrollTop = $("chat").scrollHeight;
}

// Words you can use: building blocks for the next line. Open by default at A1 and A2.
function helpWords(words) {
  document.querySelectorAll(".helpwords").forEach((n) => n.remove());
  if (!words.length) return;
  const box = el("div", { class: "helpwords" });
  const chips = () => box.replaceChildren("Words you can use:", ...words.map((w) => {
    const b = el("button", { class: "word", type: "button" }, w);
    b.onclick = () => {
      const piece = w.replace(/\s*(…|\.\.\.)\s*$/, "").trim();
      $("say").value = ($("say").value.trim() + " " + piece).trim() + " ";
      $("say").focus();
    };
    return b;
  }));
  if (["A1", "A2"].includes(main(state.level))) chips();
  else { const need = el("button", { class: "need", type: "button" }, "Need words?"); need.onclick = chips; box.append(need); }
  $("chat").append(box); $("chat").scrollTop = $("chat").scrollHeight;
}

// The partner's voice is the browser's own speech synthesis: the Model API has no text-to-speech.
function speak(text, force = false, done = null) {
  if (!("speechSynthesis" in window) || (!force && !$("voice").checked)) { if (done) done(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "de-DE";
  const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.toLowerCase().startsWith("de"));
  if (v) u.voice = v;
  u.rate = ["A1", "A2"].includes(main(state.level)) ? 0.85 : 1;
  if (done) {
    let called = false;
    const once = () => { if (!called) { called = true; done(); } };
    u.onend = once; u.onerror = once;
    setTimeout(once, 1500 + text.length * 110); // some browsers never fire onend
  }
  speechSynthesis.speak(u);
}

function startScene(sc) {
  if (Date.now() - (talk.startedAt || 0) < 1500) return; // a double click starts one scene, not two
  talk.startedAt = Date.now();
  stopListening();
  Object.assign(talk, { scene: sc, history: [], busy: false, goalsDone: 0, handsFree: true, ended: false });
  $("talk-hint").classList.add("hidden"); $("end-talk").disabled = false;
  $("talk-done").classList.add("hidden"); $("talk").classList.remove("over"); $("own").classList.add("hidden");
  $("scene-title").textContent = sc.title;
  $("talk-pic").classList.add("hidden");
  pictureFor(sc).then((url) => { if (url && talk.scene === sc) { $("talk-pic").src = url; $("talk-pic").classList.remove("hidden"); } });
  $("goals").replaceChildren(...sc.goals.map((g) => el("li", {}, g)));
  $("chat").replaceChildren();
  $("scene-pick").classList.add("hidden"); $("talk").classList.remove("hidden");
  partnerTurn();
}

function setBusy(b) { talk.busy = b; ["mic", "send", "say"].forEach((id) => ($(id).disabled = b)); }

async function partnerTurn() {
  setBusy(true); status(talk.history.length ? "The partner is answering …" : "The partner is starting …");
  try {
    const history = talk.history.filter((t) => !t.removed).map(({ role, text }) => ({ role, text }));
    const where = talk.scene.own ? { custom: sceneBody(talk.scene) } : { scene: talk.scene.id };
    const data = await api("/api/talk", { ...where, level: state.level, history, provider: provider() });
    const r = data.result;
    talk.history.push({ role: "partner", text: r.reply });
    bubble("partner", r.reply);
    talk.help = r.help || [];
    helpWords(talk.help);
    [...$("goals").children].forEach((li, i) => li.classList.toggle("done", r.goals_done.includes(i + 1)));
    talk.goalsDone = r.goals_done.length;
    status("");
    if (r.finished) { setBusy(false); speak(r.reply); return endTalk(); }
    setBusy(false);
    // Hands-free: when the partner has finished speaking, Vogi listens again by itself.
    speak(r.reply, false, () => listen());
    return;
  } catch (e) { status(e.message); }
  setBusy(false);
}

function learnerSay(text) {
  text = text.trim();
  if (!text || talk.busy) return;
  const turn = { role: "learner", text };
  talk.history.push(turn);
  bubble("learner", text, turn);
  if (talk.history.filter((t) => t.role === "learner").length >= MAX_TURNS) return endTalk();
  partnerTurn();
}

// End of the talk: a pause on the talk itself, so the learner sees how it ended and can fix a
// misheard line (✎). The feedback comes when they press the button.
async function endTalk() {
  if (talk.ended) return; // a double click must not end twice
  talk.handsFree = false; talk.ended = true;
  await stopListening();
  if (!talk.history.some((t) => t.role === "learner" && !t.removed)) { status("Say something first."); talk.ended = false; return; }
  document.querySelectorAll(".helpwords").forEach((n) => n.remove());
  $("talk").classList.add("over");
  $("talk-done-text").textContent = `The talk is over. Mission: ${talk.goalsDone || 0} of ${talk.scene.goals.length} goals reached. ` +
    "Check your lines: tap ✎ if Vogi misheard a word.";
  $("talk-done").classList.remove("hidden");
  $("see-feedback").disabled = false;
  status("");
}
async function feedback() {
  if ($("see-feedback").disabled) return; // a double click must not send twice
  const said = talk.history.filter((t) => t.role === "learner" && !t.removed);
  if (!said.length) return;
  $("see-feedback").disabled = true;
  $("talk-note").textContent = `Mission: ${talk.goalsDone || 0} of ${talk.scene.goals.length} goals reached. Here is the feedback on what you said.`;
  await runCorrect(said.map((t) => t.text).join("\n"), false, true);
  $("see-feedback").disabled = false;
}

// Hands-free listening. Muse Voice Transcribe's endpointing mode says when the learner has
// finished a sentence; Vogi then sends it without a click.
function updateMic() {
  const on = !!rec;
  $("mic").classList.toggle("on", on);
  $("mic").textContent = on ? "⏸ Pause listening" : "🎤 Speak";
}

async function listen() {
  if (!talk.handsFree || talk.busy || rec || talk.ended || !$("talk") || $("talk").classList.contains("hidden")) return;
  $("say").value = "";
  startLive({ mode: "endpointing" });
  const me = live;
  if (!me) { talk.handsFree = false; updateMic(); return; }
  // A learner needs time to think mid-sentence. After the recogniser marks the end of a
  // sentence, Vogi waits a little longer; if the learner speaks again, the words join the same line.
  me.parts = [];
  const grace = Number($("wait").value) || 1000; // on top of about 2 s the recogniser waits (no setting for that)
  const send = () => {
    if (live !== me || !me.parts.length) return;
    const t = me.parts.join(" ").trim().replace(/([.!?])\1+$/, "$1");
    clearTimeout(talk.idle);
    finishLive(); // sets live to null at once, then closes the socket in the background
    if (rec) stopRec().then(updateMic);
    $("say").value = "";
    learnerSay(t);
  };
  me.onTurn = (text) => {
    if (live !== me || !text.trim()) return;
    me.parts.push(text.trim()); me.text = "";
    $("say").value = me.parts.join(" ");
    clearTimeout(me.sendTimer);
    me.sendTimer = setTimeout(send, grace);
    status("Got it. Keep talking to add more, or wait and Vogi sends it.");
  };
  me.onSpeechStart = () => { clearTimeout(me.sendTimer); status("Listening …"); };
  try { await startRec(); } catch {
    finishLive(); talk.handsFree = false; updateMic();
    status("Vogi cannot use the microphone. Type your answer instead."); return;
  }
  updateMic();
  status("Your turn: speak now. Vogi sends it when you stop.");
  clearTimeout(talk.idle);
  talk.idle = setTimeout(() => {
    if (live === me && !me.text) { talk.handsFree = false; stopListening(); status("Paused. Press Speak when you are ready."); }
  }, 25000);
}

async function stopListening() {
  clearTimeout(talk.idle);
  if (rec) await stopRec();
  const t = await finishLive();
  updateMic();
  return t;
}

// Microphone: record, resample to 24 kHz mono 16-bit (Muse Voice Transcribe takes 16 or 24 kHz), send.
let rec = null;
async function startRec(atLimit = toggleMic) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (e) => {
    const c = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(c);
    liveFeed(c, ctx.sampleRate);
  };
  src.connect(proc); proc.connect(ctx.destination);
  rec = { stream, ctx, src, proc, chunks, rate: ctx.sampleRate, timer: setTimeout(() => atLimit(), 60000) }; // at most a minute per recording
}

const RATE = 24000; // Muse Voice Transcribe takes 16 or 24 kHz (PCM_24KHZ in the realtime handshake)

function keywordsNow() {
  // Bias the recogniser to this scene's words and the words on screen.
  const onScreen = (talk.help || []).concat(talk.history.slice(-1).map((t) => t.text)).join(" ")
    .split(/[\s,.!?…]+/).filter((w) => w.length > 2);
  return [...new Set((talk.scene.words || []).concat(onScreen))].slice(0, 40);
}

// Live: words appear while the learner speaks. The page streams 24 kHz PCM to Vogi's server,
// which relays it to Muse Voice Transcribe's realtime socket. The file upload stays as a fallback.
let live = null;
function startLive(opts = {}) {
  try {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live?code=${encodeURIComponent(stored(CODE_KEY) || "")}`);
    ws.binaryType = "arraybuffer";
    live = { ws, ready: false, queue: [], text: "", final: "", error: "", rs: { pos: 0, prev: 0 } };
    const me = live;
    me.done = new Promise((res) => (me.resolve = res));
    const box = opts.box || $(opts.target || "say");
    ws.onopen = () => ws.send(JSON.stringify({ keywords: opts.keywords || keywordsNow(), mode: opts.mode || "push", lang: opts.lang || "de" }));
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "ready") { me.ready = true; me.queue.forEach((b) => ws.send(b)); me.queue = []; }
      else if (ev.type === "transcript" && ev.transcript) {
        me.text = ev.transcript;
        if (live === me) box.value = [...(me.parts || []), me.text].join(" ");
        if (ev.final) me.final = me.text;
      } else if (ev.type === "speechStart") {
        if (me.onSpeechStart) me.onSpeechStart();
      } else if (ev.type === "speechComplete" && ev.transcript) {
        me.final = ev.transcript;
        if (me.onTurn) me.onTurn(ev.transcript);
      } else if (ev.type === "error") me.error = ev.message || "Live speech failed.";
    };
    ws.onerror = () => { me.error = me.error || "Live connection failed."; };
    ws.onclose = () => me.resolve();
  } catch { live = null; }
}

function liveFeed(input, rate) {
  if (!live || live.error || live.ws.readyState > 1) return;
  // Linear resampling to 24 kHz, carrying the position and last sample across chunks.
  const st = live.rs, step = rate / RATE, out = [];
  let p = st.pos;
  while (p <= input.length - 1) {
    const i = Math.floor(p), f = p - i;
    const a = i < 0 ? st.prev : input[i], b = i + 1 < input.length ? input[i + 1] : a;
    out.push(a + (b - a) * f);
    p += step;
  }
  st.pos = p - input.length; st.prev = input[input.length - 1];
  const pcm = new Int16Array(out.length);
  for (let k = 0; k < out.length; k++) pcm[k] = Math.max(-1, Math.min(1, out[k])) * 0x7fff;
  if (live.ready) live.ws.send(pcm.buffer); else live.queue.push(pcm.buffer);
}

async function finishLive() {
  const me = live; live = null;
  if (!me) return null;
  if (!me.error && me.ws.readyState === 1) {
    me.ws.send(JSON.stringify({ type: "endStream" }));
    await Promise.race([me.done, new Promise((r) => setTimeout(r, 6000))]);
  }
  try { me.ws.close(); } catch { /* already closed */ }
  const tail = me.parts && me.parts.length ? me.text : (me.final || me.text);
  const text = [...(me.parts || []), tail || ""].join(" ").trim().replace(/([.!?])\1+$/, "$1");
  return me.error ? null : text || null;
}

async function stopRec() {
  const r = rec; rec = null; clearTimeout(r.timer);
  r.src.disconnect(); r.proc.disconnect(); r.stream.getTracks().forEach((t) => t.stop());
  const len = r.chunks.reduce((n, c) => n + c.length, 0);
  await r.ctx.close();
  if (len < r.rate * 0.4) return null;
  const off = new OfflineAudioContext(1, Math.ceil((len * RATE) / r.rate), RATE);
  const buf = off.createBuffer(1, len, r.rate);
  let o = 0; for (const c of r.chunks) { buf.copyToChannel(c, 0, o); o += c.length; }
  const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (i, str) => [...str].forEach((ch, k) => out.setUint8(i + k, ch.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, "data"); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([out], { type: "audio/wav" });
}

async function toggleMic() {
  if (talk.scene && !talk.ended) {
    if (!rec) { talk.handsFree = true; return listen(); }
    talk.handsFree = false;
    const words = await stopListening();
    if (words) { $("say").value = words; $("say").focus(); status("Paused. Fix the words if needed, then press Send."); }
    else status("Paused. Press Speak when you are ready.");
    return;
  }
  const mic = $("mic");
  if (!rec) {
    try { speechSynthesis && speechSynthesis.cancel(); $("say").value = ""; startLive(); await startRec(); }
    catch { finishLive(); status("Vogi cannot use the microphone. Type your answer instead."); return; }
    mic.classList.add("on"); mic.textContent = "■ Stop"; status("Listening … speak now. Your words appear in the box.");
    return;
  }
  mic.classList.remove("on"); mic.textContent = "🎤 Speak";
  const wav = await stopRec();
  const heard = await finishLive();
  if (heard) {
    $("say").value = heard; $("say").focus();
    status("Vogi heard this. Fix any word it got wrong, then press Send.");
    return;
  }
  if (!wav) { status("That was too short. Try again."); return; }
  await sendSpeech(wav); // live failed: fall back to the file upload
}

async function sendSpeech(wav) {
  setBusy(true); status("Muse Voice Transcribe is writing down what you said …");
  const form = new FormData(); form.append("audio", wav, "speech.wav");
  form.append("keywords", JSON.stringify(keywordsNow()));
  try {
    const d = await api("/api/transcribe", form, true);
    setBusy(false); status("");
    if (!d.text) { status("Vogi did not hear any words. Try again."); return; }
    // The learner checks what Vogi heard before it counts: a misheard word is not their mistake.
    $("say").value = d.text; $("say").focus();
    status("Vogi heard this. Fix any word it got wrong, then press Send.");
  } catch (e) { setBusy(false); status(e.message); }
}

// Photo: Muse Spark reads the handwriting into the same text box. The learner confirms before any correction.
async function readPhoto(file) {
  if (!file) return;
  state.photo = file;
  $("photo-preview").src = URL.createObjectURL(file);
  $("photo-box").classList.remove("hidden");
  $("unclear").classList.add("hidden");
  $("photo-note").textContent = "Vogi is reading your handwriting …";
  $("go").disabled = true;
  status("Vogi is reading your handwriting …");
  const form = new FormData(); form.append("image", file);
  if (provider()) form.append("provider", provider());
  try {
    const data = await api("/api/read", form, true);
    $("text").value = data.result.text;
    const u = data.result.unclear_words;
    $("unclear").textContent = u.length ? "Hard to read: " + u.join(", ") : "";
    $("unclear").classList.toggle("hidden", !u.length);
    $("photo-note").textContent = "Vogi read this from your photo. Fix any word it misread, then press Check.";
    status("");
  } catch (e) { status(e.message); $("photo-note").textContent = "Vogi could not read the photo."; }
  $("go").disabled = false;
}
function removePhoto() {
  state.photo = null; $("photo").value = "";
  $("photo-box").classList.add("hidden");
}

async function loadProviders() {
  const sel = $("provider");
  try {
    const list = await getJSON("/api/providers");
    sel.replaceChildren(...list.map((p) => el("option", { value: p.id }, p.label)));
    if (!list.length) status("No model key found. See README: put MODEL_API_KEY in ~/.config/vogi/env.");
  } catch (e) { if (e.message !== "access code needed") status("Vogi's server is not running."); }
}

async function loadBoard() {
  try {
    const rows = await getJSON("/api/results");
    if (!rows.length) return;
    const pct = (x) => (x == null ? "–" : Math.round(x * 100) + " %");
    const SET = { basic: "Basic, A1 to B1", hard: "Hard, B2 and C1" };
    rows.sort((a, b) => (a.set || "basic").localeCompare(b.set || "basic"));
    const t = el("table", {}, el("tr", {}, ...["Test set", "Model", "Errors fixed", "Correct left alone", "Avg time"].map((h) => el("th", {}, h))));
    for (const r of rows) t.append(el("tr", {},
      el("td", {}, `${SET[r.set || "basic"] || r.set} (${r.items})`),
      el("td", {}, r.model + (r.open_weight ? " (open)" : "")),
      el("td", {}, `${r.errors_fixed} of ${r.errors_total}`),
      el("td", {}, r.clean_kept == null ? "–" : `${pct(r.clean_kept)}`),
      el("td", {}, (r.avg_ms / 1000).toFixed(1) + " s")));
    const dates = [...new Set(rows.map((r) => r.date))].join(", ");
    $("board").replaceChildren(t, el("p", { class: "note" },
      `Run ${dates} in grammar mode. The sentences are small sets I wrote. No teacher has reviewed them yet.`));
  } catch { /* the scoreboard is optional */ }
}

function optionsLine() {
  $("options-line").textContent = MODE_WORDS[picked("mode")] + ($("tryfirst").checked ? " · I fix my mistakes first" : " · show me the answer");
}

// Learn something: a short lesson that builds itself. Muse Spark writes the plan and checks each
// answer; an exact match is checked by Vogi at once. Pictures come from Muse Image in the background.
const LESSON_MAX = 14; // a lesson never grows past this many cards
const LESSON_PICTURES = 2; // per lesson, as the plan asks
const STEP_KEYS = ["kind", "text", "examples", "picture", "qtype", "prompt", "options", "answer", "hint", "rule", "category"];
const stepBody = (s) => Object.fromEntries(STEP_KEYS.map((k) => [k, s[k]]));
const lesson = { token: 0, title: "", steps: [], cur: 0, pictures: 0, right: 0, wrong: [], busy: false };
const lessonMic = () => dictate($("lesson-mic"), $("lesson-topic"), lessonMic, "Check the topic, then press Start the lesson.", "any");

async function startLesson(topic, mistakes = []) {
  if (lesson.busy) return; // a double click builds one lesson
  if (!topic) { status("Type a topic first."); return; }
  lesson.busy = true; status("Vogi is writing your lesson …");
  try {
    const data = await api("/api/lesson", { topic, level: state.level, mistakes, provider: provider() });
    buildLesson(data.result);
    saveLesson(data.result, topic);
    status(""); show("lesson");
  } catch (e) { status(e.message); } finally { lesson.busy = false; }
}
function startFromMistakes() {
  const list = loadMemory().slice(-12).map(({ original, replacement, category, rule }) =>
    ({ original: original ?? "", replacement: replacement ?? "", category: category || "other", rule: rule ?? "" }));
  if (!list.length) { status("No mistakes saved yet. Check a text first."); return; }
  startLesson("My mistakes: the rules I keep getting wrong", list);
}

function buildLesson(r) {
  lesson.token++; // answers and pictures of the old lesson are ignored from now on
  Object.assign(lesson, { title: r.title, steps: [], cur: 0, pictures: 0, right: 0, wrong: [] });
  $("lesson-title").textContent = r.title;
  $("lesson-cards").replaceChildren();
  $("lesson-end").classList.add("hidden");
  r.steps.forEach((s, k) => insertStep(s, k, false));
  showStep(0);
}

// One card, kept in the lesson at index k. Cards after the current one stay hidden until their turn.
function insertStep(s, k, added) {
  const st = { ...s, added, done: false, tries: 0, firstWrong: "", busy: false, picUrl: "" };
  if (st.kind === "explain" && st.picture && lesson.pictures < LESSON_PICTURES) lesson.pictures++;
  else st.picture = "";
  st.el = st.kind === "explain" ? explainCard(st) : questionCard(st);
  st.el.classList.add("hidden");
  lesson.steps.splice(k, 0, st);
  const next = lesson.steps[k + 1];
  if (next) next.el.before(st.el); else $("lesson-cards").append(st.el);
  if (st.picture) startPicture(st);
  return st;
}
// New steps from the model go right after the current card.
function insertAfter(steps) {
  let k = lesson.cur + 1;
  for (const s of (steps || []).slice(0, Math.max(0, LESSON_MAX - lesson.steps.length))) insertStep(s, k++, true);
}

function showStep(k) {
  lesson.cur = k;
  const st = lesson.steps[k];
  lesson.steps.forEach((s) => s.el.classList.toggle("active", s === st));
  if (!st) return finishLesson();
  st.el.classList.remove("hidden");
  attachPicture(st);
  st.el.scrollIntoView({ behavior: "smooth", block: "start" });
  if (st.focusEl) st.focusEl.focus({ preventScroll: true });
}
function finishLesson() {
  const questions = lesson.steps.filter((s) => s.kind === "question").length;
  $("lesson-score").textContent = questions ? `You got ${lesson.right} of ${questions} right the first time.` : "Lesson done.";
  $("lesson-practise").classList.toggle("hidden", !lesson.wrong.length);
  $("lesson-end").classList.remove("hidden");
  $("lesson-end").scrollIntoView({ behavior: "smooth", block: "start" });
}
function nextAfter(st) { if (lesson.steps[lesson.cur] === st) showStep(lesson.cur + 1); }
function closeCard(st) {
  st.el.classList.add("done"); st.el.classList.remove("active");
  lockQuestion(st, true);
}
function lockQuestion(st, on) {
  if (st.kind === "question") st.el.querySelectorAll("button, input, textarea").forEach((x) => (x.disabled = on || st.done));
}

// Pictures: asked for as soon as the plan arrives. One goes on its card when it is ready,
// but never onto a card that is already done.
function startPicture(st) {
  const token = lesson.token;
  api("/api/lesson/picture", { description: st.picture })
    .then((d) => { if (token === lesson.token) { st.picUrl = d.image; attachPicture(st); } })
    .catch(() => { /* no picture: the lesson goes on without it */ });
}
function attachPicture(st) {
  if (!st.pic || st.done || !st.picUrl || st.pic.hasAttribute("src")) return;
  st.pic.src = st.picUrl; st.pic.classList.remove("hidden");
}

function explainCard(st) {
  const head = el("div", { class: "lhead" }, el("span", { class: "tag" }, "Vogi explains"));
  if (st.added) head.append(el("span", { class: "added" }, "Vogi added this for you"));
  st.pic = el("img", { class: "lpic hidden", alt: st.picture });
  const list = el("ul", { class: "examples" });
  for (const e of st.examples) {
    const b = el("button", { class: "again", title: "Read aloud", "aria-label": "Read aloud" }, "🔊");
    b.onclick = () => speak(e, true);
    list.append(el("li", {}, e, " ", b));
  }
  st.next = el("button", { class: "btn primary" }, "Next");
  st.next.onclick = () => finishExplain(st);
  st.focusEl = st.next;
  return el("article", { class: "lcard explain" }, head, el("p", {}, st.text), st.pic, list, el("div", { class: "acts" }, st.next));
}
function finishExplain(st) {
  if (st.done) return; // a double click on Next moves on once
  st.done = true;
  st.next.classList.add("hidden");
  closeCard(st);
  nextAfter(st);
}

function questionCard(st) {
  const head = el("div", { class: "lhead" }, el("span", { class: "tag" }, "Question"), el("span", { class: "chip" }, CAT[st.category] || "other"));
  if (st.added) head.append(el("span", { class: "added" }, "Vogi added this for you"));
  const fb = el("div", { class: "fb" }), rev = el("div", { class: "reveal hidden" });
  const check = el("button", { class: "btn primary" }, "Check"), dk = el("button", { class: "link" }, "I don't know");
  const acts = el("div", { class: "acts" }, check, dk);
  const parts = [head, el("p", { class: "note" }, st.text), el("div", { class: "task" }, st.prompt), el("p", { class: "note" }, "Hint: " + st.hint)];
  if (st.qtype === "choose") {
    const opts = el("div", { class: "opts-row" });
    for (const o of st.options) {
      const b = el("button", { class: "opt", type: "button", "aria-pressed": "false" }, o);
      b.onclick = () => { st.picked = o; opts.querySelectorAll(".opt").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); };
      opts.append(b);
    }
    st.value = () => st.picked || "";
    st.focusEl = opts.querySelector("button");
    parts.push(opts);
  } else {
    // fill_gap and fix_sentence are one line; write, speak and photo are a few words.
    const input = ["fill_gap", "fix_sentence"].includes(st.qtype)
      ? el("input", { type: "text", autocomplete: "off", spellcheck: "false", "aria-label": "Your answer" })
      : el("textarea", { rows: "3", "aria-label": "Your answer" });
    input.onkeydown = (e) => { if (e.key === "Enter" && input.tagName === "INPUT") { e.preventDefault(); check.click(); } };
    st.input = input; st.value = () => input.value; st.focusEl = input;
    parts.push(input);
    if (st.qtype === "speak") {
      const mic = el("button", { class: "btn" }, "🎤 Answer aloud");
      const speakMic = () => dictate(mic, input, speakMic, "Check the words, then press Check.", "de");
      mic.onclick = speakMic;
      acts.append(mic);
    }
    if (st.qtype === "photo") {
      const file = el("input", { type: "file", accept: "image/jpeg,image/png,image/webp", capture: "environment", class: "hidden" });
      const cam = el("button", { class: "btn" }, "📷 Photo of my answer");
      cam.onclick = () => file.click();
      file.onchange = () => readAnswerPhoto(st, file.files[0]);
      acts.append(cam);
      parts.push(file);
    }
  }
  check.onclick = () => answerStep(st, false);
  dk.onclick = () => answerStep(st, true);
  parts.push(acts, fb, rev);
  st.fb = fb; st.rev = rev;
  return el("article", { class: "lcard question" }, ...parts);
}

// Photo of a handwritten answer: Muse Spark reads it into the box, and the learner checks it before Check.
async function readAnswerPhoto(st, file) {
  if (!file || st.busy || st.done) return;
  st.busy = true; lockQuestion(st, true);
  st.fb.className = "fb"; st.fb.textContent = "Vogi is reading your handwriting …";
  const form = new FormData(); form.append("image", file);
  if (provider()) form.append("provider", provider());
  try {
    const data = await api("/api/read", form, true);
    st.input.value = data.result.text;
    st.fb.textContent = "Vogi read this from your photo. Fix any word it misread, then press Check.";
  } catch (e) { st.fb.textContent = e.message; }
  finally { st.busy = false; lockQuestion(st, false); }
}

// One answer. Muse Spark checks it (an exact match is checked at once) and writes the next hint.
// Dont-know, or a second wrong answer, reveals the answer and may add steps on the same point.
async function answerStep(st, dontKnow) {
  if (st.done || st.busy) return;
  const answer = dontKnow ? "" : st.value().trim();
  if (!dontKnow && !answer) {
    st.fb.className = "fb no";
    st.fb.textContent = st.qtype === "choose" ? "Pick one answer first." : "Write an answer first.";
    return;
  }
  st.busy = true; lockQuestion(st, true); st.fb.className = "fb"; st.fb.textContent = "…";
  const token = lesson.token;
  try {
    const { result: v } = await api("/api/lesson/answer", { title: lesson.title, level: state.level, step: stepBody(st), answer,
      tries: st.tries + 1, dont_know: dontKnow, recent: recentSteps(), provider: provider() });
    if (token !== lesson.token) return;
    if (v.correct) return closeQuestion(st, true, "✓ " + v.feedback);
    if (!st.firstWrong) st.firstWrong = dontKnow ? "(I did not know)" : answer;
    st.tries++;
    if (dontKnow || st.tries >= 2) {
      insertAfter(v.add_steps);
      return closeQuestion(st, false, dontKnow ? v.feedback : "That was not right. Here is the answer.");
    }
    st.fb.className = "fb no"; st.fb.textContent = "Not yet. " + v.feedback;
  } catch (e) { st.fb.className = "fb no"; st.fb.textContent = e.message; }
  finally { st.busy = false; lockQuestion(st, false); }
}

// The card is done. A first-try right answer counts; any other answer goes into My progress.
function closeQuestion(st, right, msg) {
  st.done = true;
  if (right && st.tries === 0) lesson.right++;
  else {
    const item = { category: st.category || "other", original: st.firstWrong, replacement: st.answer, hint: st.hint, rule: st.rule };
    lesson.wrong.push(item);
    saveMemory(loadMemory().concat([{ t: new Date().toISOString(), level: state.level, ...item }]));
    renderMemory();
  }
  closeCard(st);
  st.fb.className = "fb " + (right ? "ok" : "no"); st.fb.textContent = msg;
  st.rev.classList.remove("hidden");
  st.rev.replaceChildren(...(right ? [] : [el("span", {}, "The answer: "), el("b", {}, st.answer), el("br")]),
    st.rule ? el("span", { class: "rule" }, st.rule) : "");
  nextAfter(st);
}

// What came before, for the model: short, and never the answers.
function recentSteps() {
  return lesson.steps.slice(0, lesson.cur).slice(-4)
    .map((s) => (s.kind === "explain" ? `Explained: ${s.text}` : `Asked: ${s.text} ${s.prompt}`).slice(0, 120));
}

// My lessons: the plan of each lesson the learner starts, newest first, so "Do it again" can replay it.
function loadLessons() {
  try { const v = JSON.parse(stored(LESSONS_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveLesson(r, topic) {
  const plan = { id: Date.now().toString(36), t: new Date().toISOString(), title: r.title, topic, level: state.level, steps: r.steps.map(stepBody) };
  store(LESSONS_KEY, JSON.stringify([plan].concat(loadLessons()).slice(0, LESSON_KEEP)));
  renderLessons();
}
function renderLessons() {
  const list = loadLessons();
  $("lessons").classList.toggle("hidden", !list.length);
  $("lessons-list").replaceChildren(...list.map((l) => {
    const again = el("button", { class: "btn" }, "Do it again");
    again.onclick = () => { buildLesson(l); show("lesson"); };
    return el("li", {}, el("strong", {}, l.title), el("span", { class: "note" }, ` · ${l.level} · ${new Date(l.t).toLocaleDateString()}`), again);
  }));
}

// Move to another device: one JSON file with what the learner keeps in this browser.
// The access code never goes into the file. Everything is checked before anything is written.
const BACKUP_MAX = 30 * 1024 * 1024;
const BAD_FILE = "This file is not a Vogi backup. Nothing was changed.";
const WAIT_CHOICES = ["300", "1000", "2000", "3000"];
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x, max) => typeof x === "string" && x.length <= max;
const isStrs = (x, max, len) => Array.isArray(x) && x.length <= max && x.every((s) => isStr(s, len));
const isDataImage = (x) => isStr(x, 8 * 1024 * 1024) && x.startsWith("data:image/");
const markOk = (m) => isObj(m) && Number.isInteger(m.edit) && typeof m.found === "boolean" &&
  (!m.found || (Array.isArray(m.box) && m.box.length === 4 && m.box.every(Number.isFinite)));
const editOk = (e) => isObj(e) && isStr(e.original, 500) && isStr(e.replacement, 500) && isStr(e.category, 40) && isStr(e.rule, 1000);
const lessonStepOk = (s) => isObj(s) && (s.kind === "explain" || s.kind === "question") && isStrs(s.examples ?? [], 10, 300) &&
  isStrs(s.options ?? [], 6, 200) && ["text", "picture", "qtype", "prompt", "answer", "hint", "rule", "category"].every((k) => isStr(s[k] ?? "", 600));
const memKey = (m) => [m.t, m.original, m.replacement, m.category].join("\u0001");
const sceneTime = (s) => parseInt(String(s.id).replace(/^own-/, ""), 36) || 0;

function dataUrlToBlob(url) {
  const comma = url.indexOf(",");
  const head = comma < 0 ? "" : url.slice(0, comma);
  if (!head.endsWith(";base64")) throw new Error("a picture is broken");
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: head.slice(5, -7) });
}
function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
async function pagesAll() { return (await pagesTx("readonly", (st) => st.getAll())) || []; }
function pagesPut(list) {
  return pagesDb().then((d) => new Promise((res, rej) => {
    const tx = d.transaction("pages", "readwrite");
    for (const p of list) tx.objectStore("pages").put(p);
    tx.oncomplete = () => { d.close(); res(); };
    tx.onerror = tx.onabort = () => { d.close(); rej(tx.error || new Error("the write was stopped")); };
  }));
}

async function makeBackup() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("vogi.") && key !== CODE_KEY) data[key] = localStorage.getItem(key);
  }
  data.pages = [];
  for (const p of await pagesAll()) {
    data.pages.push({ id: p.id, t: p.t, level: p.level, text: p.text, marks: p.marks, edits: p.edits, photo: await blobToDataUrl(p.photo) });
  }
  return { app: "vogi", version: 1, exported: new Date().toISOString(), data };
}
function backupMsg(msg) { $("backup-msg").textContent = msg; }
async function exportBackup() {
  const btn = $("export-btn");
  if (btn.disabled) return;
  btn.disabled = true; backupMsg("Preparing the file …");
  try {
    const text = JSON.stringify(await makeBackup());
    // A file Import would refuse is not worth saving: say so now, while the pages can still be trimmed.
    const blob = new Blob([text], { type: "application/json" });
    if (blob.size > BACKUP_MAX) throw new Error("Too big to import again (over 30 MB, mostly page photos). Delete old pages, then export.");
    const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const name = `vogi-backup-${d}.json`;
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    backupMsg(`Saved ${name}. Import it on the other device.`);
  } catch (e) { backupMsg("Export failed: " + e.message); }
  finally { btn.disabled = false; }
}

// Returns the checked content, or throws a plain message. Nothing is written here.
function checkBackup(file) {
  const fail = (what) => new Error(`This file is not a Vogi backup: ${what}. Nothing was changed.`);
  if (!isObj(file) || file.app !== "vogi" || file.version !== 1 || !isObj(file.data)) throw fail("the header is wrong");
  const d = file.data;
  const list = (key, ok) => {
    if (d[key] === undefined) return [];
    if (!isStr(d[key], 5000000)) throw fail(`${key} is not text`);
    let v;
    try { v = JSON.parse(d[key]); } catch { throw fail(`${key} is broken`); }
    if (!Array.isArray(v) || v.length > 5000 || !v.every(ok)) throw fail(`${key} has an entry in the wrong form`);
    return v;
  };
  const mistakes = list(MEMORY_KEY, (m) => isObj(m) && isStr(m.t, 40) && isStr(m.original, 500) && isStr(m.replacement, 500) &&
    isStr(m.category, 40) && (m.hint === undefined || isStr(m.hint, 1000)) && (m.rule === undefined || isStr(m.rule, 1000)) &&
    (m.level === undefined || isStr(m.level, 8)));
  const scenes = list(OWN_KEY, (s) => isObj(s) && isStr(s.id, 80) && isStr(s.title, 80) && isStr(s.partner, 300) &&
    isStr(s.setting, 400) && isStrs(s.words ?? [], 20, 60) && isStrs(s.goals, 5, 300) && s.goals.length > 0 &&
    (s.picture === undefined || isDataImage(s.picture)));
  const lessons = list(LESSONS_KEY, (l) => isObj(l) && isStr(l.id, 80) && isStr(l.t, 40) && isStr(l.title, 200) &&
    isStr(l.topic, 400) && isStr(l.level, 8) && Array.isArray(l.steps) && l.steps.length > 0 && l.steps.length <= LESSON_MAX &&
    l.steps.every(lessonStepOk));
  if (d.pages !== undefined && (!Array.isArray(d.pages) || d.pages.length > 500)) throw fail("pages is not a list");
  const pages = (d.pages || []).map((p) => {
    if (!(isObj(p) && isStr(p.id, 80) && isStr(p.t, 40) && isStr(p.level, 8) && isStr(p.text, 1500) && isDataImage(p.photo) &&
      Array.isArray(p.marks) && p.marks.every(markOk) && Array.isArray(p.edits) && p.edits.every(editOk))) throw fail("a page is in the wrong form");
    let photo;
    try { photo = dataUrlToBlob(p.photo); } catch { throw fail("a page photo is broken"); }
    return { id: p.id, t: p.t, level: p.level, text: p.text, marks: p.marks, edits: p.edits, photo };
  });
  const settings = {};
  const setting = (key, ok, norm = (v) => v) => {
    if (d[key] === undefined) return;
    if (!isStr(d[key], 500) || !ok(d[key])) throw fail(`the setting ${key} is wrong`);
    settings[key] = norm(d[key]);
  };
  const isJsonList = (v) => { try { return Array.isArray(JSON.parse(v)); } catch { return false; } };
  setting(LEVEL_KEY, (v) => LEVELS.includes(main(v)), main);
  setting(WAIT_KEY, (v) => WAIT_CHOICES.includes(v));
  setting(TRY_KEY, (v) => v === "0" || v === "1");
  setting(EST_KEY, isJsonList);
  setting(DISMISS_KEY, (v) => LEVELS.includes(main(v)), main);
  return { mistakes, scenes, lessons, pages, settings };
}

// Keeps the first of each item, and drops items already here.
function fresh(list, seen, key) {
  return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
}
// Merges the checked content into this browser. Records are added by id (mistakes by their content);
// settings are taken only where this browser has none yet.
async function applyBackup(plan) {
  const count = { mistakes: 0, scenes: 0, lessons: 0, pages: 0 };
  const have = loadMemory();
  const newMistakes = fresh(plan.mistakes, new Set(have.map(memKey)), memKey);
  if (newMistakes.length) { localStorage.setItem(MEMORY_KEY, JSON.stringify(have.concat(newMistakes).slice(-300))); count.mistakes = newMistakes.length; }
  const haveScenes = ownScenes();
  const newScenes = fresh(plan.scenes, new Set(haveScenes.map((s) => s.id)), (s) => s.id);
  if (newScenes.length) {
    localStorage.setItem(OWN_KEY, JSON.stringify(newScenes.concat(haveScenes).sort((a, b) => sceneTime(b) - sceneTime(a))));
    count.scenes = newScenes.length;
  }
  const haveLessons = loadLessons();
  const newLessons = fresh(plan.lessons, new Set(haveLessons.map((l) => l.id)), (l) => l.id);
  if (newLessons.length) {
    const all = newLessons.concat(haveLessons).sort((a, b) => (b.t > a.t ? 1 : b.t < a.t ? -1 : 0)).slice(0, LESSON_KEEP);
    const keep = new Set(all.map((l) => l.id));
    localStorage.setItem(LESSONS_KEY, JSON.stringify(all));
    count.lessons = newLessons.filter((l) => keep.has(l.id)).length;
  }
  for (const [key, value] of Object.entries(plan.settings)) {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }
  const havePages = await pagesAll();
  const newPages = fresh(plan.pages, new Set(havePages.map((p) => p.id)), (p) => p.id);
  if (newPages.length) { await pagesPut(newPages); count.pages = newPages.length; }
  return count;
}
function importSummary(n) {
  const part = (num, one, many) => (num ? `${num} ${num === 1 ? one : many}` : "");
  const words = [part(n.mistakes, "mistake", "mistakes"), part(n.scenes, "scene", "scenes"),
    part(n.pages, "page", "pages"), part(n.lessons, "lesson", "lessons")].filter(Boolean);
  return words.length ? `Imported ${words.join(", ")}.` : "Nothing new in this file. This browser has it already.";
}
function refreshAfterImport() {
  renderMemory(); renderScenes(); renderPages(); renderLessons();
  if (stored(LEVEL_KEY)) setLevel(stored(LEVEL_KEY));
  $("wait").value = stored(WAIT_KEY) || $("wait").value;
  $("tryfirst").checked = stored(TRY_KEY) !== "0";
  optionsLine();
}
async function importBackup(file) {
  const btn = $("import-btn");
  if (!file || btn.disabled) return; // a double click imports once
  btn.disabled = true; backupMsg("Reading the file …");
  try {
    if (file.size > BACKUP_MAX) throw new Error("This file is larger than 30 MB, so it is not a Vogi backup. Nothing was changed.");
    let obj;
    try { obj = JSON.parse(await file.text()); } catch { throw new Error(BAD_FILE); }
    const plan = checkBackup(obj);
    let count;
    try { count = await applyBackup(plan); }
    catch {
      refreshAfterImport();
      throw new Error("Import stopped: this browser could not save everything, maybe its storage is full. What fitted is in place.");
    }
    refreshAfterImport();
    backupMsg(importSummary(count));
  } catch (e) { backupMsg(e.message); }
  finally { btn.disabled = false; }
}

// Wiring
$("brand").onclick = () => show("home");
$("export-btn").onclick = exportBackup;
$("import-btn").onclick = () => $("import-file").click();
$("import-file").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; importBackup(f); };
$("level-chip").onclick = askLevel;
document.querySelectorAll("[data-level]").forEach((b) => b.onclick = () => {
  const first = !state.level; setLevel(b.dataset.level); first ? show("home", false) : back();
});
document.querySelectorAll("[data-go]").forEach((b) => b.onclick = () => show(b.dataset.go));
document.querySelectorAll("[data-back]").forEach((b) => b.onclick = back);
document.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => {
  document.querySelector(`input[name=mode][value=${b.dataset.mode}]`).checked = true; optionsLine();
  runCorrect(state.text, state.fromPhoto);
});
$("go").onclick = () => runCorrect($("text").value, !!state.photo);
$("text").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("go").click(); };
$("cam").onclick = () => $("photo").click();
$("photo").onchange = (e) => readPhoto(e.target.files[0]);
$("photo-remove").onclick = removePhoto;
$("again").onclick = () => {
  nav.length = 0; nav.push("home");
  if (state.origin === "talk" && talk.scene) { show("talk", false); talk.startedAt = 0; startScene(talk.scene); }
  else show("write", false);
};
$("other-scene").onclick = () => { nav.length = 0; nav.push("home"); talk.ended = true; show("talk", false); };
$("practise").onclick = () => runPractice();
$("practise-top").onclick = practiseTop;
$("practice-done").onclick = back;
$("forget").onclick = () => { if (confirm("Forget all saved mistakes?")) { saveMemory([]); renderMemory(); } };
$("show-full").onclick = () => { $("full").classList.remove("hidden"); $("show-full").classList.add("hidden"); };
$("how-link").onclick = () => { $("about").open = true; $("checks").scrollIntoView({ behavior: "smooth", block: "center" }); };
try { $("tryfirst").checked = localStorage.getItem(TRY_KEY) !== "0"; } catch { /* storage blocked */ }
$("tryfirst").onchange = () => { store(TRY_KEY, $("tryfirst").checked ? "1" : "0"); optionsLine(); };
document.querySelectorAll("input[name=mode]").forEach((r) => r.onchange = optionsLine);
$("mic").onclick = toggleMic;
$("send").onclick = () => { learnerSay($("say").value); $("say").value = ""; };
$("say").onkeydown = (e) => { if (e.key === "Enter") $("send").click(); };
// Typing pauses hands-free listening, so the microphone does not talk over the keyboard.
$("say").onfocus = () => { if (rec && talk.handsFree) { talk.handsFree = false; stopListening(); status("Listening paused while you type."); } };
$("end-talk").onclick = endTalk;
$("see-feedback").onclick = feedback;
$("new-scene").onclick = () => { talk.ended = true; stopListening(); $("talk").classList.add("hidden"); $("scene-pick").classList.remove("hidden"); speechSynthesis && speechSynthesis.cancel(); };
$("own-go").onclick = makeOwn;
$("own-again").onclick = makeOwn;
$("own-start").onclick = startOwn;
$("own-mic").onclick = ownMic;
document.querySelectorAll(".chip-topic[data-topic]").forEach((b) => b.onclick = () => startLesson(b.dataset.topic));
$("chip-mistakes").onclick = startFromMistakes;
$("lesson-go").onclick = () => startLesson($("lesson-topic").value.trim());
$("lesson-topic").onkeydown = (e) => { if (e.key === "Enter") $("lesson-go").click(); };
$("lesson-mic").onclick = lessonMic;
$("lesson-practise").onclick = () => runPractice(lesson.wrong.map((w) => ({ ...w, severity: "error", hint: w.hint || "" })));
$("lesson-again").onclick = () => { nav.length = 0; nav.push("home"); show("lesson-pick", false); };
$("own-cancel").onclick = () => { if (rec) ownMic(); $("own").classList.add("hidden"); $("scene-pick").classList.remove("hidden"); };
// Time to think: the learner's choice, kept in this browser. Beginners start with more.
$("wait").value = stored(WAIT_KEY) || (["A1", "A2"].includes(main(state.level || "A2")) ? "1000" : "300");
$("wait").onchange = () => store(WAIT_KEY, $("wait").value);
$("pv-close").onclick = closePage;
$("pv-delete").onclick = async () => {
  if (!openPage || !confirm("Delete this page from this browser?")) return;
  const id = openPage;
  try { await pagesTx("readwrite", (st) => st.delete(id)); } catch { /* ignore */ }
  closePage(); renderPages();
};
optionsLine();
const savedLevel = stored(LEVEL_KEY);
setLevel(savedLevel);
function startPage() {
  if (state.level) show("home", false); else show("level", false);
}
startPage();
$("code-go").onclick = async () => {
  const code = $("code-in").value.trim();
  if (!code) return;
  $("code-go").disabled = true;
  try {
    const res = await fetch("/api/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { $("code-msg").textContent = data.detail || "That code is not right."; return; }
    store(CODE_KEY, code);
    startPage(); loadProviders(); loadScenes(); loadBoard();
  } finally { $("code-go").disabled = false; }
};
$("code-in").onkeydown = (e) => { if (e.key === "Enter") $("code-go").click(); };
loadProviders(); loadBoard(); renderMemory(); loadScenes(); renderPages(); renderLessons();
