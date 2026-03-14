# Handoff

`handoff.py` extracts a clean transcript from a Codex session JSONL file and can optionally attach the recorded `apply_patch` diffs inline under the assistant reply they belong to.

## Usage

Run it with:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl>
```

By default this writes a generated Markdown file into:

```bash
/Users/tedikonda/ai/handoff/output
```

Example:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py \
  /Users/tedikonda/.codex/sessions/2026/03/13/rollout-2026-03-13T17-05-59-019ce9aa-04f8-7860-883a-1ceb41b9ac31.jsonl
```

Write output to a specific file:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl> --output /tmp/handoff.md
```

Write output into a different folder:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl> --output-dir /tmp/handoff-exports
```

Write to stdout instead of a file:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl> --stdout
```

Include diffs:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl> --include-diffs
```

When `--include-diffs` is set, diffs are attached inline under the matching assistant message instead of being collected in one block at the end.

Include assistant commentary/progress updates:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl> --include-commentary
```

Export only the last user/assistant pair:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl> --mode final-pair
```

Export only the last completed turn:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl> --mode last-turn
```

## Default behavior

- Includes user messages.
- Includes final assistant replies.
- Excludes assistant commentary/progress updates unless `--include-commentary` is set.
- Writes a generated Markdown file into `/Users/tedikonda/ai/handoff/output` unless `--output`, `--output-dir`, or `--stdout` is used.
- Excludes diffs unless `--include-diffs` is set.
- Attaches diffs inline to the assistant reply for that turn when `--include-diffs` is set.
- Skips injected scaffold messages such as AGENTS/context prompts.
