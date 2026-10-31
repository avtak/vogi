"""Vogi's local web app: `uv run vogi`, then open http://127.0.0.1:8790."""

from __future__ import annotations

import json
import os
from pathlib import Path

import openai
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import core, providers
from .schema import Edit, Exercise, Level, Mode

STATIC = Path(__file__).parent / "static"
RESULTS = Path(__file__).parent.parent / "eval" / "results"
MAX_TEXT = 1500
MAX_IMAGE = 8_000_000
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

providers.load_env_file()
app = FastAPI(title="Vogi")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class CorrectIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    level: Level = "A2"
    mode: Mode = "grammar"
    provider: str | None = None


class ExercisesIn(BaseModel):
    level: Level = "A2"
    edits: list[Edit] = Field(min_length=1, max_length=20)
    provider: str | None = None


class CheckIn(BaseModel):
    exercise: Exercise
    answer: str = Field(max_length=500)
    provider: str | None = None


def _provider(pid: str | None) -> providers.Provider:
    try:
        return providers.get(pid)
    except (RuntimeError, KeyError) as e:
        raise HTTPException(400, str(e)) from e


def _run(fn, *args):
    try:
        return fn(*args)
    except openai.APIStatusError as e:
        raise HTTPException(502, f"The model host answered {e.status_code}: {e.message}") from e
    except openai.APIConnectionError as e:
        raise HTTPException(502, "Could not reach the model host.") from e
    except ValidationError as e:
        raise HTTPException(502, "The model's answer did not match Vogi's format twice.") from e


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/providers")
def list_providers():
    return [
        {"id": p.id, "label": p.label, "model": p.model, "open_weight": p.open_weight}
        for p in providers.available()
    ]


@app.post("/api/correct")
def correct(body: CorrectIn):
    return _run(core.correct, _provider(body.provider), body.text.strip(), body.level, body.mode)


@app.post("/api/read")
async def read(image: UploadFile = File(...), provider: str | None = Form(None)):
    if image.content_type not in IMAGE_TYPES:
        raise HTTPException(400, "Please send a JPEG, PNG, WebP or GIF photo.")
    data = await image.read()
    if len(data) > MAX_IMAGE:
        raise HTTPException(400, "The photo is larger than 8 MB.")
    return _run(core.read_image, _provider(provider), data, image.content_type)


@app.post("/api/locate")
async def locate(image: UploadFile = File(...), originals: str = Form(...), provider: str | None = Form(None)):
    if image.content_type not in IMAGE_TYPES:
        raise HTTPException(400, "Please send a JPEG, PNG, WebP or GIF photo.")
    data = await image.read()
    if len(data) > MAX_IMAGE:
        raise HTTPException(400, "The photo is larger than 8 MB.")
    try:
        words = [str(w)[:80] for w in json.loads(originals)][:20]
    except (ValueError, TypeError) as e:
        raise HTTPException(400, "originals must be a JSON list of strings.") from e
    if not words:
        raise HTTPException(400, "Nothing to mark.")
    return _run(core.locate, _provider(provider), data, image.content_type, words)


@app.post("/api/exercises")
def make_exercises(body: ExercisesIn):
    edits = [e.model_dump() for e in body.edits]
    return _run(core.exercises, _provider(body.provider), body.level, edits)


@app.post("/api/check")
def check(body: CheckIn):
    return _run(core.check_answer, _provider(body.provider), body.exercise.model_dump(), body.answer)


@app.get("/api/results")
def results():
    """Summaries of the test-set runs in eval/results/, for the scoreboard."""
    out = []
    for f in sorted(RESULTS.glob("*.json")):
        if f.name.endswith(".raw.json") or "-limit" in f.name:
            continue
        out.append(json.loads(f.read_text())["summary"])
    return out


def main() -> None:
    import uvicorn

    port = int(os.environ.get("VOGI_PORT", "8790"))
    print(f"Vogi runs on http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
