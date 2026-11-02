"""Vogi's local web app: `uv run vogi`, then open http://127.0.0.1:8790."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import tempfile
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Literal

import httpx
import openai
import websockets
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import core, providers, scenes
from .schema import Edit, Exercise, Level, Mode, Step

STATIC = Path(__file__).parent / "static"
RESULTS = Path(__file__).parent.parent / "eval" / "results"
MAX_TEXT = 1500
MAX_IMAGE = 8_000_000
MAX_AUDIO = 60 * 24000 * 2 + 1000  # 60 s of 24 kHz mono 16-bit PCM
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

providers.load_env_file()
app = FastAPI(title="Vogi")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


# Hosted mode (a public Hugging Face Space): set VOGI_ACCESS_CODE. Then every /api call needs the
# code, and simple limits protect the key's credits. Without it (a laptop), nothing changes.
log = logging.getLogger("vogi")
ACCESS_CODE = os.environ.get("VOGI_ACCESS_CODE", "")
HOURLY_PER_VISITOR = int(os.environ.get("VOGI_HOURLY_LIMIT", "60"))
DAILY_TOTAL = int(os.environ.get("VOGI_DAILY_LIMIT", "400"))  # about $2 to $5 a day at most
MODEL_PATHS = {"/api/correct", "/api/read", "/api/locate", "/api/exercises", "/api/check", "/api/talk",
               "/api/transcribe", "/api/live", "/api/scene", "/api/scene-picture",
               "/api/lesson", "/api/lesson/answer", "/api/lesson/picture"}
_visits: dict[str, deque] = defaultdict(deque)
_day = {"date": "", "count": 0}
_tries: dict[str, deque] = defaultdict(deque)


def _visitor(headers, client) -> str:
    fwd = headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (client.host if client else "?")


def _code_ok(code: str | None) -> bool:
    return not ACCESS_CODE or hmac.compare_digest((code or "").encode(), ACCESS_CODE.encode())


def _over_limit(who: str) -> str | None:
    """One model call for this visitor. Returns a message if a limit is reached."""
    if not ACCESS_CODE:
        return None
    now, today = time.time(), time.strftime("%Y-%m-%d")
    if _day["date"] != today:
        _day.update(date=today, count=0)
    q = _visits[who]
    while q and now - q[0] > 3600:
        q.popleft()
    if len(q) >= HOURLY_PER_VISITOR:
        return "You reached the limit for this hour. Please try again later."
    if _day["count"] >= DAILY_TOTAL:
        return "Vogi reached its limit for today. Please try again tomorrow."
    q.append(now)
    _day["count"] += 1
    return None


@app.middleware("http")
async def gate(request: Request, call_next):
    path = request.url.path
    if ACCESS_CODE and path.startswith("/api/") and path != "/api/access":
        if not _code_ok(request.headers.get("x-vogi-code")):
            return JSONResponse({"detail": "access code needed"}, status_code=401)
        if path in MODEL_PATHS and request.method == "POST":
            msg = _over_limit(_visitor(request.headers, request.client))
            if msg:
                return JSONResponse({"detail": msg}, status_code=429)
    return await call_next(request)


class AccessIn(BaseModel):
    code: str = Field(max_length=200)


@app.post("/api/access")
def access(body: AccessIn, request: Request):
    who = _visitor(request.headers, request.client)
    q, now = _tries[who], time.time()
    while q and now - q[0] > 3600:
        q.popleft()
    if len(q) >= 10:
        raise HTTPException(429, "Too many tries. Please wait an hour.")
    q.append(now)
    if not _code_ok(body.code):
        raise HTTPException(401, "That code is not right.")
    return {"ok": True, "gated": bool(ACCESS_CODE)}


@app.middleware("http")
async def revalidate(request, call_next):
    """The page and its files change often during the event: browsers must check for a newer copy."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


class CorrectIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    level: Level = "A2"
    mode: Mode = "grammar"
    provider: str | None = None
    spoken: bool = False


class Turn(BaseModel):
    role: Literal["partner", "learner"]
    text: str = Field(max_length=600)


class SceneIn(BaseModel):
    """A learner's own scene, kept in their browser and sent with every turn."""
    title: str = Field(min_length=1, max_length=80)
    partner: str = Field(min_length=1, max_length=300)
    setting: str = Field(min_length=1, max_length=400)
    words: list[str] = Field(default_factory=list, max_length=20)
    goals: list[str] = Field(min_length=1, max_length=5)


