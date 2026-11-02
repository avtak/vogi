"""Calls to the model, and Vogi's own check of every answer."""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import random
import re
import time
from difflib import SequenceMatcher
from typing import TypeVar

import httpx
import openai
from PIL import Image, ImageOps
from pydantic import BaseModel, ValidationError

from . import prompts
from .providers import Provider, client
from .schema import Correction, Exercises, Lesson, LessonTurn, Marks, PartnerTurn, Reading, Scene, Verdict, json_schema

T = TypeVar("T", bound=BaseModel)
log = logging.getLogger("vogi")
_http = httpx.Client(timeout=httpx.Timeout(45, connect=5))

# Standard-mode prices per 1M tokens for muse-spark-1.3 (dev.meta.ai/docs/pricing-rate-limits, 31.10.2026).
PRICE_IN, PRICE_CACHED, PRICE_OUT = 1.25, 0.15, 4.25


def _strip_fences(s: str) -> str:
    s = s.strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", s, re.S)
    return m.group(1) if m else s


def ask(p: Provider, messages: list[dict], model: type[T], effort: str | None = None) -> tuple[T, dict]:
    """One structured call. Returns the validated object and usage facts.

    effort: Muse Spark's reasoning_effort (minimal ... max, dev.meta.ai/docs/reasoning). Only sent
    to the Meta Model API; other hosts get the model's default.
    """
    schema = json_schema(model)
    fmt = {"type": "json_schema", "json_schema": {"name": model.__name__, "strict": True, "schema": schema}}
    started = time.perf_counter()
    # A host without structured output (Baseten for Muse Spark Open) gets the schema in the prompt.
    mode = "native-schema" if p.native_schema else "schema-in-prompt"
    msgs = messages if p.native_schema else _with_schema(messages, schema)
    attempts, tin, tout, cached = 0, 0, 0, 0
    while True:
        attempts += 1
        try:
            kwargs = {"response_format": fmt} if mode == "native-schema" else {}
            if effort and p.id == "meta":
                kwargs["reasoning_effort"] = effort
            resp = client(p).chat.completions.create(model=p.model, messages=msgs, **kwargs)
        except openai.BadRequestError:
            # On Meta a 400 means the request itself needs fixing (dev.meta.ai/docs/error-handling):
            # do not hide it behind a second call. Other hosts may simply not take json_schema.
            if mode != "native-schema" or p.id == "meta":
                raise
            mode = "schema-in-prompt"
            msgs = _with_schema(messages, schema)
            continue
        u = resp.usage
        if u:
            tin += u.prompt_tokens
            tout += u.completion_tokens
            details = getattr(u, "prompt_tokens_details", None)
            cached += (getattr(details, "cached_tokens", 0) or 0) if details else 0
        raw = resp.choices[0].message.content or ""
        try:
            obj = model.model_validate_json(_strip_fences(raw))
            break
        except ValidationError:
            if attempts >= 2:
                raise
            msgs = msgs + [{"role": "assistant", "content": raw},
                           {"role": "user", "content": "That did not match the schema. Return only the JSON object."}]
    usd = ((tin - cached) * PRICE_IN + cached * PRICE_CACHED + tout * PRICE_OUT) / 1e6
    return obj, {
        "provider": p.id, "model": p.model, "open_weight": p.open_weight, "format": mode,
        "attempts": attempts, "ms": round((time.perf_counter() - started) * 1000),
        "tokens_in": tin, "tokens_out": tout, "tokens_cached": cached,
        "usd_estimate": round(usd, 5) if p.id == "meta" else None,
    }


def _with_schema(messages: list[dict], schema: dict) -> list[dict]:
    """Put the JSON schema into the system message, for hosts without structured output."""
    note = "\n\nAnswer with JSON only, matching this schema:\n" + json.dumps(schema)
    if messages and messages[0]["role"] == "system":
        return [{**messages[0], "content": messages[0]["content"] + note}] + messages[1:]
    return [{"role": "system", "content": note.strip()}] + messages


