#!/usr/bin/env python3

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


PATCH_FILE_PATTERN = re.compile(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", re.MULTILINE)
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent / "output"
SCAFFOLD_USER_PREFIXES = (
    "# AGENTS.md instructions for ",
    "<environment_context>",
)
COMMENTARY_PHASES = {"commentary"}


@dataclass
class MessageRecord:
    role: str
    text: str
    timestamp: str
    turn_id: str | None
    phase: str | None


@dataclass
class PatchRecord:
    patch: str
    timestamp: str
    turn_id: str | None

    @property
    def files(self) -> list[str]:
        return PATCH_FILE_PATTERN.findall(self.patch)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Extract user/assistant transcript content from a Codex session JSONL file and "
            "optionally include structured apply_patch diffs."
        ),
    )
    parser.add_argument("session_path", help="Path to the Codex session JSONL file")
    parser.add_argument(
        "--mode",
        choices=("full", "last-turn", "final-pair"),
        default="full",
        help=(
            "Select transcript scope: all visible messages, the last completed turn, or just the "
            "final user/assistant pair"
        ),
    )
    parser.add_argument(
        "--include-commentary",
        action="store_true",
        help=(
            "Include assistant commentary/progress updates. By default only final assistant replies "
            "and unphased assistant messages are exported."
        ),
    )
    parser.add_argument(
        "--include-diffs",
        action="store_true",
        help="Append structured apply_patch diffs found in the selected scope",
    )
    parser.add_argument(
        "--output",
        help="Optional file path to write the extracted transcript to",
    )
    parser.add_argument(
        "--output-dir",
        help=(
            "Optional directory for generated transcript files. Defaults to "
            f"{DEFAULT_OUTPUT_DIR}"
        ),
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Write the transcript to stdout instead of a file",
    )
    return parser.parse_args()


def load_records(
    session_path: Path,
    *,
    include_commentary: bool,
) -> tuple[list[MessageRecord], list[PatchRecord]]:
    messages: list[MessageRecord] = []
    patches: list[PatchRecord] = []
    current_turn_id: str | None = None

    with session_path.open("r", encoding="utf-8") as session_file:
        for line_number, raw_line in enumerate(session_file, start=1):
            line = raw_line.strip()
            if not line:
                continue

            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON on line {line_number}: {exc}") from exc

            record_type = record.get("type")
            payload = record.get("payload") or {}
            timestamp = record.get("timestamp", "")

            if record_type == "event_msg" and payload.get("type") == "task_started":
                current_turn_id = payload.get("turn_id")
                continue

            if record_type != "response_item":
                continue

            payload_type = payload.get("type")

            if payload_type == "message":
                role = payload.get("role")
                if role not in {"user", "assistant"}:
                    continue

                text = extract_message_text(payload)
                if not text:
                    continue

                if role == "user" and is_scaffold_user_message(text):
                    continue

                phase = payload.get("phase")
                if role == "assistant" and not should_include_assistant_phase(
                    phase,
                    include_commentary=include_commentary,
                ):
                    continue

                messages.append(
                    MessageRecord(
                        role=role,
                        text=text,
                        timestamp=timestamp,
                        turn_id=current_turn_id,
                        phase=phase,
                    ),
                )
                continue

            if payload_type in {"custom_tool_call", "function_call"} and payload.get("name") == "apply_patch":
                patch = payload.get("input") or payload.get("arguments") or ""
                if not patch:
                    continue

                patches.append(
                    PatchRecord(
                        patch=patch,
                        timestamp=timestamp,
                        turn_id=current_turn_id,
                    ),
                )

    return messages, patches


def should_include_assistant_phase(phase: Any, *, include_commentary: bool) -> bool:
    if include_commentary:
        return True

    if not isinstance(phase, str):
        return True

    return phase not in COMMENTARY_PHASES


def extract_message_text(payload: dict[str, Any]) -> str:
    content = payload.get("content")
    if isinstance(content, str):
        return content.strip()

    if not isinstance(content, list):
        fallback = payload.get("text")
        return fallback.strip() if isinstance(fallback, str) else ""

    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue

        item_type = item.get("type")
        if item_type in {"input_text", "output_text"}:
            text = item.get("text")
        elif item_type == "text":
            text = item.get("text") or item.get("content")
        else:
            text = None

        if isinstance(text, str) and text.strip():
            parts.append(text.strip())

    return "\n\n".join(parts).strip()


def is_scaffold_user_message(text: str) -> bool:
    stripped = text.lstrip()
    return any(stripped.startswith(prefix) for prefix in SCAFFOLD_USER_PREFIXES)


def select_messages(messages: list[MessageRecord], mode: str) -> list[MessageRecord]:
    if not messages:
        return []

    if mode == "full":
        return messages

    last_assistant_index = find_last_index(messages, lambda message: message.role == "assistant")
    if last_assistant_index is None:
        return messages

    if mode == "final-pair":
        last_user_index = find_last_index(
            messages[: last_assistant_index + 1],
            lambda message: message.role == "user",
        )
        if last_user_index is None:
            return [messages[last_assistant_index]]
        return [messages[last_user_index], messages[last_assistant_index]]

    last_turn_id = messages[last_assistant_index].turn_id
    return [message for message in messages if message.turn_id == last_turn_id]


