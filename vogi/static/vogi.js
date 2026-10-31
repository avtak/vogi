"use strict";
const $ = (id) => document.getElementById(id);
const state = { text: "", level: "A2", edits: [] };

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
  word_choice: "better word", style: "style", other: "other",
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
}

async function runCorrect(text) {
  state.text = text.trim(); state.level = picked("level");
  if (!state.text) { status("Write a sentence first."); return; }
  $("go").disabled = true; status("Vogi is reading your text …");
  try {
    renderResult(await api("/api/correct", { text: state.text, level: state.level, mode: picked("mode"), provider: $("provider").value || null }));
    status(""); $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { status(e.message); } finally { $("go").disabled = false; }
}

async function runPractice() {
  const errs = state.edits.filter((e) => e.severity === "error");
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

async function readPhoto(file) {
  if (!file) return;
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
});
$("go").onclick = () => runCorrect(document.querySelector(".tab.on").dataset.tab === "photo" ? $("read-text").value : $("text").value);
$("confirm").onclick = () => runCorrect($("read-text").value);
$("photo").onchange = (e) => readPhoto(e.target.files[0]);
$("practise").onclick = runPractice;
loadProviders(); loadBoard();
