# Vogi: a German writing and speaking coach on Meta's Muse models

Vogi helps adults in Germany learn to write and speak German, from the first week (A1.1) to C2.
It works like a teacher's red pen, not a ghostwriter. It marks where each mistake is and gives a
hint. The learner fixes it, and only then does Vogi show the answer and the rule. It remembers the
learner's mistakes and trains them on the ones that keep coming back. The learner never writes a prompt.

**Live demo:** https://avtak-vogi.hf.space (the access code is in the hackathon submission).

Built for the Meta Global AI Developer Hackathon (Indie track, "Build for Your World").

## Why

I learn German in Leipzig. A chatbot rewrites my text and I learn nothing, or I spend my time on
prompts like "only fix grammar, explain at A2, do not change my words". And it forgets my mistakes
the next day. Teachers have no time to correct every text, and many integration courses still
work on paper.

## How a learner uses it

1. **Once:** "How much German do you know?" A slider over the course steps used in Germany
   (A1.1, A1.2 ... B2.2, C1, C2), each with a plain description. Vogi also estimates the level of
   every text and suggests a change when three texts in a row differ.
2. **Check my writing:** type a text, or photograph handwritten homework. Vogi first shows what it
   read, and the learner confirms it. Then Vogi marks each mistake with a hint, and the learner
   fixes them one by one. On a photo, Vogi highlights the mistakes on the page itself.
3. **Practise speaking:** a hands-free role-play with a small mission. The scenes are everyday:
   the bakery, calling in sick, the neighbour, the doctor, the Bürgeramt. The words appear while
   the learner speaks, and the partner answers at their level, with "words you can use" under
   each line. At the end, everything the learner said gets the same try-first feedback.
4. **My progress:** the learner's most frequent mistakes, "Practise my top 3", and every checked
   homework page with its marks. All of it stays in the learner's browser.

Technical details (model, cost, Vogi's self-check, the score table) sit in "How Vogi works" at the
bottom of the page.

## What was built during the hackathon (27.10.2026 to 04.11.2026)

Everything in this repository. It is a new codebase, started on 31.10.2026 (see the git history),
built with an AI coding assistant and tested by me. No code, data or prompts come from my earlier
language app, Sprachvogel.

| Part | Where | What it does |
|---|---|---|
| Answer format | `vogi/schema.py` | Pydantic models give both the strict JSON schema sent to the model and the check of its answer |
| Prompts | `vogi/prompts.py` | Level and goal become the prompt: grammar only, better words, or sound natural |
| Model calls | `vogi/core.py` | Structured output (`response_format` json_schema), a schema-in-prompt fallback for hosts without it, one retry if an answer breaks the format |
| Self-check | `vogi/core.py` `verify()` | Before the learner sees an answer, code checks that each change points at words really in the text and flags changes with no explanation |
| Try first | `vogi/static/vogi.js` | Each mistake comes with a hint that must not contain the fix. The learner's fix is checked by exact match first, then by the model as judge |
| Handwriting | `/api/read` | Muse Spark copies the handwritten text with its mistakes; the learner confirms it before any correction |
| Red pen | `/api/locate` | Muse Spark's perception grounding boxes each wrong word on the photo (0-1000 grid). The photo is sent upright, and each word comes with its line, so the right copy of a repeated word is found |
| Level estimate | `level_estimate` in every correction | The CEFR level a text shows, by range of grammar and words, not by the number of mistakes |
| Talk | `vogi/scenes.py`, `/api/talk`, `/api/live` | The page streams the microphone (24 kHz PCM) to Vogi's server, which relays it to Muse Voice Transcribe's realtime socket, so the API key never reaches the browser. Endpointing marks the end of each sentence, and a short pause to think joins the same line. The partner runs at `reasoning_effort="minimal"` (about 2 s a turn) and never corrects mid-talk |
| Memory | `vogi/static/vogi.js` | Mistakes and checked pages are kept in the browser (localStorage, IndexedDB). No accounts, no server storage |
| Test set and score | `eval/` | 56 German sentences with known errors (or none) and a scorer that runs the same set on any model |
| Hosting | `Dockerfile`, `docs/DEPLOY.md` | An access code and per-visitor and daily limits protect the credits on the public demo |

## Meta models used

| Model | Where | Used for |
|---|---|---|
| `muse-spark-1.3` | Meta Model API | Correction, reading handwriting, locating mistakes on the photo, level estimate, exercises, judging answers, the role-play partner |
| `muse-voice-transcribe-1.0` | Meta Model API (realtime socket; file upload as fallback) | Writing down what the learner says, mistakes included |
| Muse Spark Open | Partner hosts (Baseten, Fireworks, Together) | The same correction behind the same format, ready to score on the same test set once a partner key is available |

The partner's voice in Talk is the browser's built-in text-to-speech, because the Model API has no
text-to-speech model. Vogi uses Standard mode only: the Model API docs say content in Standard mode
is not used to train Meta models.

## How good is it?

| Test set | Model | Errors fixed | Correct sentences left alone |
|---|---|---|---|
| basic, 38 sentences (A1 to B1) | `muse-spark-1.3` | 28 of 28 | 11 of 11 |
| hard, 18 texts (several errors per text, B2 and C1 errors, correct sentences that look wrong) | `muse-spark-1.3` | 14 of 14 | 7 of 7 |

With `reasoning_effort="minimal"` a check takes about 1.5 s on average (5 s at the model's default),
with the same scores. Try first needs hints that do not give the answer. The scorer counts hints
that contain the fix: 1 of 42, and that one is a fair choice question ("der, die or das?").

The sets show that Muse Spark fixes sentence-level errors and leaves correct German alone. They are
small and do not yet separate models. `eval/README.md` explains the method and its limits.

## Run it

Needs [uv](https://docs.astral.sh/uv/) and a Meta Model API key.

```bash
mkdir -p ~/.config/vogi && cp .env.example ~/.config/vogi/env && chmod 600 ~/.config/vogi/env
# put your key into ~/.config/vogi/env
uv run vogi                               # then open http://127.0.0.1:8790
uv run vogi-eval --provider meta          # score Muse Spark on the basic set
uv run vogi-eval --provider meta --set hard
uv run python -m tests.test_offline       # checks that need no key
```

Vogi reads keys only from the environment or from `~/.config/vogi/env`, outside the repo. To try
the page without a key, `tests/fake_host.py` serves canned answers that do not come from a model.

## What it is not

- It does not score pronunciation. Speech-to-text hides pronunciation errors, so Vogi does not claim it.
- Speech recognition can mishear. The learner can fix any line before the feedback.
- No native-speaker teacher has reviewed the test sets yet.
- Vogi is not a chat. It has no free-text conversation outside the scenes.

## Next

Vogi's ideas will move into my language app Sprachvogel: the try-first corrections, the red pen
and Talk. There the mistake list will sync to the learner's account. `docs/SCHEMA.md` describes the
answer format.

## Built with

Python, FastAPI and the OpenAI Python SDK (the Model API is OpenAI-compatible), plain HTML and
JavaScript with no build step. I built it with an AI coding assistant and tested every feature myself.

## Licence

MIT, see `LICENSE`.