class SceneAsk(BaseModel):
    description: str = Field(min_length=3, max_length=400)
    level: Level = "A2"
    provider: str | None = None


class PictureIn(BaseModel):
    scene: SceneIn


class TalkIn(BaseModel):
    scene: str = ""
    custom: SceneIn | None = None
    level: Level = "A2"
    history: list[Turn] = Field(default_factory=list, max_length=30)
    provider: str | None = None


class ExercisesIn(BaseModel):
    level: Level = "A2"
    edits: list[Edit] = Field(min_length=1, max_length=20)
    provider: str | None = None


class CheckIn(BaseModel):
    exercise: Exercise
    answer: str = Field(max_length=500)
    provider: str | None = None


class LessonMistake(BaseModel):
    """One of the learner's saved mistakes, sent with a lesson on "From my mistakes"."""
    original: str = Field(max_length=500)
    replacement: str = Field(max_length=500)
    category: str = Field(max_length=40)
    rule: str = Field(max_length=300)


class LessonIn(BaseModel):
    topic: str = Field(min_length=1, max_length=300)
    level: Level = "A2"
    mistakes: list[LessonMistake] = Field(default_factory=list, max_length=12)
    provider: str | None = None


class LessonAnswerIn(BaseModel):
    title: str = Field(max_length=120)
    level: Level = "A2"
    step: Step
    answer: str = Field(default="", max_length=500)
    tries: int = Field(default=1, ge=0, le=10)
    dont_know: bool = False
    recent: list[str] = Field(default_factory=list, max_length=6)
    provider: str | None = None


class LessonPictureIn(BaseModel):
    description: str = Field(min_length=3, max_length=300)


def _provider(pid: str | None) -> providers.Provider:
    try:
        return providers.get(pid)
    except (RuntimeError, KeyError) as e:
        raise HTTPException(400, str(e)) from e


def _run(fn, *args):
    try:
        return fn(*args)
    except openai.APIStatusError as e:
        body = e.body if isinstance(e.body, dict) else {}
        log.warning("model host %s: type=%s code=%s param=%s", e.status_code, body.get("type"),
                    body.get("code"), body.get("param"))
        if e.status_code in (429, 503):
            raise HTTPException(503, "The model is busy. Please try again in a moment.") from e
        if e.status_code == 400 and body.get("code") == "content_policy_violation":
            raise HTTPException(400, "The model refused this request.") from e
        raise HTTPException(502, f"The model host answered {e.status_code}.") from e
    except openai.APITimeoutError as e:
        log.warning("model host timeout")
        raise HTTPException(504, "The model took too long. Please try again.") from e
    except openai.APIConnectionError as e:
        log.warning("model host unreachable")
        raise HTTPException(502, "Could not reach the model host.") from e
    except ValidationError as e:
        log.warning("answer did not match the schema twice")
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
    return _run(core.correct, _provider(body.provider), body.text.strip(), body.level, body.mode, body.spoken)


@app.post("/api/read")
async def read(image: UploadFile = File(...), provider: str | None = Form(None)):
    if image.content_type not in IMAGE_TYPES:
        raise HTTPException(400, "Please send a JPEG, PNG, WebP or GIF photo.")
    data = await image.read()
    if len(data) > MAX_IMAGE:
        raise HTTPException(400, "The photo is larger than 8 MB.")
    return _run(core.read_image, _provider(provider), data, image.content_type)


@app.post("/api/locate")
async def locate(image: UploadFile = File(...), originals: str = Form(...), provider: str | None = Form(None),
                 text: str = Form("")):
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
    return _run(core.locate, _provider(provider), data, image.content_type, words, text[:MAX_TEXT])


@app.get("/api/scenes")
def list_scenes():
    return scenes.public()


SCENE_CACHE = Path(os.environ.get("VOGI_CACHE_DIR", tempfile.gettempdir())) / "vogi-scenes"
_scene_lock = threading.Lock()


BUNDLED_SCENES = STATIC / "scenes"  # made by Muse Image with core.scene_image on 31.10.2026
SCENES_URL = os.environ.get("VOGI_SCENES_URL", "https://raw.githubusercontent.com/avtak/vogi/main/vogi/static/scenes")