def correct(p: Provider, text: str, level: str, mode: str, spoken: bool = False) -> dict:
    # minimal reasoning for grammar only, low for the other goals: 2 to 3 s instead of 5 to 8 s for a
    # sentence, with the same corrections (tested 31.10.2026; both test sets re-run with it)
    effort = "minimal" if mode == "grammar" else "low"
    result, meta = ask(p, prompts.correct_messages(text, level, mode, spoken), Correction, effort=effort)
    return {"result": result.model_dump(), "checks": verify(text, result, mode), "meta": meta}


def _data_url(image: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(image).decode()}"


def read_image(p: Provider, image: bytes, mime: str) -> dict:
    # upright and at most 2048 px, as for locate: cost grows with resolution (dev.meta.ai/docs/image-understanding)
    url = _jpeg_url(_upright(image))
    messages = [
        {"role": "system", "content": prompts.READ_SYSTEM},
        {"role": "user", "content": [
            {"type": "text", "text": "Transcribe this handwritten German text."},
            {"type": "image_url", "image_url": {"url": url}},
        ]},
    ]
    # low reasoning: 5.5 s instead of 18.6 s on a real notebook page, same text (tested 01.11.2026)
    result, meta = ask(p, messages, Reading, effort="low")
    return {"result": result.model_dump(), "meta": meta}


def _upright(image: bytes, max_side: int = 2048) -> Image.Image:
    """The photo as the learner sees it: EXIF rotation applied, at most max_side pixels."""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(image))).convert("RGB")
    img.thumbnail((max_side, max_side))
    return img


def _jpeg_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return _data_url(buf.getvalue(), "image/jpeg")


def _valid(box: list[int]) -> bool:
    return len(box) == 4 and box[2] > box[0] and box[3] > box[1]


def context_for(text: str, original: str, width: int = 60) -> str:
    """The words around `original` in the learner's text, so the model finds the right copy."""
    i = text.find(original)
    if i < 0:
        return ""
    line_start = text.rfind("\n", 0, i) + 1
    line_end = text.find("\n", i)
    line = text[line_start:line_end if line_end >= 0 else len(text)]
    return line if len(line) <= width * 2 else text[max(0, i - width):i + len(original) + width]


def locate(p: Provider, image: bytes, mime: str, originals: list[str], text: str = "") -> dict:
    """Red pen: Muse Spark's perception grounding finds each wrong word on the photo.

    Two things made the boxes land on a real notebook photo (31.10.2026): the photo is sent
    upright as the learner sees it, and each word comes with its line from the learner's text,
    so the model picks the right copy of a word like "zeit". A zoomed second pass was tried and
    made the boxes worse, so there is none.
    """
    img = _upright(image)
    contexts = [context_for(text, o) for o in originals]
    result, meta = ask(p, prompts.mark_messages(_jpeg_url(img), originals, contexts), Marks)
    marks = []
    for m in result.marks:
        box = [min(1000, max(0, v)) for v in m.box[:4]]
        ok = m.found and _valid(box) and 1 <= m.edit <= len(originals)
        marks.append({"edit": m.edit, "found": ok, "box": box if ok else None})
    return {"result": {"marks": marks}, "meta": meta}


def partner(p: Provider, scene: dict, level: str, history: list[dict]) -> dict:
    # minimal reasoning: 2-3 s a turn instead of about 5, with replies as good (tested 31.10.2026)
    result, meta = ask(p, prompts.partner_messages(scene, level, history), PartnerTurn, effort="minimal")
    n = len(scene["goals"])
    result.goals_done = sorted({g for g in result.goals_done if 1 <= g <= n})
    return {"result": result.model_dump(), "meta": meta}


