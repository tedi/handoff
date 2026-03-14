# Handoff

`handoff.py` extracts a clean transcript from a Codex session JSONL file and can optionally append the recorded `apply_patch` diffs.

## Usage

Run it with:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl>
```

Example:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py \
  /Users/tedikonda/.codex/sessions/2026/03/13/rollout-2026-03-13T17-05-59-019ce9aa-04f8-7860-883a-1ceb41b9ac31.jsonl
```

Write output to a file:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl> --output /tmp/handoff.md
```

Include diffs:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl> --include-diffs
```

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
- Excludes diffs unless `--include-diffs` is set.
- Skips injected scaffold messages such as AGENTS/context prompts.
