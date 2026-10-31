# Vogi correction format, version `vogi-correction/2`

Any app can ask a model for this format and show it the same way. The source of truth is
`vogi/schema.py`. To print the JSON schema:

```bash
uv run python -c "import json; from vogi.schema import Correction, json_schema; print(json.dumps(json_schema(Correction), indent=2))"
```

## Request

| Field | Values |
|---|---|
| `text` | The learner's German text, at most 1,500 characters |
| `level` | `A0` (new to German), `A1`, `A2`, `B1`, `B2`, `C1`, `C2` |
| `mode` | `grammar` (fix errors only), `words` (also better words), `natural` (also sound like a native speaker) |

`POST /api/correct` with that JSON body.

## Answer

```json
{
  "result": {
    "corrected_text": "Gestern habe ich mit meinem Bruder Fußball gespielt.",
    "edits": [
      {"original": "ich habe", "replacement": "habe ich", "category": "verb_position",
       "severity": "error", "hint": "Where does the verb go after 'Gestern'?",
       "rule": "In a main clause the verb is in position 2."}
    ],
    "summary": "Practise verb position 2."
  },
  "checks": {"grounded": 1, "total": 1, "unexplained": [], "change_ratio": 0.2, "warnings": []},
  "meta": {"model": "muse-spark-1.3", "ms": 2100, "tokens_in": 600, "tokens_out": 180}
}
```

- `hint`: a nudge towards the rule that never contains the new words, for "try first". Added in version 2.
- `severity`: `error` means the text was wrong; `style` means it was correct but sounds better changed.
- `category`: one of `verb_position`, `verb_form`, `auxiliary`, `case`, `gender`, `adjective_ending`,
  `preposition`, `plural`, `spelling`, `capitalisation`, `punctuation`, `word_choice`, `register`, `idiom`,
  `style`, `other`.
- `checks` comes from Vogi's own code, not from the model.

A breaking change gets a new version name.
