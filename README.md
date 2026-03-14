# Handoff

Handoff is a local-only Electron app for browsing Codex sessions from `~/.codex/session_index.jsonl` and viewing their parsed transcript with inline diffs. The original `handoff.py` CLI remains in the repo as a reference/companion utility.

## Requirements

- macOS
- Node 20+
- npm

## Install

```bash
cd /Users/tedikonda/ai/handoff
npm install
```

## Run In Dev

```bash
cd /Users/tedikonda/ai/handoff
npm run dev
```

The app reads:

- `~/.codex/session_index.jsonl`
- `~/.codex/sessions`

The sidebar shows `thread_name` sorted by most recent `updated_at`, and the detail pane renders the full transcript with inline diffs.

## Build

```bash
cd /Users/tedikonda/ai/handoff
npm run build
```

## Package

```bash
cd /Users/tedikonda/ai/handoff
npm run package
```

Release artifacts are written to:

```text
./release/
```

## Tests

```bash
npm run test
npm run typecheck
```

## UI behavior

- Left sidebar lists conversations from `session_index.jsonl` in descending chronological order.
- Right pane renders the parsed transcript as markdown with inline diff blocks.
- Copy actions:
  - `Copy Chat`
  - `Copy Chat + Diffs`
  - `Copy Last Message`
- The app auto-refreshes when `session_index.jsonl` or the currently selected session file changes.

## CLI Companion

The existing Python CLI is still available:

```bash
python3 /Users/tedikonda/ai/handoff/handoff.py <session.jsonl> --stdout
```