def _scene_picture(scene_id: str) -> Path:
    """One Muse Image picture per scene. The repo ships the five Vogi made, so a Space that wakes
    from sleep shows them at once; a new scene gets its picture made once and kept on disk."""
    bundled = BUNDLED_SCENES / f"{scene_id}.webp"
    if bundled.exists():
        return bundled
    path = SCENE_CACHE / f"{scene_id}.webp"
    with _scene_lock:
        if not path.exists():
            data = core.scene_image(providers.get("meta"), scenes.SCENES[scene_id])
            SCENE_CACHE.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    return path


@app.on_event("startup")
def _make_scene_pictures():
    """Make the pictures in the background after a start, so no learner waits about 11 s for one."""
    if not os.environ.get("MODEL_API_KEY") or os.environ.get("VOGI_SCENE_PICTURES") == "0":
        return

    def work():
        for sid in scenes.SCENES:
            if (BUNDLED_SCENES / f"{sid}.webp").exists() or (SCENE_CACHE / f"{sid}.webp").exists():
                continue
            # The Hugging Face Space repo takes no binary files, so a Space fetches the pictures from
            # the public GitHub repo (about 1 s) and only asks Muse Image if that fails.
            try:
                r = httpx.get(f"{SCENES_URL}/{sid}.webp", timeout=10)
                if r.status_code == 200 and r.content[:4] == b"RIFF":
                    SCENE_CACHE.mkdir(parents=True, exist_ok=True)
                    (SCENE_CACHE / f"{sid}.webp").write_bytes(r.content)
                    continue
            except httpx.HTTPError:
                pass
            try:
                _scene_picture(sid)
            except Exception as e:  # a missing picture must not stop the app
                log.warning("scene picture %s failed: %s", sid, type(e).__name__)

    threading.Thread(target=work, daemon=True).start()


@app.get("/api/scene-image/{scene_id}")
def scene_image(scene_id: str):
    if scene_id not in scenes.SCENES:
        raise HTTPException(404, "Unknown scene.")
    if not os.environ.get("MODEL_API_KEY"):
        raise HTTPException(404, "Scene pictures need the Meta Model API.")
    path = _run(_scene_picture, scene_id)
    return Response(path.read_bytes(), media_type="image/webp", headers={"Cache-Control": "max-age=86400"})


@app.post("/api/scene")
def make_scene(body: SceneAsk):
    return _run(core.make_scene, _provider(body.provider), body.description, body.level)


@app.post("/api/scene-picture")
def scene_picture(body: PictureIn):
    if not os.environ.get("MODEL_API_KEY"):
        raise HTTPException(404, "Scene pictures need the Meta Model API.")
    return {"image": _run(core.scene_thumbnail, providers.get("meta"), body.scene.model_dump())}


@app.post("/api/talk")
def talk(body: TalkIn):
    scene = body.custom.model_dump() if body.custom else scenes.SCENES.get(body.scene)
    if not scene:
        raise HTTPException(400, "Unknown scene.")
    history = [t.model_dump() for t in body.history]
    return _run(core.partner, _provider(body.provider), scene, body.level, history)


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...), keywords: str = Form("[]")):
    data = await audio.read()
    try:
        words = [str(w)[:40] for w in json.loads(keywords) if str(w).strip()][:40]
    except (ValueError, TypeError):
        words = []
    if len(data) > MAX_AUDIO or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise HTTPException(400, "Send a WAV recording of at most 60 seconds.")
    try:
        return core.transcribe(data, words)
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from e
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"Muse Voice Transcribe answered {e.response.status_code}.") from e
    except httpx.HTTPError as e:
        raise HTTPException(502, "Could not reach Muse Voice Transcribe.") from e


LIVE_URL = "wss://api.meta.ai/v1/asr/realtime"
LIVE_MAX_BYTES = 60 * 48000  # 60 s of 24 kHz 16-bit mono PCM