def select_patches(
    patches: list[PatchRecord],
    selected_messages: list[MessageRecord],
    mode: str,
) -> list[PatchRecord]:
    if not patches or not selected_messages:
        return []

    if mode == "full":
        return patches

    if mode == "last-turn":
        target_turn_id = selected_messages[-1].turn_id
        return [patch for patch in patches if patch.turn_id == target_turn_id]

    selected_user = next((message for message in selected_messages if message.role == "user"), None)
    selected_assistant = next((message for message in reversed(selected_messages) if message.role == "assistant"), None)
    if not selected_assistant:
        return []

    target_turn_id = selected_assistant.turn_id
    if not selected_user:
        return [patch for patch in patches if patch.turn_id == target_turn_id]

    return [
        patch
        for patch in patches
        if patch.turn_id == target_turn_id and selected_user.timestamp <= patch.timestamp <= selected_assistant.timestamp
    ]


def find_last_index(values: list[MessageRecord], predicate: Callable[[MessageRecord], bool]) -> int | None:
    for index in range(len(values) - 1, -1, -1):
        if predicate(values[index]):
            return index
    return None


def render_output(messages: list[MessageRecord], patches: list[PatchRecord], include_diffs: bool) -> str:
    transcript_parts: list[str] = ["# Transcript"]
    message_patches = attach_patches_to_messages(messages, patches) if include_diffs else {}

    for index, message in enumerate(messages):
        transcript_parts.append(f"\n## {message.role.capitalize()}\n{message.text}")

        attached_patches = message_patches.get(index, [])
        if attached_patches:
            transcript_parts.append("\n### Diffs")
            for patch_index, patch in enumerate(attached_patches, start=1):
                files = ", ".join(patch.files) if patch.files else "unknown files"
                transcript_parts.append(
                    f"\n#### Patch {patch_index}\nFiles: {files}\n\n```diff\n{patch.patch}\n```",
                )

    if include_diffs and patches and not message_patches:
        transcript_parts.append("\n## Diffs\nNo matching assistant message found for the selected patches.")

    return "\n".join(transcript_parts).strip() + "\n"


def attach_patches_to_messages(
    messages: list[MessageRecord],
    patches: list[PatchRecord],
) -> dict[int, list[PatchRecord]]:
    attachments: dict[int, list[PatchRecord]] = {}

    for patch in patches:
        target_index = find_patch_owner(messages, patch)
        if target_index is None:
            continue

        attachments.setdefault(target_index, []).append(patch)

    return attachments


def find_patch_owner(messages: list[MessageRecord], patch: PatchRecord) -> int | None:
    same_turn_assistants = [
        (index, message)
        for index, message in enumerate(messages)
        if message.role == "assistant" and message.turn_id == patch.turn_id
    ]
    if not same_turn_assistants:
        return None

    future_final_answer = next(
        (
            index
            for index, message in same_turn_assistants
            if message.timestamp >= patch.timestamp and message.phase == "final_answer"
        ),
        None,
    )
    if future_final_answer is not None:
        return future_final_answer

    future_assistant = next(
        (
            index
            for index, message in same_turn_assistants
            if message.timestamp >= patch.timestamp
        ),
        None,
    )
    if future_assistant is not None:
        return future_assistant

    return same_turn_assistants[-1][0]


def build_generated_output_path(args: argparse.Namespace, session_path: Path) -> Path:
    output_dir = Path(args.output_dir).expanduser() if args.output_dir else DEFAULT_OUTPUT_DIR
    suffixes = [args.mode]

    if args.include_commentary:
        suffixes.append("commentary")

    if args.include_diffs:
        suffixes.append("diffs")

    filename = f"{session_path.stem}__{'-'.join(suffixes)}.md"
    return output_dir / filename


def main() -> int:
    args = parse_args()
    session_path = Path(args.session_path).expanduser()

    if not session_path.is_file():
        print(f"Session file not found: {session_path}", file=sys.stderr)
        return 1

    if args.stdout and (args.output or args.output_dir):
        print("Use either --stdout or a file output option, not both.", file=sys.stderr)
        return 1

    try:
        messages, patches = load_records(
            session_path,
            include_commentary=args.include_commentary,
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    selected_messages = select_messages(messages, args.mode)
    output = render_output(
        messages=selected_messages,
        patches=select_patches(patches, selected_messages, args.mode),
        include_diffs=args.include_diffs,
    )

    if args.stdout:
        sys.stdout.write(output)
        return 0

    output_path = Path(args.output).expanduser() if args.output else build_generated_output_path(args, session_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(output, encoding="utf-8")
    sys.stdout.write(f"Wrote {output_path}\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
