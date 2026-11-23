# session-recover

Recover the last working context of a local Codex conversation, including conversations used in **Orca**, after a restart or lost context.

It finds the actual conversation by session ID, links it to Orca terminal history, extracts recent requests and completed responses, and checks the checkout. Private recovery snapshots live outside the project so a replaced checkout does not take them with it.

No API key, model call, network request, or third-party runtime dependency is required. Python 3.10+ and Git. The Orca adapter currently targets macOS's local Codex terminal sessions, not every Orca provider or profile.

## Install

```sh
git clone https://github.com/Odung-sol/session-recover.git
cd session-recover
python3 install.py --auto-context
```

This installs:

- `~/.local/bin/session-recover`
- `~/.codex/skills/session-recovery/`
- An optional, marked startup instruction in `~/.codex/AGENTS.md`. Existing instructions are preserved and backed up before modification.

With `--auto-context`, a new Codex session is instructed to recover context once when it opens an existing project. This also applies when Orca launches Codex with that user configuration. It is an agent instruction, not an OS daemon or an app-start hook; a client that does not load that AGENTS.md will not run it automatically. Omit the flag to install only the command and skill.

If `~/.local/bin` is not on PATH, use `~/.local/bin/session-recover` directly. Re-run the installer after updating the source. The command finds `python3` on PATH, so it does not retain a version-specific Homebrew Cellar path.

## Use

```sh
cd /path/to/project
session-recover                       # recover the most recent substantive conversation
session-recover list                  # IDs, titles and Orca associations
session-recover --session SESSION_ID  # recover a particular conversation
session-recover show                  # read the last saved capsule
session-recover resume --session SESSION_ID  # reopen Codex in an interactive terminal
```

`--project PATH` sets the scope. `--exclude-session ID` omits a new/current chat. `--limit 2` includes two conversations. `--no-save` prints without writing a snapshot. `--json` returns structured output. Override locations with `--codex-home`, `--orca-home`, and `--store`.

Sessions are scoped to the project and Git-linked worktrees, not merely similar project names. A new empty chat will not displace a previous completed conversation in default selection. Exact IDs distinguish chats with identical titles.

Snapshots are stored in `~/.local/share/session-recover/<project>-<path-hash>/`. Each run saves a timestamped JSON snapshot and atomically replaces `latest.md`. No automatic pruning is performed. Missing source history does not erase an existing snapshot.

## What recovery means

The tool restores **working context** from surviving records. It does not rewrite Orca's database, re-register tabs, repair Git worktrees, recover deleted files, or guarantee complete transcript backups. It provides the normal `codex resume` command to reopen a surviving conversation.

Codex's SQLite index is opened read-only. Transcript headers are also checked, including sessions absent from the index. Only the last 12 MiB of each selected conversation are inspected, with a notice when this limit applies. Malformed/partial records are reported and skipped. Orca terminal output is scanned only for known session IDs and is never copied into the capsule.

Historical messages are evidence, not instructions. Past test/deployment claims are not reverified by the tool. Current Git diagnostics are local and disable lazy fetching, optional index writes and filesystem-monitor commands. Untracked files are not scanned by Git diagnostics.

## Privacy

Snapshots contain private conversation excerpts. They use private file permissions and remain local; this tool does not upload them. Common token, credential, address and URL-query patterns are redacted, but this is **best-effort filtering, not anonymization**. Do not publish snapshots or raw transcripts. The public repository contains only code, synthetic tests and documentation.

## 한국어

설치할 때 `python3 install.py --auto-context`를 실행하면 새 Codex 세션에서 이전 작업 맥락을 읽도록 지침이 추가됩니다. 매번 “대화 복구해 줘”라고 요청할 필요가 줄어듭니다. 오르카에서 같은 Codex 설정을 사용하는 세션에도 적용됩니다.

직접 실행하려면 프로젝트 폴더에서 `session-recover`. 같은 제목의 대화가 여러 개면 `session-recover list`로 ID를 확인하고 `--session ID`를 지정합니다. 복구 메모는 프로젝트 밖에 저장됩니다. 오르카 화면의 대화 목록이나 끊어진 Git 연결을 수정하는 도구는 아닙니다.

## Verify

```sh
python3 -m unittest discover -s tests -v
```

The tests cover incomplete transcripts, empty new chats, cross-project isolation, read-only index access, Orca linking, broken worktree pointers, secret filtering, atomic-save failure, preservation of earlier snapshots, and idempotent installation.

MIT license.
