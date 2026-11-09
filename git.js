import { exec, readTextFile } from "herdr";

// Reading the repository: never changes anything, returns plain data.

// Read-only git: no index refresh or lock, so the folder watch doesn't loop on our own reads.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const readGit = (args, cwd, on) => exec("git", [...READ, ...args], { cwd, on });

const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

function parseNumstat(out) {
  const files = [];
  for (const entry of out.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    files.push({ path: parts.join("\t"), add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" });
  }
  return files;
}

// `git worktree list --porcelain` → [{ path, branch, locked }] (locked: the reason, "" when none given, or null).
export async function worktrees(cwd, on) {
  const r = await readGit(["worktree", "list", "--porcelain"], cwd, on), list = [];
  for (const l of r.stdout.split("\n")) {
    if (l.startsWith("worktree ")) list.push({ path: l.slice(9), branch: null, locked: null });
    else if (!list.length) continue;
    else if (l.startsWith("branch refs/heads/")) list.at(-1).branch = l.slice(18);
    else if (l === "locked" || l.startsWith("locked ")) list.at(-1).locked = l.slice(7);
  }
  return list;
}

// Everything the panel shows about the repository at `cwd`, as one snapshot.
// `{ error, root? }` when there is nothing to review; throws when git fails unexpectedly.
// `dismissed`: "worktree\nbranch" keys whose clean-up offer the person turned down.
export async function loadRepo(cwd, on, dismissed) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  if (top.code !== 0) return { error: "Not a git repository" };
  const root = top.stdout.trim(), git = (args) => readGit(args, root, on);
  // Local main (or master), never origin/*.
  let base = null;
  for (const b of ["main", "master"]) if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).code === 0) { base = b; break; }
  if (!base) return { root, error: "No local main or master branch" };
  const br = await git(["branch", "--show-current"]);
  const mb = await git(["merge-base", base, "HEAD"]);
  if (mb.code !== 0) throw new Error(mb.stderr.trim() || "no merge base");
  const mbSha = mb.stdout.trim();
  const behind = await git(["rev-list", "--count", `HEAD..${base}`]);
  const ahead = await git(["rev-list", "--count", "@{u}..HEAD"]); // fails without an upstream: unknown
  const upBehind = await git(["rev-list", "--count", "HEAD..@{u}"]);
  const log = await git(["log", "--no-color", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar", `${mbSha}..HEAD`]);
  if (log.code !== 0) throw new Error(log.stderr);
  const commits = log.stdout.split("\n").filter(Boolean).slice(0, 500).map((l) => {
    const [sha, short, subject, author, when] = l.split("\x1f");
    return { sha, short, subject, author, when };
  });
  // Pending changes, as in VS Code: staged (index vs HEAD) and changes (working tree vs index, plus untracked).
  const nums = async (args) => { const r = await git(args); if (r.code !== 0) throw new Error(r.stderr); return new Map(parseNumstat(r.stdout).map((f) => [f.path, f])); };
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  if (status.code !== 0) throw new Error(status.stderr);
  const stNum = await nums(["diff", "--cached", "--numstat", "-z", "--no-renames"]), chNum = await nums(["diff", "--numstat", "-z", "--no-renames"]);
  const ents = status.stdout.split("\0").filter(Boolean), staged = [], changes = [];
  for (const e of ents) {
    const x = e[0], y = e[1], path = e.slice(3);
    if (x === "!") continue;
    if (x === "?") { changes.push({ path, status: "U", fresh: true, add: 0, del: 0 }); continue; }
    if (x !== " ") staged.push({ add: 0, del: 0, ...stNum.get(path), path, status: x });
    if (y !== " ") changes.push({ add: 0, del: 0, ...chNum.get(path), path, status: y });
  }
  // A linked worktree whose branch had commits of its own, now all in main and nothing pending:
  // offer to remove it, however it was merged (this mod, a terminal, an agent).
  const name = br.stdout.trim();
  let cleanup = null;
  if (name && name !== base && !commits.length && !ents.length && !dismissed.has(`${root}\n${name}`)) {
    const [gitDir, common] = (await git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])).stdout.trim().split("\n");
    const own = gitDir && common && gitDir !== common ? (await git(["reflog", "show", "--format=%H", `refs/heads/${name}`])).stdout.split("\n").filter(Boolean).length : 0;
    if (own > 1) {
      const list = await worktrees(root, on), main = list.find((w) => w.branch === base), here = list.find((w) => w.path === root);
      if (main && main.path !== root) cleanup = { branch: name, worktree: root, mainDir: main.path, locked: here?.locked ?? null };
    }
  }
  return {
    root, base, mbSha, branch: name || "(detached)", behind: Number(behind.stdout) || 0,
    unpushed: ahead.code === 0 ? Number(ahead.stdout) || 0 : null, upBehind: upBehind.code === 0 ? Number(upBehind.stdout) || 0 : null,
    commits, staged: staged.slice(0, 1000), changes: changes.slice(0, 1000), dirty: ents.length, cleanup,
  };
}

// The files one commit touched.
export async function commitFiles(root, on, sha) {
  const r = await readGit(["show", "--format=", "--numstat", "-z", "--no-renames", sha], root, on);
  return r.code === 0 ? parseNumstat(r.stdout).map((f) => ({ ...f, status: "M" })) : [];
}

// The diff lines of one file in a list (`kind`: commit `sha`, staged or changes), capped for display.
// An untracked file shows whole, as added; its `add` count is filled in on the way.
export async function diffLines(file, kind, sha, root, on) {
  let lines;
  if (file.fresh) {
    const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
    if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
    else if (text.includes("\0")) lines = ["Binary file · no text diff"];
    else {
      file.add = countLines(text);
      lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map((l) => `+${l}`)];
    }
  } else {
    const args = kind === "commit" ? ["show", "--format=", sha] : kind === "staged" ? ["diff", "--cached"] : ["diff"];
    const r = await readGit([...args, "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path], root, on);
    if (r.code !== 0) throw new Error(r.stderr);
    const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
  }
  return lines.slice(0, 1500).map((l) => l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l);
}
