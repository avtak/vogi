"use strict";
const $ = (id) => document.getElementById(id);
const state = { text: "", level: "A2", edits: [], photo: null, fromPhoto: false };
const MEMORY_KEY = "vogi.mistakes.v1";
const TRY_KEY = "vogi.tryfirst";

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else n.setAttribute(k, v);
  }
  for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}

function status(msg) { $("status").textContent = msg || ""; }

async function api(path, body, isForm = false) {
  const res = await fetch(path, isForm
    ? { method: "POST", body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Error ${res.status}`);
  return data;
}

function picked(name) { return document.querySelector(`input[name=${name}]:checked`).value; }

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
  diff(a, b).forEach(([t, words], k) => {
    if (k) box.append(" ");
    box.append(t === "eq" ? words.join(" ") : el(t, {}, words.join(" ")));
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
    `${c.grounded} of ${c.total} changes point at words that are really in your text.`);
  for (const w of c.warnings) box.append(el("br"), "⚠ " + w);
  const m = data.meta;
  $("meta").textContent = `${m.model}${m.open_weight ? " (open weights)" : ""} · ${(m.ms / 1000).toFixed(1)} s · ` +
    `${m.tokens_in + m.tokens_out} tokens` + (m.usd_estimate != null ? ` · about $${m.usd_estimate.toFixed(4)}` : "") +
    ` · format: ${m.format}`;
  $("practise").classList.toggle("hidden", !r.edits.some((e) => e.severity === "error"));
  $("result").classList.remove("hidden");
  $("practice").classList.add("hidden");
  const tryable = r.edits.map((e, k) => ({ e, n: k + 1 })).filter(({ e }, i) => e.severity === "error" && c.edits[i].grounded);
  const trying = $("tryfirst").checked && tryable.length > 0;
  $("try").classList.toggle("hidden", !trying);
  $("full").classList.toggle("hidden", trying);
  $("show-full").classList.remove("hidden");
  $("result-title").textContent = trying ? "Your mistakes: fix them yourself" : "Your text, corrected";
  if (trying) renderTry(tryable);
}

// Try first: Vogi marks where each mistake is and gives a hint. The learner fixes it.
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
  const progress = () => {
    $("try-progress").textContent = done < items.length
      ? `Vogi found ${items.length} mistake${items.length > 1 ? "s" : ""}. Fix each one yourself. Fixed by you: ${self} of ${items.length}.`
      : `You fixed ${self} of ${items.length} mistakes yourself.`;
    if (done === items.length) { $("full").classList.remove("hidden"); $("show-full").classList.add("hidden"); }
  };
  const list = $("try-list"); list.replaceChildren();
  for (const { e, n } of items) {
    const spoils = e.replacement && e.hint.toLowerCase().includes(e.replacement.toLowerCase()) && !e.original.toLowerCase().includes(e.replacement.toLowerCase());
    const hint = spoils ? `Look at the ${CAT[e.category] || e.category}.` : e.hint;
    const inp = el("input", { type: "text", value: e.original, autocomplete: "off", spellcheck: "false", "aria-label": `Your fix for mistake ${n}` });
    const check = el("button", { class: "btn" }, "Check"), show = el("button", { class: "btn" }, "Show answer");
    const fb = el("div", { class: "fb" });
    let tries = 0, closed = false;
    const close = (byLearner, msg) => {
      closed = true; done++; if (byLearner) self++;
      inp.disabled = true; check.disabled = true; show.disabled = true;
      fb.className = "fb " + (byLearner ? "ok" : "no");
      fb.replaceChildren((byLearner ? "✓ " : "") + msg, el("span", { class: "rule" }, e.rule));
      if (markEl[n]) markEl[n].classList.add("done");
      progress();
    };
    check.onclick = async () => {
      const answer = inp.value.trim();
      if (closed || !answer || answer === e.original) return;
      if (_norm(answer) === _norm(e.replacement)) return close(true, "Right!");
      check.disabled = true; fb.className = "fb"; fb.textContent = "…";
      try {
        const v = await api("/api/check", { provider: $("provider").value || null, answer, exercise: {
          type: "fix_sentence", instruction: `Fix the words '${e.original}' in this text.`, prompt: state.text,
          options: [], answer: e.replacement, category: e.category, hint: e.hint } });
        if (v.correct) return close(true, "Right! " + v.feedback);
        tries++;
        if (tries >= 2) return close(false, `The answer: ${e.original} → ${e.replacement}`);
        fb.className = "fb no"; fb.textContent = "Not yet. " + v.feedback;
      } catch (err) { fb.textContent = err.message; }
      if (!closed) check.disabled = false;
    };
    inp.onkeydown = (ev) => { if (ev.key === "Enter") check.click(); };
    show.onclick = () => { if (!closed) close(false, `The answer: ${e.original} → ${e.replacement}`); };
    list.append(el("li", { value: n },
      el("span", { class: "chip" }, CAT[e.category] || e.category),
      el("span", { class: "hint" }, hint),
      el("div", {}, inp, check, " ", show), fb));
  }
  progress();
}

function _norm(s) { return s.replace(/[\s.!?,;:]+/g, " ").trim(); }

async function runCorrect(text, fromPhoto = false, spoken = false) {
  state.text = text.trim(); state.level = picked("level"); state.fromPhoto = fromPhoto && !!state.photo;
  if (!state.text) { status("Write a sentence first."); return; }
  $("go").disabled = true; status("Vogi is reading your text …");
  try {
    const data = await api("/api/correct", { text: state.text, level: state.level, mode: spoken ? "grammar" : picked("mode"), spoken, provider: $("provider").value || null });
    renderResult(data);
    remember(data.result.edits.filter((e, k) => e.severity === "error" && data.checks.edits[k].grounded));
    status(""); $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    if (state.fromPhoto) redPen(data.result.edits);
  } catch (e) { status(e.message); } finally { $("go").disabled = false; }
}

async function runPractice(errs = state.edits.filter((e) => e.severity === "error")) {
  if (!errs.length) return;
  $("practise").disabled = true; status("Vogi is writing exercises from your mistakes …");
  try {
    const data = await api("/api/exercises", { level: state.level, edits: errs, provider: $("provider").value || null });
    const list = $("ex"); list.replaceChildren();
    for (const ex of data.result.exercises) list.append(exerciseItem(ex));
    $("practice").classList.remove("hidden"); status("");
    $("practice").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { status(e.message); } finally { $("practise").disabled = false; }
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
  }
  const fb = el("div", { class: "fb" });
  const btn = el("button", { class: "btn" }, "Check");
  const hint = el("button", { class: "btn" }, "Hint");
  btn.onclick = async () => {
    const answer = get().trim(); if (!answer) return;
    btn.disabled = true; fb.textContent = "…";
    try {
      const v = await api("/api/check", { exercise: ex, answer, provider: $("provider").value || null });
      fb.className = "fb " + (v.correct ? "ok" : "no"); fb.textContent = (v.correct ? "✓ " : "✗ ") + v.feedback;
    } catch (e) { fb.textContent = e.message; } finally { btn.disabled = false; }
  };
  hint.onclick = () => { fb.className = "fb"; fb.textContent = "Hint: " + ex.hint; };
  li.append(el("div", {}, btn, " ", hint), fb);
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
  if ($("provider").value) form.append("provider", $("provider").value);
  try {
    const data = await api("/api/locate", form, true);
    const layer = $("redpen-marks"); layer.replaceChildren();
    let found = 0;
    for (const m of data.result.marks) {
      if (!m.found) continue;
      found++;
      const [x0, y0, x1, y1] = m.box;
      const box = el("div", { class: "mark" }, el("span", {}, m.edit));
      Object.assign(box.style, { left: x0 / 10 + "%", top: y0 / 10 + "%", width: (x1 - x0) / 10 + "%", height: (y1 - y0) / 10 + "%" });
      layer.append(box);
    }
    $("redpen-note").textContent = `Red pen: ${found} of ${edits.length} changes marked on your page. The numbers match the list below.`;
    $("redpen").classList.remove("hidden");
  } catch (e) { $("redpen-note").textContent = "Red pen failed: " + e.message; $("redpen").classList.remove("hidden"); }
}

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
  saveMemory(loadMemory().concat(errs.map((e) => ({ t, level: state.level, category: e.category, original: e.original, replacement: e.replacement, rule: e.rule }))));
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
function practiseTop() {
  const cats = topCategories(loadMemory()).slice(0, 3);
  state.level = picked("level");
  runPractice(cats.flatMap(([, items]) => items.slice(-2)).map((m) => ({ ...m, severity: "error" })).map(({ t, level, ...e }) => e));
}

// Talk: a role-play with a mission. The partner never corrects; the feedback comes after.
const talk = { scene: null, history: [], busy: false };
const MAX_TURNS = 8;

async function loadScenes() {
  try {
    const list = await (await fetch("/api/scenes")).json();
    $("scenes").replaceChildren(...list.map((sc) => {
      const b = el("button", { class: "scene" }, el("strong", {}, sc.title), el("small", {}, sc.goals.join(" · ")));
      b.onclick = () => startScene(sc);
      return b;
    }));
  } catch { /* the server is down: loadProviders says so */ }
}

function bubble(role, text) {
  const b = el("div", { class: "bubble " + role }, el("span", { class: "who" }, role === "partner" ? talk.scene.title : "You"), text);
  if (role === "partner") {
    const again = el("button", { class: "btn", title: "Say it again", "aria-label": "Say it again" }, "🔊");
    again.style.marginLeft = "6px"; again.style.padding = "0 6px";
    again.onclick = () => speak(text, true);
    b.append(again);
  }
  $("chat").append(b); $("chat").scrollTop = $("chat").scrollHeight;
}

function speak(text, force = false) {
  if (!("speechSynthesis" in window) || (!force && !$("voice").checked)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "de-DE";
  const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.toLowerCase().startsWith("de"));
  if (v) u.voice = v;
  u.rate = ["A0", "A1", "A2"].includes(picked("level")) ? 0.85 : 1;
  speechSynthesis.speak(u);
}

function startScene(sc) {
  Object.assign(talk, { scene: sc, history: [], busy: false });
  $("scene-title").textContent = sc.title;
  $("goals").replaceChildren(...sc.goals.map((g) => el("li", {}, g)));
  $("chat").replaceChildren(); $("talk-result").classList.add("hidden");
  $("scene-pick").classList.add("hidden"); $("talk").classList.remove("hidden");
  partnerTurn();
}

function setBusy(b) { talk.busy = b; ["mic", "send", "say"].forEach((id) => ($(id).disabled = b)); }

async function partnerTurn() {
  setBusy(true); status(talk.history.length ? "The partner is answering …" : "The partner is starting …");
  try {
    const data = await api("/api/talk", { scene: talk.scene.id, level: picked("level"), history: talk.history, provider: $("provider").value || null });
    const r = data.result;
    talk.history.push({ role: "partner", text: r.reply });
    bubble("partner", r.reply); speak(r.reply);
    [...$("goals").children].forEach((li, i) => li.classList.toggle("done", r.goals_done.includes(i + 1)));
    talk.goalsDone = r.goals_done.length;
    status("");
    if (r.finished) return endTalk();
  } catch (e) { status(e.message); }
  setBusy(false);
}

function learnerSay(text) {
  text = text.trim();
  if (!text || talk.busy) return;
  talk.history.push({ role: "learner", text });
  bubble("learner", text);
  if (talk.history.filter((t) => t.role === "learner").length >= MAX_TURNS) return endTalk();
  partnerTurn();
}

function endTalk() {
  setBusy(true);
  const said = talk.history.filter((t) => t.role === "learner").map((t) => t.text);
  if (!said.length) { status("Say something first."); setBusy(false); return; }
  $("talk-result").textContent = `Mission: ${talk.goalsDone || 0} of ${talk.scene.goals.length} goals reached. Your feedback on what you said is below.`;
  $("talk-result").classList.remove("hidden");
  status("Vogi is checking what you said …");
  runCorrect(said.join("\n"), false, true);
}

// Microphone: record, downsample to 16 kHz mono 16-bit WAV (what Muse Voice Transcribe takes), send.
let rec = null;
async function startRec() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ctx.destination);
  rec = { stream, ctx, src, proc, chunks, rate: ctx.sampleRate, timer: setTimeout(() => toggleMic(), 60000) };
}

async function stopRec() {
  const r = rec; rec = null; clearTimeout(r.timer);
  r.src.disconnect(); r.proc.disconnect(); r.stream.getTracks().forEach((t) => t.stop());
  const len = r.chunks.reduce((n, c) => n + c.length, 0);
  await r.ctx.close();
  if (len < r.rate * 0.4) return null;
  const off = new OfflineAudioContext(1, Math.ceil((len * 16000) / r.rate), 16000);
  const buf = off.createBuffer(1, len, r.rate);
  let o = 0; for (const c of r.chunks) { buf.copyToChannel(c, 0, o); o += c.length; }
  const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (i, str) => [...str].forEach((ch, k) => out.setUint8(i + k, ch.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, "data"); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([out], { type: "audio/wav" });
}

async function toggleMic() {
  const mic = $("mic");
  if (!rec) {
    try { speechSynthesis && speechSynthesis.cancel(); await startRec(); } catch { status("Vogi cannot use the microphone. Type your answer instead."); return; }
    mic.classList.add("on"); mic.textContent = "■ Stop and send"; status("Listening … speak now.");
    return;
  }
  mic.classList.remove("on"); mic.textContent = "🎤 Start speaking";
  const wav = await stopRec();
  if (!wav) { status("That was too short. Try again."); return; }
  await sendSpeech(wav);
}

async function sendSpeech(wav) {
  setBusy(true); status("Muse Voice Transcribe is writing down what you said …");
  const form = new FormData(); form.append("audio", wav, "speech.wav");
  try {
    const d = await api("/api/transcribe", form, true);
    setBusy(false); status("");
    if (!d.text) { status("Vogi did not hear any words. Try again."); return; }
    learnerSay(d.text);
  } catch (e) { setBusy(false); status(e.message); }
}

async function readPhoto(file) {
  if (!file) return;
  state.photo = file;
  $("photo-preview").src = URL.createObjectURL(file);
  $("photo-label").textContent = file.name;
  status("Vogi is reading your handwriting …");
  const form = new FormData(); form.append("image", file);
  if ($("provider").value) form.append("provider", $("provider").value);
  try {
    const data = await api("/api/read", form, true);
    $("read-text").value = data.result.text;
    const u = data.result.unclear_words;
    $("unclear").textContent = u.length ? "Hard to read: " + u.join(", ") : "";
    $("unclear").classList.toggle("hidden", !u.length);
    $("reading").classList.remove("hidden"); status("");
  } catch (e) { status(e.message); }
}

async function loadProviders() {
  const sel = $("provider");
  try {
    const list = await (await fetch("/api/providers")).json();
    sel.replaceChildren(...list.map((p) => el("option", { value: p.id }, p.label)));
    if (!list.length) status("No model key found. See README: put MODEL_API_KEY in ~/.config/vogi/env.");
  } catch { status("Vogi's server is not running."); }
}

async function loadBoard() {
  try {
    const rows = await (await fetch("/api/results")).json();
    if (!rows.length) return;
    const pct = (x) => (x == null ? "–" : Math.round(x * 100) + " %");
    const t = el("table", {}, el("tr", {}, ...["Model", "Errors fixed", "Clean sentences left alone", "Valid format", "Avg time"].map((h) => el("th", {}, h))));
    for (const r of rows) t.append(el("tr", {}, el("td", {}, r.model + (r.open_weight ? " (open)" : "")),
      el("td", {}, `${pct(r.recall)} (${r.errors_fixed}/${r.errors_total})`), el("td", {}, pct(r.clean_kept)),
      el("td", {}, pct(r.valid_rate)), el("td", {}, (r.avg_ms / 1000).toFixed(1) + " s")));
    $("board").replaceChildren(t, el("p", { class: "note" }, `Test set: ${rows[0].items} sentences, run ${rows.map((r) => r.date).join(", ")}.`));
  } catch { /* the scoreboard is optional */ }
}

document.querySelectorAll(".tab").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", x === b); });
  $("pane-type").classList.toggle("hidden", b.dataset.tab !== "type");
  $("pane-photo").classList.toggle("hidden", b.dataset.tab !== "photo");
  $("pane-talk").classList.toggle("hidden", b.dataset.tab !== "talk");
  $("mode-set").classList.toggle("hidden", b.dataset.tab === "talk");
  $("go").classList.toggle("hidden", b.dataset.tab === "talk");
});
$("go").onclick = () => {
  const photo = document.querySelector(".tab.on").dataset.tab === "photo";
  runCorrect(photo ? $("read-text").value : $("text").value, photo);
};
$("confirm").onclick = () => runCorrect($("read-text").value, true);
$("photo").onchange = (e) => readPhoto(e.target.files[0]);
$("practise").onclick = () => runPractice();
$("practise-top").onclick = practiseTop;
$("forget").onclick = () => { if (confirm("Forget all saved mistakes?")) { saveMemory([]); renderMemory(); } };
$("show-full").onclick = () => { $("full").classList.remove("hidden"); $("show-full").classList.add("hidden"); };
try { $("tryfirst").checked = localStorage.getItem(TRY_KEY) !== "0"; } catch { /* storage blocked */ }
$("tryfirst").onchange = () => { try { localStorage.setItem(TRY_KEY, $("tryfirst").checked ? "1" : "0"); } catch { /* ignore */ } };
$("mic").onclick = toggleMic;
$("send").onclick = () => { learnerSay($("say").value); $("say").value = ""; };
$("say").onkeydown = (e) => { if (e.key === "Enter") $("send").click(); };
$("end-talk").onclick = endTalk;
$("new-scene").onclick = () => { $("talk").classList.add("hidden"); $("scene-pick").classList.remove("hidden"); speechSynthesis && speechSynthesis.cancel(); };
loadProviders(); loadBoard(); renderMemory(); loadScenes();
