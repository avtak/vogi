"""Offline checks of Vogi's own logic (no model, no key). Run: uv run python -m tests.test_offline"""

from vogi.evaluate import has, score_item
from vogi.schema import Correction, Scene, json_schema
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


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
