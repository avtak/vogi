"""Offline checks of Vogi's own logic (no model, no key). Run: uv run python -m tests.test_offline"""

from vogi.evaluate import has, score_item
from vogi.schema import Correction, Lesson, LessonTurn, Scene, json_schema
from vogi.core import verify


def test_schema_is_strict():
    s = json_schema(Correction)
    assert s["additionalProperties"] is False
    assert set(s["required"]) == set(s["properties"])
    edit = s["properties"]["edits"]["items"]
    assert edit["additionalProperties"] is False and set(edit["required"]) == set(edit["properties"])
    assert "$ref" not in str(s) and "$defs" not in s


def test_schema_keeps_a_field_named_title():
    s = json_schema(Scene)  # pydantic's labels go, the scene's own "title" field stays
    assert "title" in s["properties"] and set(s["required"]) == set(s["properties"])
    assert "title" not in s["properties"]["title"]


def test_verify_flags_invented_edit():
    c = Correction.model_validate({
        "corrected_text": "Gestern habe ich Pizza gegessen.",
        "edits": [
            {"original": "ich habe", "replacement": "habe ich", "category": "verb_position", "severity": "error", "hint": "h", "rule": "V2."},
            {"original": "Nudeln", "replacement": "Pizza", "category": "word_choice", "severity": "style", "hint": "h", "rule": "x"},
        ],
        "summary": "ok", "level_estimate": "A2",
    })
    v = verify("Gestern ich habe Pizza gegessen.", c, "grammar")
    assert [e["grounded"] for e in v["edits"]] == [True, False]
    assert v["warnings"]


def test_verify_flags_unexplained_change():
    c = Correction.model_validate({"corrected_text": "Ich danke dir für deine Hilfe beim Umzug.", "edits": [], "summary": "ok", "level_estimate": "A2"})
    v = verify("Ich danke dir für deine Hilfe bei dem Umzug.", c, "grammar")
    assert v["unexplained"] and any("no change was explained" in w for w in v["warnings"])


def test_scoring():
    item = {"id": "t", "level": "A2", "text": "Ich kenne ihm seit drei Jahren.",
            "errors": [{"category": "case", "bad": "kenne ihm", "good": ["kenne ihn"]}]}
    edit = {"original": "kenne ihm", "replacement": "kenne ihn", "hint": "Which case does kennen need?"}
    out = {"result": {"corrected_text": "Ich kenne ihn seit drei Jahren.", "edits": [edit]},
           "checks": {"grounded": 1}, "meta": {"ms": 1, "tokens_in": 1, "tokens_out": 1}}
    assert score_item(item, out)["fixed"] == 1
    assert not has("einen Sohn", "ein Sohn")
    assert has("Gestern habe ich", "habe ich")


def test_spoilers():
    from vogi.core import _spoils
    assert _spoils("Not yet. After essen, use einen, not einem.", "einen Kuchen", "ein Kuchen")
    assert not _spoils("Which case comes after 'mit'?", "meinem Bruder", "mein Bruder")
    # one of two new words is a leak for the judge
    assert _spoils("Use meinem here.", "meinem Bruders", "mein Bruder", any_word=True)
    assert not _spoils("Use meinem here.", "meinem Bruders", "mein Bruder")


def test_lesson_schemas_are_strict():
    for model, field in ((Lesson, "steps"), (LessonTurn, "add_steps")):
        s = json_schema(model)
        assert s["additionalProperties"] is False and set(s["required"]) == set(s["properties"])
        step = s["properties"][field]["items"]
        assert step["additionalProperties"] is False and set(step["required"]) == set(step["properties"])
        assert "$ref" not in str(s) and "$defs" not in s
        assert "" in step["properties"]["category"]["enum"] and "case" in step["properties"]["category"]["enum"]
        assert step["properties"]["qtype"]["enum"][0] == "" and "photo" in step["properties"]["qtype"]["enum"]


def test_lesson_feedback_does_not_give_the_answer():
    from vogi.core import guard_feedback
    step = {"answer": "meinem Bruder", "hint": "Which case comes after 'mit'?"}
    # the learner typed mein Bruder: a second hint that names meinem gives the answer away
    assert guard_feedback("Use meinem, the dative.", step, "mein Bruder") == step["hint"]
    assert guard_feedback("Think about the case after mit.", step, "mein Bruder") == "Think about the case after mit."


def test_lesson_steps_are_cleaned_and_explanations_do_not_give_answers():
    from vogi.core import _guard_explains, clean_steps

    def step(**kw):
        base = {"kind": "", "text": "", "examples": [], "picture": "", "qtype": "", "prompt": "", "options": [],
                "answer": "", "hint": "", "rule": "", "category": ""}
        return {**base, **kw}

    raw = [
        step(kind="explain", text="Mit always takes the dative.", examples=["Ich fahre mit meinem Bruder.", ""],
             picture="A bus stop", category="case"),
        step(kind="question", text="Fill the gap.", qtype="choose", prompt="Ich fahre mit ___ Bruder.",
             options=["mein", "meinem", "meine"], answer="meinem", hint="Which case comes after mit?", rule="r",
             category="case"),
        step(kind="question", text="Fill the gap.", qtype="choose", prompt="Ich ___ Brot.",
             options=["esse", "isst"], answer="essen", hint="x", rule="r", category="verb_form"),
        step(kind="question", text="Fill the gap.", qtype="gap", prompt="Ich ___ Brot.", answer="esse", hint="x"),
    ]
    steps = clean_steps(raw, limit=8)
    # the choose step whose answer is not an option, and the unknown qtype, are dropped
    assert [s["kind"] for s in steps] == ["explain", "question"]
    assert steps[0]["examples"] == ["Ich fahre mit meinem Bruder."]
    assert steps[1]["hint"] == "Which case comes after mit?"  # does not spoil meinem, so it stays
    guarded = _guard_explains(steps)
    # the example gives away "meinem", the answer of the question after it: the example goes
    assert guarded[0]["examples"] == []
    assert guarded[0]["text"] == "Mit always takes the dative."


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
