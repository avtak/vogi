# Vogi test set

`testset.jsonl` has 38 short German sentences at A1, A2 and B1: 27 with known learner
errors (28 errors in all) and 11 that are correct. Each error lists the wrong words
(`bad`) and the accepted fixes (`good`).

## Score

`uv run vogi-eval --provider <id>` corrects every sentence in grammar mode and writes
`results/<provider>-grammar.json`.

| Number | Meaning |
|---|---|
| Errors fixed | The corrected text contains an accepted fix and no longer contains the wrong words |
| Clean sentences left alone | A correct sentence comes back unchanged. Grammar mode must not rewrite correct German |
| Valid format | The answer matched the schema (after at most one retry) |
| Grounded rate | Share of the model's edits whose `original` is really in the learner's text |

## Results so far

| Date | Model | Errors fixed | Clean sentences left alone |
|---|---|---|---|
| 31.10.2026 | `muse-spark-1.3` | 28 of 28 | 11 of 11 |

A perfect score means this set is too easy to tell models apart. A harder set comes next:
several errors per text, B2 to C1 errors, and sentences that look wrong but are correct.

## Limits

- 38 sentences is small. A difference of one or two sentences is noise.
- The sentences and fixes were written by the author, a learner, with an AI assistant.
  A native-speaker teacher has not reviewed them yet.
- Matching is by text, so a correct fix that uses other words counts as missed.
  Read `rows` in the result file before trusting a number.
- The sentences are made up for testing. They contain no learner's real text.
