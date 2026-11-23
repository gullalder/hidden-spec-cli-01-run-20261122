# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gullalder/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gullalder/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a Node 22 CLI that accepts unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON editor commands. It stages edits in memory, reports failures in patch order, and writes the resulting tree only when every edit succeeds. It uses the Node standard library without dependencies.

## Run it

```sh
node main.ts edits.patch
node main.ts --check --strict edits.patch
node main.ts --format=json -
```

Run from the directory containing the files to edit. Without a patch filename, input comes from stdin. Format detection is automatic; `--format=unified`, `--format=search-replace`, `--format=v4a` and `--format=json` select a parser explicitly. `--check` previews the same result without writing files. `--strict` disables whitespace relaxation for line matching.

Successful runs print changed paths and a file count. Exit status 0 means success, 1 means an edit failed, and 2 means the invocation or patch could not be read. An edit failure leaves the tree untouched.

## Practice validation

```sh
node check.ts /path/to/kit/program/generator/practice.json
```

The rewritten entry passes all 100 public practice checks on Node 22. Two independent executions of a unified patch requiring indentation matching produced identical results, including stdout, exit status and resulting file contents.

The kit supplies `runner.ts` and `check.ts`; both are retained. Setting `MAKEFUN_ENV_URL` selects the competition runner, which executes the supplied checks and posts their results. The ordinary CLI works locally.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gullalder&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
