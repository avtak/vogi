"""A fake OpenAI-compatible host with canned answers, so the app can be tested without a key or credits.

Run:  uv run uvicorn tests.fake_host:app --port 8799
Then: VOGI_CUSTOM_BASE_URL=http://127.0.0.1:8799/v1 VOGI_CUSTOM_MODEL=fake VOGI_CUSTOM_LABEL="Fake host (tests only)" uv run vogi
Never use it in the demo video: its answers are not from a model.
"""

import json
import time

from fastapi import FastAPI, Request

app = FastAPI()

CANNED = {
    "Correction": {
        "corrected_text": "Gestern habe ich mit meinem Bruder Fußball gespielt.",
        "edits": [
            {"original": "ich habe", "replacement": "habe ich", "category": "verb_position", "severity": "error",
             "hint": "Where does the verb go after 'Gestern'?",
             "rule": "In a main clause the verb is in position 2, so after 'Gestern' comes 'habe'."},
            {"original": "mein Bruder", "replacement": "meinem Bruder", "category": "case", "severity": "error",
             "hint": "Which case comes after 'mit'?",
             "rule": "'mit' always takes the dative: der Bruder becomes meinem Bruder."},
        ],
        "summary": "Good sentence! Practise verb position 2 and the dative after 'mit'.",
    },
    "Reading": {"text": "Gestern ich habe mit mein Bruder Fußball gespielt.", "unclear_words": ["Bruder"]},
    "Exercises": {"exercises": [
        {"type": "fill_gap", "instruction": "Write the missing word.", "prompt": "Ich fahre mit ___ Schwester nach Berlin. (meine)",
         "options": [], "answer": "meiner", "category": "case", "hint": "'mit' takes the dative."},
        {"type": "choose", "instruction": "Choose the right word order.", "prompt": "Heute ___ Pizza.",
         "options": ["ich esse", "esse ich", "essen ich"], "answer": "esse ich", "category": "verb_position",
         "hint": "The verb is in position 2."},
        {"type": "fix_sentence", "instruction": "Correct the sentence.", "prompt": "Am Montag ich gehe zum Kurs.",
         "options": [], "answer": "Am Montag gehe ich zum Kurs.", "category": "verb_position",
         "hint": "What comes after 'Am Montag'?"},
    ]},
    "Marks": {"marks": [
        {"edit": 1, "found": True, "box": [180, 120, 420, 230]},
        {"edit": 2, "found": True, "box": [520, 120, 760, 230]},
    ]},
    "Verdict": {"correct": True, "feedback": "Yes, the verb is now in position 2."},
}


@app.post("/v1/chat/completions")
async def chat(req: Request):
    body = await req.json()
    name = (body.get("response_format") or {}).get("json_schema", {}).get("name", "Correction")
    return {
        "id": "fake", "object": "chat.completion", "created": int(time.time()), "model": body["model"],
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": json.dumps(CANNED[name], ensure_ascii=False)}}],
        "usage": {"prompt_tokens": 400, "completion_tokens": 150, "total_tokens": 550},
    }