def transcribe(wav: bytes, keywords: list[str] | None = None) -> dict:
    """Muse Voice Transcribe, file mode (dev.meta.ai/docs/speech-to-text). Only on the Model API."""
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        raise RuntimeError("Speech needs MODEL_API_KEY: Muse Voice Transcribe runs only on the Meta Model API.")
    request = {"mode": "PUSH_TO_TALK", "model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV",
               "languageBias": ["German"]}
    if keywords:
        # Vocabulary biasing (dev.meta.ai/docs/speech-to-text): the scene's words help with
        # short phrases like "drei Brötchen" that are easy to mishear.
        request["keywords"] = keywords[:40]
    started = time.perf_counter()
    files = {"request": (None, json.dumps(request), "application/json"), "audio": ("speech.wav", wav, "audio/wav")}
    for attempt in range(3):
        # 429 and 5xx: retry with backoff (dev.meta.ai/docs/speech-to-text)
        r = _http.post("https://api.meta.ai/v1/asr/transcribe", headers={"Authorization": f"Bearer {key}"},
                       files=files)
        if r.status_code not in (429, 500, 502, 503) or attempt == 2:
            break
        time.sleep(0.5 * (attempt + 1) + random.random() * 0.3)
    r.raise_for_status()
    d = r.json()
    text = re.sub(r"([.!?])\1+$", r"\1", (d.get("transcript") or "").strip())
    return {"text": text, "audio_ms": d.get("audioDurationMs"),
            "ms": round((time.perf_counter() - started) * 1000), "model": "muse-voice-transcribe-1.0"}


def picture(p: Provider, description: str) -> bytes:
    """One picture from Muse Image (dev.meta.ai/docs/image-generation, $0.01 each).

    The style and the no-text rule are the same for every picture Vogi draws: a Talk scene,
    or the idea of a lesson step.
    """
    prompt = f"A warm, friendly flat illustration. {description} Soft colours, simple shapes, calm mood. No text, no letters, no words on signs."
    r = client(p).images.generate(model="muse-image-1.0", prompt=prompt, n=1, size="1792x1024",
                                  response_format="b64_json", extra_body={"output_format": "webp"})
    return base64.b64decode(r.data[0].b64_json)


def scene_image(p: Provider, scene: dict) -> bytes:
    """A picture of the Talk scene (the built-in and the learner's own scenes)."""
    return picture(p, f"An everyday scene in Germany, seen from the point of view of the person who walks in. "
                      f"Scene: {scene['setting']} The other person: {scene['partner']}")


def make_scene(p: Provider, description: str, level: str) -> dict:
    result, meta = ask(p, prompts.scene_messages(description, level), Scene, effort="low")
    scene = result.model_dump()
    scene["words"] = [w[:40] for w in scene["words"]][:14]
    scene["goals"] = [g[:150] for g in scene["goals"]][:4]
    return {"result": scene, "meta": meta}


def thumbnail(image: bytes) -> str:
    """A small picture as a data URL the browser keeps (about 40 kB)."""
    im = Image.open(io.BytesIO(image))
    im.thumbnail((768, 768))
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=70)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()


def scene_thumbnail(p: Provider, scene: dict) -> str:
    return thumbnail(scene_image(p, scene))


def lesson_picture(p: Provider, description: str) -> str:
    """A picture for a lesson step, as a small data URL."""
    return thumbnail(picture(p, description))


def exercises(p: Provider, level: str, edits: list[dict]) -> dict:
    result, meta = ask(p, prompts.exercise_messages(level, edits), Exercises, effort="low")
    return {"result": result.model_dump(), "meta": meta}


def _norm(s: str) -> str:
    return re.sub(r"[\s.!?,;:]+", " ", s).strip()


def check_answer(p: Provider, exercise: dict, answer: str) -> dict:
    if _norm(answer) == _norm(exercise["answer"]):
        return {"correct": True, "feedback": "Right!", "judged_by": "exact match"}
    if exercise["type"] in ("fill_gap", "choose"):
        return {"correct": False, "feedback": f"Not quite. The answer is: {exercise['answer']}",
                "judged_by": "exact match"}
    verdict, _ = ask(p, prompts.judge_messages(exercise, answer), Verdict, effort="minimal")
    out = verdict.model_dump()
    if not out["correct"] and _spoils(out["feedback"], exercise["answer"], answer, any_word=True):
        # The learner tries again, so feedback must not hand over the fix.
        out["feedback"] = "Not yet. Read the hint again and try once more."
    return {**out, "judged_by": p.model}


