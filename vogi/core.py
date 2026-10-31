"""Calls to the model, and Vogi's own check of every answer."""

from __future__ import annotations

import base64
import json
import re
import time
from difflib import SequenceMatcher
from typing import TypeVar

import openai
from pydantic import BaseModel, ValidationError

from . import prompts
from .providers import Provider, client
from .schema import Correction, Exercises, Marks, Reading, Verdict, json_schema

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


def correct(p: Provider, text: str, level: str, mode: str) -> dict:
    result, meta = ask(p, prompts.correct_messages(text, level, mode), Correction)
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


def locate(p: Provider, image: bytes, mime: str, originals: list[str]) -> dict:
    """Red pen: Muse Spark's perception grounding finds each wrong word on the photo."""
    result, meta = ask(p, prompts.mark_messages(_data_url(image, mime), originals), Marks)
    marks = []
    for m in result.marks:
        box = [min(1000, max(0, v)) for v in m.box[:4]]
        ok = m.found and len(box) == 4 and box[2] > box[0] and box[3] > box[1] and 1 <= m.edit <= len(originals)
        marks.append({"edit": m.edit, "found": ok, "box": box if ok else None})
    return {"result": {"marks": marks}, "meta": meta}


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
