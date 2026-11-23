# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ko1216-lild/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ko1216-lild/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a patch-applying CLI that reads an AI-written edit in any of the four formats models produce — a unified diff (line numbers may be wrong), SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool calls as JSON — and applies it to a tree of text files. Each edit's target lines are located at the first of three matching tiers (exact, trailing-whitespace-insensitive, then indentation-insensitive with re-indentation of the replacement), so edits still land when whitespace or indentation has drifted. Sections, blocks and chunks apply in order against the tree as earlier edits left it, and the run is all-or-nothing: if any edit fails, nothing is written and every failure is reported. It implements SPEC.md in this repository exactly, including its exit codes, output lines (A/D/M/R per changed path), `--check` and `--strict` modes, CRLF handling and end-of-file newline rules. Node 22, standard library only.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=vivid-stork-95&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