def _spoils(text: str, fix: str, before: str = "", any_word: bool = False) -> bool:
    """True if `text` gives away the new words of `fix` (words not already in `before`).

    any_word: one new word is enough (the judge's second hint). Without it, all new words must
    appear: the scorer's count of hints, where "der, die or das?" is a fair choice question.
    """
    new = {w.lower() for w in _words(fix) if w.isalpha()} - {w.lower() for w in _words(before)}
    said = {w.lower() for w in _words(text)}
    if not new:
        return False
    return bool(new & said) if any_word else new <= said


def _words(s: str) -> list[str]:
    return re.findall(r"\w+|[^\w\s]", s)


def verify(text: str, c: Correction, mode: str) -> dict:
    """Vogi checks the model's answer against the learner's text before showing it.

    - grounded: the edit's `original` really is in the learner's text.
    - applied: the edit's `replacement` really is in corrected_text.
    - unexplained: words changed in corrected_text that no edit explains.
    """
    flat_in, flat_out = " ".join(text.split()), " ".join(c.corrected_text.split())
    per_edit = []
    for e in c.edits:
        per_edit.append({
            "grounded": " ".join(e.original.split()) in flat_in,
            "applied": " ".join(e.replacement.split()) in flat_out or e.replacement == "",
        })
    a, b = _words(text), _words(c.corrected_text)
    sm = SequenceMatcher(a=a, b=b, autojunk=False)
    changed = [op for op in sm.get_opcodes() if op[0] != "equal"]
    explained_words = {w for e in c.edits for w in _words(e.original) + _words(e.replacement)}
    unexplained = []
    for tag, i1, i2, j1, j2 in changed:
        span = a[i1:i2] + b[j1:j2]
        if not any(w in explained_words for w in span):
            unexplained.append(" ".join(b[j1:j2]) or " ".join(a[i1:i2]))
    change_ratio = 1 - sm.ratio()
    warnings = []
    if not all(x["grounded"] for x in per_edit):
        warnings.append("Some changes point at words that are not in your text.")
    if unexplained:
        warnings.append("Some words changed without an explanation: " + ", ".join(unexplained[:3]))
    if mode == "grammar" and change_ratio > 0.4:
        warnings.append("Grammar mode changed a lot of the text. Read it carefully.")
    if not c.edits and c.corrected_text.strip() != text.strip():
        warnings.append("The text changed, but no change was explained.")
    return {
        "edits": per_edit,
        "grounded": sum(x["grounded"] for x in per_edit),
        "total": len(per_edit),
        "unexplained": unexplained,
        "change_ratio": round(change_ratio, 3),
        "warnings": warnings,
    }


# Learn something. The plan and each answer come from the model; Vogi checks them with code first.
LESSON_MAX_STEPS = 8    # the plan
LESSON_MAX_PICTURES = 2  # per lesson
QTYPES = ("fill_gap", "choose", "fix_sentence", "write", "speak", "photo")


def _blank() -> dict:
    return {"kind": "", "text": "", "examples": [], "picture": "", "qtype": "", "prompt": "", "options": [],
            "answer": "", "hint": "", "rule": "", "category": ""}


def clean_steps(steps: list[dict], limit: int) -> list[dict]:
    """Keep the well-formed steps, each with only the fields its kind uses (the rest stay "" or [])."""
    out = []
    for s in steps:
        if s["kind"] == "explain":
            text = s["text"].strip()[:400]
            examples = [x.strip()[:200] for x in s["examples"] if x.strip()][:3]
            if not text and not examples:
                continue
            out.append({**_blank(), "kind": "explain", "text": text, "examples": examples,
                        "picture": s["picture"].strip()[:300], "rule": s["rule"].strip()[:250],
                        "category": s["category"]})
            continue
        prompt, answer, qtype = s["prompt"].strip()[:300], s["answer"].strip()[:300], s["qtype"]
        if qtype not in QTYPES or not prompt or not answer:
            continue
        options = [o.strip()[:80] for o in s["options"] if o.strip()][:4] if qtype == "choose" else []
        if qtype == "choose" and (len(options) < 2 or _norm(answer) not in [_norm(o) for o in options]):
            continue
        hint = s["hint"].strip()[:200]
        # The hint is the first nudge the learner sees: it must not hand over the answer. Naming one word of a
        # longer answer ("mit" in "mit meinem Bruder") is still a fair hint, so all new words must appear.
        if not hint or _spoils(hint, answer, prompt):
            hint = "Think about the rule."
        out.append({**_blank(), "kind": "question", "text": s["text"].strip()[:300] or "Answer the question.",
                    "qtype": qtype, "prompt": prompt, "options": options, "answer": answer, "hint": hint,
                    "rule": s["rule"].strip()[:250], "category": s["category"]})
    return out[:limit]


