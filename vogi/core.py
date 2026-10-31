"""Calls to the model, and Vogi's own check of every answer."""

from __future__ import annotations

import base64
import json
import os
import re
import time
import io
from difflib import SequenceMatcher
from typing import TypeVar

import httpx
import openai
from PIL import Image, ImageOps
from pydantic import BaseModel, ValidationError

from . import prompts
from .providers import Provider, client
from .schema import Correction, Exercises, Marks, PartnerTurn, Reading, Verdict, json_schema

T = TypeVar("T", bound=BaseModel)

# Standard-mode prices per 1M tokens for muse-spark-1.3 (dev.meta.ai/docs/pricing-rate-limits, 31.10.2026).
PRICE_IN, PRICE_OUT = 1.25, 4.25


def _strip_fences(s: str) -> str:
    s = s.strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", s, re.S)
    return m.group(1) if m else s


def ask(p: Provider, messages: list[dict], model: type[T]) -> tuple[T, dict]:
    """One structured call. Returns the validated object and usage facts."""
    schema = json_schema(model)
    fmt = {"type": "json_schema", "json_schema": {"name": model.__name__, "strict": True, "schema": schema}}
    started = time.perf_counter()
    mode = "native-schema"
    attempts = 0
    msgs = messages
    while True:
        attempts += 1
        try:
            kwargs = {"response_format": fmt} if (p.native_schema and mode == "native-schema") else {}
            resp = client(p).chat.completions.create(model=p.model, messages=msgs, **kwargs)
        except openai.BadRequestError:
            if mode != "native-schema":
                raise
            # The host does not take json_schema: put the schema in the prompt instead.
            mode = "schema-in-prompt"
            msgs = messages + [{"role": "user", "content": "Answer with JSON only, matching this schema:\n"
                                + json.dumps(schema)}]
            continue
        raw = resp.choices[0].message.content or ""
        try:
            obj = model.model_validate_json(_strip_fences(raw))
            break
        except ValidationError:
            if attempts >= 2:
                raise
            msgs = msgs + [{"role": "assistant", "content": raw},
                           {"role": "user", "content": "That did not match the schema. Return only the JSON object."}]
    u = resp.usage
    tin, tout = (u.prompt_tokens, u.completion_tokens) if u else (0, 0)
    return obj, {
        "provider": p.id, "model": p.model, "open_weight": p.open_weight, "format": mode,
        "attempts": attempts, "ms": round((time.perf_counter() - started) * 1000),
        "tokens_in": tin, "tokens_out": tout,
        "usd_estimate": round((tin * PRICE_IN + tout * PRICE_OUT) / 1e6, 5) if p.id == "meta" else None,
    }


def correct(p: Provider, text: str, level: str, mode: str, spoken: bool = False) -> dict:
    result, meta = ask(p, prompts.correct_messages(text, level, mode, spoken), Correction)
    return {"result": result.model_dump(), "checks": verify(text, result, mode), "meta": meta}


def _data_url(image: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(image).decode()}"


def read_image(p: Provider, image: bytes, mime: str) -> dict:
    url = _data_url(image, mime)
    messages = [
        {"role": "system", "content": prompts.READ_SYSTEM},
        {"role": "user", "content": [
            {"type": "text", "text": "Transcribe this handwritten German text."},
            {"type": "image_url", "image_url": {"url": url}},
        ]},
    ]
    result, meta = ask(p, messages, Reading)
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
    result, meta = ask(p, prompts.partner_messages(scene, level, history), PartnerTurn)
    n = len(scene["goals"])
    result.goals_done = sorted({g for g in result.goals_done if 1 <= g <= n})
    return {"result": result.model_dump(), "meta": meta}


def transcribe(wav: bytes) -> dict:
    """Muse Voice Transcribe, file mode (dev.meta.ai/docs/speech-to-text). Only on the Model API."""
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        raise RuntimeError("Speech needs MODEL_API_KEY: Muse Voice Transcribe runs only on the Meta Model API.")
    request = {"mode": "PUSH_TO_TALK", "model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV",
               "languageBias": ["German"]}
    started = time.perf_counter()
    r = httpx.post(
        "https://api.meta.ai/v1/asr/transcribe",
        headers={"Authorization": f"Bearer {key}"},
        files={"request": (None, json.dumps(request), "application/json"), "audio": ("speech.wav", wav, "audio/wav")},
        timeout=60,
    )
    r.raise_for_status()
    d = r.json()
    return {"text": (d.get("transcript") or "").strip(), "audio_ms": d.get("audioDurationMs"),
            "ms": round((time.perf_counter() - started) * 1000), "model": "muse-voice-transcribe-1.0"}


def exercises(p: Provider, level: str, edits: list[dict]) -> dict:
    result, meta = ask(p, prompts.exercise_messages(level, edits), Exercises)
    return {"result": result.model_dump(), "meta": meta}


def _norm(s: str) -> str:
    return re.sub(r"[\s.!?,;:]+", " ", s).strip()


def check_answer(p: Provider, exercise: dict, answer: str) -> dict:
    if _norm(answer) == _norm(exercise["answer"]):
        return {"correct": True, "feedback": "Right!", "judged_by": "exact match"}
    if exercise["type"] in ("fill_gap", "choose"):
        return {"correct": False, "feedback": f"Not quite. The answer is: {exercise['answer']}",
                "judged_by": "exact match"}
    verdict, _ = ask(p, prompts.judge_messages(exercise, answer), Verdict)
    return {**verdict.model_dump(), "judged_by": p.model}


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
