"""Score a model on eval/testset.jsonl: `uv run vogi-eval --provider meta`.

An error counts as fixed when corrected_text contains one of its accepted fixes and no longer
contains the wrong words. A clean sentence counts as kept when corrected_text equals it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
from pathlib import Path

from . import core, providers

ROOT = Path(__file__).parent.parent / "eval"


def has(text: str, frag: str) -> bool:
    return re.search(r"(?<!\w)" + re.escape(" ".join(frag.split())) + r"(?!\w)", " ".join(text.split())) is not None


def score_item(item: dict, out: dict | None) -> dict:
    row = {"id": item["id"], "valid": out is not None}
    if out is None:
        row.update(fixed=0, errors=len(item["errors"]), kept=None)
        return row
    corrected = out["result"]["corrected_text"]
    row["corrected"] = corrected
    row["edits"] = len(out["result"]["edits"])
    row["edit_list"] = out["result"]["edits"]
    row["level_estimate"] = out["result"].get("level_estimate")
    # Try first only works if a hint does not give away the fix.
    row["hint_spoils"] = sum(core._spoils(e["hint"], e["replacement"], e["original"]) for e in out["result"]["edits"])
    row["grounded"] = out["checks"]["grounded"]
    row["ms"] = out["meta"]["ms"]
    row["tokens"] = out["meta"]["tokens_in"] + out["meta"]["tokens_out"]
    if item["errors"]:
        row["errors"] = len(item["errors"])
        row["fixed"] = sum(
            any(has(corrected, g) for g in e["good"]) and not has(corrected, e["bad"]) for e in item["errors"]
        )
        row["kept"] = None
    else:
        row.update(errors=0, fixed=0, kept=" ".join(corrected.split()) == " ".join(item["text"].split()))
    return row


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--provider", default=None, help="meta, baseten, fireworks, together or custom")
    ap.add_argument("--mode", default="grammar", choices=["grammar", "words", "natural"])
    ap.add_argument("--limit", type=int, default=0, help="only the first N items (a cheap smoke test)")
    ap.add_argument("--set", default="basic", choices=["basic", "hard"], help="basic: testset.jsonl, hard: testset_hard.jsonl")
    args = ap.parse_args(argv)

    providers.load_env_file()
    p = providers.get(args.provider)
    path = ROOT / ("testset.jsonl" if args.set == "basic" else "testset_hard.jsonl")
    items = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if args.limit:
        items = items[: args.limit]

    rows = []
    for item in items:
        try:
            out = core.correct(p, item["text"], item["level"], args.mode)
        except Exception as e:  # one bad answer must not stop the run
            print(f"{item['id']}: failed ({type(e).__name__}: {e})", file=sys.stderr)
            out = None
        row = score_item(item, out)
        rows.append(row)
        mark = "kept" if row.get("kept") else f"{row['fixed']}/{row['errors']}" if row["errors"] else "CHANGED"
        print(f"{item['id']:6} {mark:8} {row.get('corrected', '-')}")
        time.sleep(0.2)

    valid = [r for r in rows if r["valid"]]
    errs = [r for r in rows if r["errors"]]
    clean = [r for r in valid if r["kept"] is not None]
    summary = {
        "provider": p.id, "model": p.model, "open_weight": p.open_weight, "mode": args.mode, "set": args.set,
        "date": dt.date.today().isoformat(), "items": len(rows),
        "errors_total": sum(r["errors"] for r in errs), "errors_fixed": sum(r["fixed"] for r in errs),
        "recall": (sum(r["fixed"] for r in errs) / sum(r["errors"] for r in errs)) if errs else None,
        "clean_kept": (sum(r["kept"] for r in clean) / len(clean)) if clean else None,
        "valid_rate": len(valid) / len(rows),
        "grounded_rate": (sum(r["grounded"] for r in valid) / max(1, sum(r["edits"] for r in valid))),
        "avg_ms": (sum(r["ms"] for r in valid) / len(valid)) if valid else 0,
        "tokens": sum(r.get("tokens", 0) for r in valid),
        "hints": sum(r["edits"] for r in valid),
        "hint_spoils": sum(r.get("hint_spoils", 0) for r in valid),
    }
    out_dir = ROOT / "results"
    out_dir.mkdir(exist_ok=True)
    name = f"{p.id}-{args.mode}{'-hard' if args.set == 'hard' else ''}{'-limit' + str(args.limit) if args.limit else ''}.json"
    (out_dir / name).write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1))
    print(json.dumps(summary, indent=1))
    print(f"Saved eval/results/{name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