def _guard_explains(steps: list[dict]) -> list[dict]:
    """An explanation must not give away the answer of a question that comes after it.

    Examples that do are dropped; an explanation whose text gives it away is dropped as a whole.
    """
    out = []
    for i, s in enumerate(steps):
        if s["kind"] == "explain":
            later = [t["answer"] for t in steps[i + 1:] if t["kind"] == "question"]
            # all words of an answer must appear: one common word like "mit" does not give an answer away
            if any(_spoils(s["text"], a) for a in later):
                continue
            s = {**s, "examples": [x for x in s["examples"] if not any(_spoils(x, a) for a in later)]}
            if not s["text"] and not s["examples"]:
                continue
        out.append(s)
    return out


def guard_feedback(feedback: str, step: dict, answer: str) -> str:
    """The learner tries again, so a hint must not hand over the answer. A spoiling one becomes the step's own hint."""
    if _spoils(feedback, step["answer"], answer, any_word=True):
        return step["hint"] or "Not yet. Read the hint again and try once more."
    return feedback


LESSON_MIN_STEPS = 5  # fewer than this after the checks: one more try


def _plan(result: Lesson) -> list[dict]:
    return _guard_explains(clean_steps([s.model_dump() for s in result.steps], limit=LESSON_MAX_STEPS))


def lesson(p: Provider, topic: str, level: str, mistakes: list[dict]) -> dict:
    # low reasoning for the plan: the steps are short, and the spoiler checks below do the rest
    messages = prompts.lesson_messages(topic, level, mistakes)
    result, meta = ask(p, messages, Lesson, effort="low")
    steps = _plan(result)
    if len(steps) < LESSON_MIN_STEPS:
        # the explanations gave answers away, so the checks cut too many steps: the model writes it again
        result, again = ask(p, messages + [{"role": "user", "content": prompts.LESSON_RETRY}], Lesson, effort="low")
        if len(_plan(result)) > len(steps):
            steps = _plan(result)
        meta = {**again, "ms": meta["ms"] + again["ms"], "tokens_in": meta["tokens_in"] + again["tokens_in"],
                "tokens_out": meta["tokens_out"] + again["tokens_out"], "attempts": 2,
                "usd_estimate": round(meta["usd_estimate"] + again["usd_estimate"], 5) if again["usd_estimate"] else None}
    pictures = 0
    for s in steps:
        if s["picture"] and pictures < LESSON_MAX_PICTURES:
            pictures += 1
        else:
            s["picture"] = ""
    title = result.title.strip()[:80] or topic[:80]
    return {"result": {"title": title, "steps": steps}, "meta": meta}


def lesson_turn(p: Provider, title: str, level: str, step: dict, answer: str, tries: int, dont_know: bool,
                recent: list[str]) -> dict:
    """Check one answer. `tries` counts this attempt; from the second wrong one Vogi adds steps and the page reveals."""
    if not dont_know and _norm(answer) == _norm(step["answer"]):
        return {"result": {"correct": True, "feedback": "Right!", "add_steps": []}, "judged_by": "exact match",
                "meta": None}
    messages = prompts.lesson_turn_messages(title, level, step, answer, tries, dont_know, recent)
    turn, meta = ask(p, messages, LessonTurn, effort="minimal")
    correct = turn.correct and not dont_know
    feedback = turn.feedback.strip() or ("Right!" if correct else "Not yet. Read the hint again.")
    if not correct:
        feedback = guard_feedback(feedback, step, answer)
    remedial = dont_know or (not correct and tries >= 2)
    adds = _guard_explains(clean_steps([s.model_dump() for s in turn.add_steps], limit=3)) if remedial else []
    return {"result": {"correct": correct, "feedback": feedback, "add_steps": adds}, "judged_by": p.model,
            "meta": meta}
