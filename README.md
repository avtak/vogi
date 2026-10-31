# Vogi: a German writing and speaking coach on Meta's Muse models

Vogi corrects German writing for adult learners, and the learner never writes a prompt.
They type a text or photograph their handwritten homework. Then they pick their level
(A0 for complete beginners, then A1 to C2) and what they want: **grammar only**, **better words**
or **sound natural**.
Vogi answers in one fixed format. It shows the corrected text with every change marked.
Each change has a category and the rule behind it, at the learner's level. On a photo, Vogi marks each
mistake with a red pen, right on the handwriting. In **Talk**, the learner speaks with an AI
partner in an everyday scene, such as the bakery or the Bürgeramt. Afterwards they get the
same feedback on what they said. It remembers the learner's mistakes over time
and trains them on the ones they make most.

Built for the Meta Global AI Developer Hackathon (Indie track, "Build for Your World").

## Why

I learn German in Leipzig. A chatbot rewrites my text and I learn nothing, or I spend my
time on prompts like "only fix grammar, explain at A2, do not change my words". And it
forgets my mistakes the next day. Teachers have no time to correct every text.

Vogi works like a teacher's red pen, not a ghostwriter. By default it only marks where each
mistake is and gives a hint. The learner fixes it, Vogi checks the fix, and only then shows
the answer and the rule. It keeps a list of the learner's mistakes and builds
practice from the ones that keep coming back. The learner never writes a prompt.

## What was built during the hackathon (27.10.2026 to 04.11.2026)

Everything in this repository. It is a new codebase, started on 31.10.2026 (see the git
history). No code, data or prompts come from my earlier app, Sprachvogel.

| Part | File | What it does |
|---|---|---|
| Correction format | `vogi/schema.py` | Pydantic models that give both the strict JSON schema sent to the model and the check of the answer |
| Prompts by level and mode | `vogi/prompts.py` | The learner picks; Vogi writes the prompt |
| Model calls | `vogi/core.py` | Structured output with `response_format` json_schema; a fallback that puts the schema in the prompt for hosts that refuse it; one retry if the answer breaks the format |
| Try first | `vogi/static/vogi.js` `renderTry()` | The default: mistakes are marked with a hint that must not contain the fix; the learner's fix is checked by exact match first, and by the model as judge if it differs |
| Self-check | `vogi/core.py` `verify()` | Before the learner sees an answer, Vogi checks that each change points at words really in the text, and flags changes that have no explanation |
| Handwriting | `/api/read` | Muse Spark copies the handwritten text with its mistakes. The learner confirms the text before any correction |
| Red pen | `/api/locate` | Muse Spark's perception grounding returns a box (0-1000 grid) around each wrong word on the photo; the page draws the numbered marks |
| Talk | `vogi/scenes.py`, `/api/talk`, `/api/transcribe` | Five scenes with a mission. The partner (Muse Spark) stays in role at the learner's level and never corrects mid-talk; it tracks which mission goals are reached. The browser records the learner, converts the audio to 16 kHz WAV, and Muse Voice Transcribe writes it down. At the end, everything the learner said goes through try first |
| My mistakes | `vogi/static/vogi.js` | Each check saves its error categories in the learner's browser; "Practise my top 3" builds exercises from the most frequent ones |
| Practice | `/api/exercises`, `/api/check` | Three exercises from the learner's own mistakes; an exact-match check first, the model as judge only for rewritten sentences |
| Test set and score | `eval/` | 38 sentences with known errors (or none) and a scorer that runs the same set on any model |
| Web app | `vogi/static/` | One page, no build step, light and dark |

## Meta models used

| Model | Where | Used for |
|---|---|---|
| `muse-spark-1.3` | Meta Model API (`https://api.meta.ai/v1`) | Correction, reading handwriting, finding each wrong word on the photo, exercises, judging answers |
| `muse-voice-transcribe-1.0` | Meta Model API (`/v1/asr/transcribe`) | Writing down what the learner says in Talk, mistakes included |
| Muse Spark Open | Partner inference: Baseten (`meta-models/muse-spark-open-1026`), Fireworks, Together, or any OpenAI-compatible host | The same correction behind the same format, scored on the same test set. Baseten does not offer structured output for this model, so Vogi puts the schema in the prompt and validates the answer |

The partner's voice in Talk is the browser's built-in text-to-speech, because the Model API
has no text-to-speech model. It is not a Meta model.

Vogi uses Standard mode only. The Model API docs say content in Standard mode is not used
to train Meta models. Vogi never calls the `-contributor` model ids.

## Run it

Needs [uv](https://docs.astral.sh/uv/) and a Meta Model API key.

```bash
mkdir -p ~/.config/vogi && cp .env.example ~/.config/vogi/env && chmod 600 ~/.config/vogi/env
# put your key into ~/.config/vogi/env
uv run vogi                             # then open http://127.0.0.1:8790
uv run vogi-eval --provider meta        # score Muse Spark 1.3 on the test set
uv run vogi-eval --provider baseten     # score Muse Spark Open on the same set
uv run python -m tests.test_offline     # checks that need no key
```

Vogi reads keys only from the environment or from `~/.config/vogi/env`, outside the repo.
To try the page without a key, `tests/fake_host.py` serves canned answers. Its answers do not come from a model.

## How good is it?

`eval/README.md` explains the method, and `eval/results/` holds the runs. The app page
shows the same score table.

## What it is not

- It does not score pronunciation. Speech-to-text hides pronunciation errors, so Vogi does not claim it.
- Speech recognition can mishear. In a test with synthetic speech, Muse Voice Transcribe kept the grammar mistakes in 2 of 3 sentences and misheard one word in the third.
- The test set is small, and no native-speaker teacher has reviewed it yet. It shows how the models compare. It does not prove that a model is accurate.
- Vogi is not a chat. It has no free-text conversation.
- The test set covers A1 to B1. Corrections at B2 to C2 are not scored yet.
- "My mistakes" lives in one browser. There are no accounts.

## Next

Vogi will become the writing part of my language app Sprachvogel, with the mistake list
synced to the learner's account. The correction format (`docs/SCHEMA.md`) has a version,
so the app can call the same format.

## Built with

Python, FastAPI and the OpenAI Python SDK (the Model API is OpenAI-compatible). I wrote the
code with an AI coding assistant (Claude Code) and reviewed it.

## Licence

MIT, see `LICENSE`.
