"""The fixed answer formats. One source: these Pydantic models.

The same models give the JSON schema sent to the model and validate what comes back.
`docs/SCHEMA.md` describes the correction format for other apps.
"""

from __future__ import annotations

from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field

# The learner's level: the course steps used in Germany (A1.1 ... B2.2), then C1 and C2.
# The plain CEFR levels are still accepted. CefrLevel is what Vogi estimates from a text.
CefrLevel = Literal["A0", "A1", "A2", "B1", "B2", "C1", "C2"]
Level = Literal["A1.1", "A1.2", "A2.1", "A2.2", "B1.1", "B1.2", "B2.1", "B2.2",
                "A0", "A1", "A2", "B1", "B2", "C1", "C2"]
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
    level_estimate: CefrLevel = Field(
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
    help: list[str] = Field(
        description="2 to 4 short German building blocks the learner can use to answer this line, at their level. Never a full answer."
    )
    goals_done: list[int] = Field(description="Numbers (from 1) of the mission goals the learner has reached so far.")
    finished: bool = Field(description="true when the conversation has come to a natural end.")


# A Talk scene the learner described in their own words. Same fields as vogi/scenes.py.
class Scene(Strict):
    title: str = Field(description="A short English title, at most 6 words, e.g. 'Call the landlord'.")
    partner: str = Field(description="Who the learner talks to, in English: a made-up name, the role, and how they talk.")
    setting: str = Field(description="One English sentence: where and when, and what the learner wants.")
    words: list[str] = Field(description="8 to 12 German words or short phrases the learner will need.")
    goals: list[str] = Field(description="3 or 4 short mission goals in English, in the order of the talk.")


class Verdict(Strict):
    correct: bool
    feedback: str = Field(description="One short sentence in simple English.")


# Learn something: a short lesson the learner answers one step at a time. One Step model covers
# both kinds, so the schema stays flat: the fields a kind does not use are "" or [].
# The category of a step may also be "" (an explanation with no grammar point).
LessonCategory = Literal["", *get_args(Category)]
QType = Literal["fill_gap", "choose", "fix_sentence", "write", "speak", "photo"]


# One step of a lesson: an explanation, or one question.
class Step(Strict):
    kind: Literal["explain", "question"] = Field(
        description="explain: teaches one point. question: one task for the learner."
    )
    text: str = Field(
        description="explain: 1 to 3 short sentences that explain the point, at the learner's level, in simple English. "
                    "question: the instruction in simple English."
    )
    examples: list[str] = Field(description="explain: 2 or 3 correct German example sentences. question: [].")
    picture: str = Field(
        description="explain: one short English description of a simple everyday scene that shows the idea, with no text in it. "
                    "\"\" if there is no picture. question: \"\"."
    )
    qtype: Literal["", "fill_gap", "choose", "fix_sentence", "write", "speak", "photo"] = Field(
        description="question: the kind of task. explain: \"\"."
    )
    prompt: str = Field(
        description="question: the German task. fill_gap and choose use ___ for the gap. explain: \"\"."
    )
    options: list[str] = Field(description="choose: 3 German options, one of them the answer. Otherwise [].")
    answer: str = Field(
        description="question: the correct answer, or one model answer for write, speak and photo. explain: \"\"."
    )
    hint: str = Field(
        description="question: a short nudge in simple English that does NOT contain the answer. explain: \"\"."
    )
    rule: str = Field(
        description="question: one short sentence in simple English naming the rule. explain: \"\" or the rule."
    )
    category: LessonCategory = Field(description="The grammar category of the point, or \"\" if there is none.")


# A whole lesson: the plan the model writes when the learner picks a topic.
class Lesson(Strict):
    title: str = Field(description="A short English title for the lesson, at most 6 words.")
    steps: list[Step] = Field(
        description="6 to 8 steps in teaching order. Start with an explanation. Mix explanations and questions, "
                    "with at least 3 questions."
    )


# Vogi's answer to one learner answer, or to "I don't know".
class LessonTurn(Strict):
    correct: bool = Field(description="true only if the answer is right.")
    feedback: str = Field(
        description="One short sentence in simple English. If right, a short confirmation. If wrong, a second hint "
                    "that is different from the first hint. It must NOT contain the expected answer."
    )
    add_steps: list[Step] = Field(
        description="New steps to put right after this one, only when the learner did not know or got it wrong twice. "
                    "Otherwise []."
    )


def json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Schema with $refs inlined and titles removed, ready for response_format strict mode."""
    raw = model.model_json_schema()
    defs = raw.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(defs[node["$ref"].split("/")[-1]])
            # "title" is pydantic's label, unless it is a field name inside "properties"
            return {k: (walk(v) if k != "properties" else {f: walk(x) for f, x in v.items()})
                    for k, v in node.items() if k != "title" or not isinstance(v, str)}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(raw)
