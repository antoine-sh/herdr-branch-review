import { exec } from "herdr";
import { readGit, worktrees } from "./git.js";
import { resolveConflicts } from "./resolve.js";

// Changing the repository: each operation resolves when done or throws git's own message.

async function git(args, cwd, on, timeout) {
  const r = await exec("git", args, { cwd, on, timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return r;
}

// Fetch only moves origin/* refs, never the working tree.
export const fetchRemote = (root, on) => git(["fetch", "--quiet"], root, on, 30000);

// One file (`path`), or everything (null).
export const stage = (root, on, path) => git(path ? ["add", "--", path] : ["add", "-A"], root, on);
export const unstage = (root, on, path) => git(["restore", "--staged", "--", path ?? "."], root, on);
// Staged and working-tree changes back to HEAD.
export const revert = (root, on, path) => git(["restore", "--source=HEAD", "--staged", "--worktree", "--", path ?? "."], root, on);

// Throw away working-tree changes: restore tracked files, delete untracked ones. One file, or all (null).
export async function discard(root, on, file) {
  const runs = file
    ? [file.fresh ? ["clean", "-f", "--", file.path] : ["restore", "--", file.path]]
    : [["restore", "--", "."], ["clean", "-fd"]];
  for (const args of runs) await git(args, root, on);
}

export const commit = (root, on, message) => git(["commit", "-m", message], root, on);

// Merge `branch` into local `base`. Base is usually checked out in another worktree: merge there.
// A conflict is resolved by AI (resolve.js); if that fails the merge is aborted and base is left as it was.
// Returns `{ after, stat, before, resolved }`: base's new short sha, the shortstat of what came in, its old short sha and the AI-resolved files.
export async function merge(root, on, base, branch) {
  const dir = (await worktrees(root, on)).find((w) => w.branch === base)?.path ?? null;
  const before = (await readGit(["rev-parse", base], root, on)).stdout.trim();
  let resolved = [];
  if (dir) {
    const st = await readGit(["status", "--porcelain", "--untracked-files=no"], dir, on);
    if (st.stdout.trim()) throw new Error(`${base} has uncommitted changes in ${dir}`);
    const r = await exec("git", ["merge", "--no-edit", branch], { cwd: dir, on });
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout).trim();
      try { resolved = await resolveConflicts(dir, on, base, branch); }
      catch (e) {
        await exec("git", ["merge", "--abort"], { cwd: dir, on });
        throw new Error(`${why}\nAI resolution failed (merge aborted): ${e?.message ?? e}`);
      }
    }
  } else {
    // base isn't checked out anywhere: only a fast-forward is possible.
    await git(["fetch", ".", `${branch}:${base}`], root, on);
  }
  const after = (await readGit(["rev-parse", "--short", base], root, on)).stdout.trim();
  const stat = (await readGit(["diff", "--shortstat", before, base], root, on)).stdout.trim();
  return { after, stat, resolved, before: before.slice(0, 8) };
}

// `merge`: the branch diverged from upstream, so merge it in; a conflict aborts and leaves the branch as it was.
export async function pull(root, on, merge) {
  const r = await exec("git", merge ? ["pull", "--no-rebase", "--no-edit"] : ["pull", "--ff-only"], { cwd: root, on, timeout: 120000 });
  if (r.code !== 0) {
    if (merge) await exec("git", ["merge", "--abort"], { cwd: root, on });
    throw new Error((r.stderr || r.stdout).trim());
  }
}

export const push = (root, on) => git(["push"], root, on, 120000);

// `offer`: a clean-up offer from loadRepo. Run from main's worktree.
// A lock (e.g. an agent session's) was shown in the offer, so confirming goes past it; removal still refuses uncommitted work.
export async function removeWorktree(offer, on) {
  if (offer.locked !== null) await git(["worktree", "unlock", offer.worktree], offer.mainDir, on);
  await git(["worktree", "remove", offer.worktree], offer.mainDir, on);
}
export const deleteBranch = (offer, on) => git(["branch", "-d", offer.branch], offer.mainDir, on);
