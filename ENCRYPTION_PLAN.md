# Separate normal and encrypted vaults

This replaces the earlier per-note encryption design. Branch: `codex/encrypted-notes`.

## Behavior

- Normal vault: ordinary Markdown files and folders.
- Private vault: an independent virtual tree stored in `.black-cobble-private` at the normal vault root.
- The private snapshot encrypts note bodies, titles, folders and recovery drafts. Only the container's existence, size and filesystem timestamps remain visible.
- Each vault has its own wikilinks. No cross-vault resolution or file operations.
- Private files remain encrypted on disk while unlocked. Locking clears the entire private tree, editor, dialogs, search and undo state.
- Lock manually, on return to Normal, on close, on workspace change or after 10 minutes of app inactivity.
- Password change requires the current password. There is no password recovery.
- Move/rename within either vault updates affected wikilinks, preserving alias and heading suffixes. Private moves require an unlocked private vault; normal moves do not.
- Private deletion is permanent with explicit confirmation. Public deletion uses OS trash.

## Work allocation

Three GPT-6.1 Sol agents with high reasoning implemented encrypted storage, vault UI and link-preserving moves. The main agent integrated IPC boundaries, reviewed storage/UI behavior, and ran tests and Windows packaging. The link-update agent independently reviewed the encrypted storage boundary and draft ordering.

## Storage and failure handling

The first version uses a single authenticated encrypted snapshot per private vault, capped at 16 MiB of decrypted JSON including the tree and drafts. Writes replace the encrypted snapshot atomically. This favors a simple recoverable format over large-vault performance.

The existing crypto module uses AES-256-GCM, random nonces and an independently generated vault key. Password wrapping uses scrypt with N=131072, r=8, p=1. The wrapped key and encrypted snapshot live together in `vault.sealed`. No plaintext index or filenames are written into the private directory.

Only main owns keys. IPC results are checked against session and active vault changes. Normal operations reject hidden private storage paths and private write tokens. Private operations reject traversal and cross-vault paths. Closing or changing workspace cannot silently discard encrypted data that only exists in memory.

Draft snapshots are sealed before an immediate lock can revoke the session. Monotonic snapshot ordering prevents an older queued draft from overwriting a newer mutation or password change. Conflicting external writes are preserved; pending private edits can be stored in separate ciphertext-only recovery files and offered as recovery copies after unlock.

Public link rewrites use version checks, atomic individual file replacement and rollback on runtime failures. The public filesystem cannot make a move and multiple note replacements one crash-atomic transaction. A process crash or external modification during that operation remains a limitation.

## Compatibility

Legacy per-note encrypted files and their metadata are preserved. New private setup is blocked when legacy data is found. Automatic migration is deliberately absent because mixed public/private folders and interrupted cleanup need a separate migration transaction. The prior portable build is retained as `release/Black Cobble legacy private notes.exe` for accessing those vaults. Do not delete old metadata while any old note or recovery draft still depends on it.

Back up the entire `.black-cobble-private` directory. This does not securely erase prior copies or protect a compromised unlocked process, clipboard, operating-system memory or old backups. Password changes do not revoke old backups.

## Validation

Tests cover ciphertext absence of titles/folders/body, lock/restart, private preferences, mode isolation, password changes, stale writes, draft ordering, conflicts/recovery, link moves, normal workflows, and native close races.

- 123 unit tests pass across 10 files.
- 14 Electron workflow tests pass, including immediate editing after link-preserving moves and renames.
- TypeScript and production build pass.
- Locked and unlocked private views were inspected visually using synthetic notes.
- Windows file-sharing failures use bounded atomic-replacement retries, with a disk-version check before every attempt. Tests cover retry success, exhaustion and external replacement during a retry.
- The packaged Windows application passes opening, public editing and saving, encrypted title/folder/body checks, empty locked tree and rejected locked reads.