@app.websocket("/api/live")
async def live(ws: WebSocket):
    """Live speech-to-text. The browser streams 24 kHz PCM here, Vogi relays it to Muse Voice
    Transcribe's realtime socket (dev.meta.ai/docs/api-reference/voice/realtime) and sends the
    growing transcript back. The key never reaches the browser."""
    await ws.accept()
    if not _code_ok(ws.query_params.get("code")):
        await ws.send_json({"type": "error", "message": "access code needed"})
        await ws.close(code=1008)
        return
    limit = _over_limit(_visitor(ws.headers, ws.client))
    if limit:
        await ws.send_json({"type": "error", "message": limit})
        await ws.close(code=1008)
        return
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        await ws.send_json({"type": "error", "message": "Speech needs MODEL_API_KEY."})
        await ws.close()
        return
    try:
        cfg = json.loads(await asyncio.wait_for(ws.receive_text(), 10))
        words = [str(w)[:40] for w in cfg.get("keywords", []) if str(w).strip()][:40]
        # endpointing: Muse Voice Transcribe detects when the learner stops talking (hands-free Talk)
        mode = "ENDPOINTING" if cfg.get("mode") == "endpointing" else "PUSH_TO_TALK"
        # any: the learner describes their own scene in any language; the recogniser detects it
        any_language = cfg.get("lang") == "any"
    except (asyncio.TimeoutError, ValueError, TypeError, AttributeError, WebSocketDisconnect):
        await ws.close(code=1008)
        return
    handshake = {
        "authorization": {"accessToken": f"Bearer {key}"},
        "audioEncoding": "PCM_24KHZ", "model": "muse-voice-transcribe-1.0", "mode": mode,
        "emitAudioProgress": False,
    }
    if not any_language:
        handshake["languageBias"] = ["German"]
    if words:
        handshake["keywords"] = words
    try:
        async with websockets.connect(LIVE_URL, open_timeout=15, max_size=2**20) as up:
            await up.send(json.dumps(handshake))
            ack = json.loads(await asyncio.wait_for(up.recv(), 15))
            if "sessionId" not in ack:
                await ws.send_json({"type": "error", "message": "Muse Voice Transcribe refused the live session."})
                return
            await ws.send_json({"type": "ready"})

            async def downstream():
                async for msg in up:
                    if isinstance(msg, bytes):
                        continue
                    ev = json.loads(msg)
                    if ev.get("type") in ("transcript", "speechStart", "speechComplete", "error"):
                        await ws.send_json({k: ev.get(k) for k in ("type", "transcript", "final", "message")})

            down = asyncio.create_task(downstream())
            sent = 0
            try:
                while True:
                    m = await ws.receive()
                    if m["type"] == "websocket.disconnect":
                        down.cancel()
                        return
                    if m.get("bytes"):
                        sent += len(m["bytes"])
                        if sent > LIVE_MAX_BYTES:
                            break
                        await up.send(m["bytes"])
                    elif m.get("text"):
                        try:
                            if json.loads(m["text"]).get("type") == "endStream":
                                break
                        except (ValueError, AttributeError):
                            pass
                await up.send(json.dumps({"type": "endStream"}))
                await asyncio.wait_for(down, 20)
            except asyncio.TimeoutError:
                down.cancel()
    except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as e:
        try:
            await ws.send_json({"type": "error", "message": f"Live speech failed: {type(e).__name__}."})
        except (RuntimeError, WebSocketDisconnect):
            pass
    finally:
        try:
            await ws.close()
        except RuntimeError:
            pass


@app.post("/api/lesson")
def lesson(body: LessonIn):
    mistakes = [m.model_dump() for m in body.mistakes]
    out = _run(core.lesson, _provider(body.provider), body.topic.strip(), body.level, mistakes)
    if not out["result"]["steps"]:
        raise HTTPException(502, "Vogi could not write a lesson on this topic. Try another one.")
    return out


@app.post("/api/lesson/answer")
def lesson_answer(body: LessonAnswerIn):
    return _run(core.lesson_turn, _provider(body.provider), body.title.strip(), body.level, body.step.model_dump(),
                body.answer.strip(), body.tries, body.dont_know, [r[:120] for r in body.recent])


@app.post("/api/lesson/picture")
def lesson_picture(body: LessonPictureIn):
    if not os.environ.get("MODEL_API_KEY"):
        raise HTTPException(400, "Pictures need the Meta Model API.")
    return {"image": _run(core.lesson_picture, providers.get("meta"), body.description.strip())}


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
    host = os.environ.get("VOGI_HOST", "127.0.0.1")
    print(f"Vogi runs on http://{host}:{port}")
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
