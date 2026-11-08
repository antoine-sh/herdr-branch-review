# herdr-branch-review

A [Herdr](https://herdr.dev) mod that reviews the branch you are working on: every commit it has made ahead of local `main`, plus your staged and uncommitted changes, with a diff viewer, a commit box and a one-click merge back to `main`.

It follows the focused space, so in a worktree-per-task workflow it always shows the branch you are looking at.

## Features

- **Committed**: the commits between the merge-base with local `main` (or `master`) and `HEAD`, drawn as a timeline. Click one to see only its files and diff; click it again to go back to the whole branch.
- **Staged changes / Changes**: the same split as VS Code. Stage, unstage or discard a file, or all of them at once. Untracked files are included.
- **Diff viewer**: line-numbered, colored, virtualized and horizontally scrollable, so large diffs stay smooth.
- **Commit**: type a message and commit what is staged.
- **AI commit message**: the sparkle button asks Claude (Haiku, through `claude -p`) to write a message from the staged diff. It follows commit conventions found in your `~/.claude/CLAUDE.md`, `AGENTS.md`, and the project's `CLAUDE.md` / `AGENTS.md`.
- **Merge to main**: merges the branch into local `main`. If `main` is checked out in another worktree, the merge runs there; otherwise only a fast-forward is done. A failed merge is aborted. It needs a second click to confirm and is disabled while there are uncommitted changes.
- **Live**: refreshes when files in the repository change, and every 10 seconds as a fallback.
- **Remote spaces**: works on spaces that live on another machine; git runs there.
- Each space keeps its own selection and open file when you switch away and back.

Destructive buttons (`⟲` discard, `Discard all`) need two clicks within one second.

## Requirements

- Herdr app
- `git` on the machine that holds the repository
- A local branch named `main` or `master` to compare against (remote branches are never used)
- Optional, for AI commit messages: the [`claude`](https://claude.com/claude-code) CLI on `PATH`

## Install

```sh
git clone https://github.com/antoine-sh/herdr-branch-review ~/.config/herdr-app/mods/branch-review
herdr-app check ~/.config/herdr-app/mods/branch-review
```

The mod has `"place": "none"`, so it does not appear on its own. Open it in one of these ways:

```sh
# As a pane beside your terminal
herdr-app do pane.split --direction right --mod branch-review

# As a dialog, toggled
herdr-app do mod.open --name branch-review
```

To dock it in a layout, add a block to your layout file (clone a shipped layout first, they are read-only):

```json
{ "id": "review", "type": "block", "size": { "px": 480 }, "content": { "mod": "branch-review" } }
```

To open it with a key, add to `keys.json`:

```json
{ "global": { "ctrl-shift-r": "mod.open:branch-review" } }
```

## How it works

Everything goes through `git` with `--no-optional-locks`, so reading never takes the index lock or triggers the folder watcher in a loop. The base is the merge-base of local `main`/`master` and `HEAD`. Lists are capped at 500 commits, 1000 files and 1500 diff lines per file.

## Files

| File | Purpose |
|---|---|
| `main.js` | the mod |
| `mod.json` | placement (`none`) |
| `ai.svg`, `review.svg` | icons |
| `gpui-kit.d.ts`, `jsconfig.json` | editor types, rewritten by Herdr on start (safe to git-ignore) |

## License

Add a license before publishing, for example MIT.
