# herdr-branch-review

A [Herdr](https://herdr.dev) mod that reviews the branch you are working on:

- every commit it has made ahead of local `main`
- your staged and uncommitted changes
- a diff viewer, a commit box and a one-click merge back to `main`

It follows the focused space, so in a worktree-per-task workflow it always shows the branch you are looking at.

---

## 📑 Contents

- [Features](#-features)
- [Requirements](#-requirements)
- [Install](#-install)
- [Opening it](#-opening-it)
- [How it works](#-how-it-works)
- [Files](#-files)
- [License](#-license)

---

## ✨ Features

### 🔍 Reviewing

| Section | What it shows |
|---|---|
| 🕒 **Committed** | The commits between the merge-base with local `main` (or `master`) and `HEAD`, drawn as a timeline. Click one to see only its files and diff; click it again to go back to the whole branch. |
| 🗂️ **Staged changes / Changes** | The same split as VS Code. Stage, unstage or discard a file, or all of them at once. Untracked files are included. |
| 🎨 **Diff viewer** | Line-numbered, colored, virtualized and horizontally scrollable, so large diffs stay smooth. |

### 📝 Committing

- 💾 **Commit**: type a message and commit what is staged.
- 🤖 **AI commit message**: the ✨ button asks Claude (Haiku, through `claude -p`) to write a message from the staged diff. It follows commit conventions found in:
  - your `~/.claude/CLAUDE.md`
  - `AGENTS.md`
  - the project's `CLAUDE.md` / `AGENTS.md`

### 🔄 Syncing with upstream

- 📡 **Fetch**: runs `git fetch` in the background at most every 5 minutes per repository, and on demand with the `↻ Fetch` button. It only updates `origin/*`, never your files.
- 🏷️ **Behind badge**: `↓N upstream` shows when the current branch is behind its upstream.
- 🔘 **Pull / Push (on `main`)**: when the current branch is `main` (or `master`), the merge button becomes a state button:

  | State | Button | Runs |
  |---|---|---|
  | ⬇️ Behind upstream | `Pull main` | `git pull --ff-only` (disabled while there are uncommitted changes) |
  | ⬆️ Ahead of upstream | `Push main (N)` | `git push` |
  | ↔️ Diverged | 🔴 `Diverged: pull & merge` | `git pull --no-rebase --no-edit`; on conflicts the merge is aborted and `main` is left untouched |
  | ✅ In sync | disabled | nothing to pull or push |

### 🔀 Merging to `main`

One click merges the branch into local `main`, with no confirmation.

- If `main` is checked out in another worktree, the merge runs **there**; otherwise only a **fast-forward** is done.
- A failed merge is aborted and the reason shown.
- On success, the result stays above the commit box: commits merged, the new `main` head and the diffstat.
- Disabled while there are uncommitted changes.
- 🧹 **Worktree cleanup**: when the merge came from a linked worktree, a bar offers to delete the merged branch and remove that worktree (`git worktree remove`, `git branch -d`). Both are non-forcing, so they refuse if anything is left uncommitted.

### ⚡ Everyday

- 🔁 **Live**: refreshes when files in the repository change, and every 10 seconds as a fallback.
- 🌐 **Remote spaces**: works on spaces that live on another machine; git runs there.
- 🧠 **Per-space memory**: each space keeps its own selection and open file when you switch away and back.

> [!NOTE]
> ⚠️ Destructive buttons (`⟲` discard, `Discard all`) need **two clicks within one second**.

---

## 📋 Requirements

- Herdr app
- `git` on the machine that holds the repository
- A local branch named `main` or `master` to compare against (remote branches are never used)
- *Optional*, for AI commit messages: the [`claude`](https://claude.com/claude-code) CLI on `PATH`

---

## 📦 Install

```sh
git clone https://github.com/antoine-sh/herdr-branch-review ~/.config/herdr-app/mods/branch-review
herdr-app check ~/.config/herdr-app/mods/branch-review
```

## 🚀 Opening it

The mod has `"place": "none"`, so it does not appear on its own. Pick one of these:

**🪟 As a pane beside your terminal**

```sh
herdr-app do pane.split --direction right --mod branch-review
```

**💬 As a dialog, toggled**

```sh
herdr-app do mod.open --name branch-review
```

**🧩 Docked in a layout** — add a block to your layout file. Shipped layouts are read-only, so clone one first (`herdr-app do layout.clone '{"name":"main","as":"my-layout"}'`).

```json
{ "id": "review", "type": "block", "size": { "px": 480 }, "content": { "mod": "branch-review" } }
```

**⌨️ With a key** — add to `keys.json`:

```json
{ "global": { "ctrl-shift-r": "mod.open:branch-review" } }
```

---

## ⚙️ How it works

- Everything goes through `git` with `--no-optional-locks`, so reading never takes the index lock or triggers the folder watcher in a loop.
- The base is the merge-base of local `main`/`master` and `HEAD`.
- Limits:

  | Item | Cap |
  |---|---|
  | Commits | 500 |
  | Files | 1000 |
  | Diff lines per file | 1500 |

---

## 📁 Files

| File | Purpose |
|---|---|
| `main.js` | the mod |
| `mod.json` | placement (`none`) |
| `ai.svg`, `review.svg` | icons |
| `gpui-kit.d.ts`, `jsconfig.json` | editor types, rewritten by Herdr on start (safe to git-ignore) |

---

## 📄 License

Add a license before publishing, for example MIT.
