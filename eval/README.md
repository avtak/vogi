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

| Date | Set | Model | Errors fixed | Clean sentences left alone |
|---|---|---|---|---|
| 31.10.2026 | basic (38) | `muse-spark-1.3` | 28 of 28 | 11 of 11 |
| 31.10.2026 | hard (18) | `muse-spark-1.3` | 14 of 14 | 7 of 7 |
| 31.10.2026, minimal reasoning | basic (38) | `muse-spark-1.3` | 28 of 28 | 11 of 11 |
| 31.10.2026, minimal reasoning | hard (18) | `muse-spark-1.3` | 14 of 14 | 7 of 7 |

The second pair is the setting the app uses: `reasoning_effort="minimal"`. A sentence takes 1.3 s
and 1.5 s on average instead of 4.1 s and 7.1 s. The result files now keep every edit and its hint.
"Hint spoils" counts hints that contain all the new words of the fix: 1 of 28 and 0 of 14. The one
is a fair choice question ("Which word goes with Kind: der, die or das?").

The hard set (`testset_hard.jsonl`, `uv run vogi-eval --set hard`) has several errors per text,
B2 and C1 errors, and correct sentences that look wrong ("Mir ist kalt.", "Er sagte, er habe
keine Zeit."). Muse Spark scored full marks on both. So far the sets show that it fixes
sentence-level errors and leaves correct German alone. They do not yet separate models.

One correction after the run: for h-05 the model wrote "geschrieben worden sein", which is also
correct German. I added it to the accepted fixes and rescored the run.

## Limits

- 38 sentences is small. A difference of one or two sentences is noise.
- The author, a learner, wrote the sentences and fixes with an AI assistant.
  A native-speaker teacher has not reviewed them yet.
- Matching is by text, so a correct fix that uses other words counts as missed.
  Read `rows` in the result file before trusting a number.
- The sentences are made up for testing. They contain no learner's real text.
