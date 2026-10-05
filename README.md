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

## Live threads and pop-out

Control Center follows local Claude Code and Codex transcripts, including Work chats that use the local Codex runtime. It discovers recent threads at startup and watches new transcripts as they appear. Threads with activity in the last 24 hours are shown; older history remains available in Threads.

Open **Control Center**, then **Pop out**, to keep the live view visible while working. The main window and pop-out receive the same live updates. Existing provider hooks also supply permission requests and other lifecycle events; the **Install live hooks** controls configure them.

Control Center is enabled by default. Set `HANDOFF_CONTROL_CENTER=0` to disable collection.

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
