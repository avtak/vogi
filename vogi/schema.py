"""The fixed answer formats. One source: these Pydantic models.

The same models give the JSON schema sent to the model and validate what comes back.
`docs/SCHEMA.md` describes the correction format for other apps.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Level = Literal["A0", "A1", "A2", "B1", "B2", "C1", "C2"]
Mode = Literal["grammar", "words", "natural"]

Category = Literal[
    "verb_position",   # V2, verb at the end in a side clause
    "verb_form",       # conjugation, Partizip
    "auxiliary",       # haben or sein in the Perfekt
    "case",            # Nominativ, Akkusativ, Dativ, Genitiv
    "gender",          # der, die, das
    "adjective_ending",
    "preposition",
    "plural",
    "spelling",
    "capitalisation",
    "punctuation",
    "word_choice",
    "register",        # formal or informal, Sie or du, written or spoken
    "idiom",
    "style",
    "other",
]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Edit(Strict):
    original: str = Field(description="The exact words from the learner's text that change. 1 to 5 words.")
    replacement: str = Field(description="The new words, exactly as they appear in corrected_text.")
    category: Category
    severity: Literal["error", "style"] = Field(
        description="error: the text was wrong. style: it was correct, but this sounds better."
    )
    hint: str = Field(
        description="A short question or nudge that points at the rule WITHOUT giving the new words."
    )
    rule: str = Field(description="One short sentence in simple English: the rule behind this change.")


class Correction(Strict):
    corrected_text: str = Field(description="The learner's whole text with every edit applied.")
    edits: list[Edit] = Field(description="One entry per change, in text order. Empty if nothing changes.")
    summary: str = Field(description="One encouraging sentence in simple English: what to practise next.")
    level_estimate: Level = Field(
        description="The CEFR level this text shows, judged by the range of grammar and words used, not by the number of mistakes."
    )


class Reading(Strict):
    text: str = Field(description="The handwritten German text exactly as written, mistakes included.")
    unclear_words: list[str] = Field(description="Words that were hard to read. Empty if all were clear.")


class Exercise(Strict):
    type: Literal["fill_gap", "choose", "fix_sentence"]
    instruction: str = Field(description="What to do, in simple English.")
    prompt: str = Field(description="The German task. fill_gap and choose use ___ for the gap.")
    options: list[str] = Field(description="For choose: 3 options. Otherwise empty.")
    answer: str = Field(description="The correct answer: the gap word(s), the option, or the fixed sentence.")
    category: Category
    hint: str = Field(description="A short hint in simple English.")


class Exercises(Strict):
    exercises: list[Exercise]


class Mark(Strict):
    edit: int = Field(description="The number of the edit, starting at 1.")
    found: bool = Field(description="false if the words cannot be found in the photo.")
    box: list[int] = Field(description="[x_min, y_min, x_max, y_max] on a 0-1000 grid of the image. [0,0,0,0] if not found.")


class Marks(Strict):
    marks: list[Mark]


class PartnerTurn(Strict):
    reply: str = Field(description="The partner's next line, in German, in role.")
    goals_done: list[int] = Field(description="Numbers (from 1) of the mission goals the learner has reached so far.")
    finished: bool = Field(description="true when the conversation has come to a natural end.")


class Verdict(Strict):
    correct: bool
    feedback: str = Field(description="One short sentence in simple English.")


def json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Schema with $refs inlined and titles removed, ready for response_format strict mode."""
    raw = model.model_json_schema()
    defs = raw.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(defs[node["$ref"].split("/")[-1]])
            return {k: walk(v) for k, v in node.items() if k != "title"}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(raw)
