import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, home, watchFolder, theme, settings } from "herdr";

// Branch review: every commit and change of this worktree's branch against local main.

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Read-only git: no index refresh or lock, so the folder watch doesn't loop on our own reads.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

function parseNumstat(out) {
  const files = [];
  for (const entry of out.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    files.push({ path: parts.join("\t"), add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" });
  }
  return files;
}

const KEEP = ["root", "on", "base", "mbSha", "branch", "behind", "commits", "staged", "changes", "files", "dirty", "error", "sel", "kind", "open", "closed", "rows", "diffWidth", "note", "unpushed", "upBehind", "cleanup"];

export default class BranchReview extends View {
  init(_props, cx) {
    this.commits = []; this.files = []; this.staged = []; this.changes = []; this.kind = "changes"; this.rows = []; this.diffWidth = 0;
    this.watching = new Set(); this.fetchedAt = new Map(); this.saved = new Map();
    this.sel = null; // selected commit sha; null = whole branch + uncommitted
    this.message = "";
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    // One watcher per folder for the life of the mod, so coming back to a space reuses it.
    if (this.on || this.watching.has(root)) return;
    this.watching.add(root);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(root);
          if (this.root === root) this.refresh(cx);
        }
      } catch { this.watching.delete(root); }
    });
  }

  reset() {
    this.root = null; this.commits = []; this.files = []; this.staged = []; this.changes = []; this.kind = "changes"; this.open = null; this.sel = null;
    this.setLines([]); this.error = null; this.base = null; this.branch = "";
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      // Each space keeps its own view: park the old one, bring back this one's (refreshed below).
      if (this.context) this.saved.set(this.context, Object.fromEntries(KEEP.map((k) => [k, this[k]])));
      this.context = context;
      const back = this.saved.get(context);
      if (back) Object.assign(this, back); else { this.reset(); this.closed = false; }
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.reset(); this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        // Local main (or master), never origin/*.
        let base = null;
        for (const b of ["main", "master"]) if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])).code === 0) { base = b; break; }
        if (!base) { this.reset(); this.root = root; this.error = "No local main or master branch"; return; }
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
        if (key() !== context) return;
        Object.assign(this, { root, on, base, mbSha, branch: br.stdout.trim() || "(detached)", behind: Number(behind.stdout) || 0, unpushed: ahead.code === 0 ? Number(ahead.stdout) || 0 : null, upBehind: upBehind.code === 0 ? Number(upBehind.stdout) || 0 : null, commits, staged: staged.slice(0, 1000), changes: changes.slice(0, 1000), dirty: ents.length, error: null });
        this.watch(root, cx);
        this.autoFetch(cx);
        if (this.sel && !commits.some((c) => c.sha === this.sel)) this.sel = null;
        await this.loadFiles(context);
        this.reconcile();
        if (this.open) { try { await this.loadDiff(this.open, context); } catch { if (key() === context) this.setLines(["Cannot preview this diff"]); } }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Fetch only moves origin/* refs, never the working tree. Automatic at most every 5 minutes per repo.
  autoFetch(cx) {
    if (!this.root || Date.now() - (this.fetchedAt.get(this.root) ?? 0) < 300000) return;
    this.fetch(cx);
  }

  fetch(cx) {
    if (!this.root || this.fetching) return;
    const { root, on } = this, context = this.context;
    this.fetching = true; this.fetchedAt.set(root, Date.now());
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["fetch", "--quiet"], { cwd: root, on, timeout: 30000 });
        if (r.code !== 0 && key() === context && this.manualFetch) this.note = `Fetch failed: ${(r.stderr || r.stdout).trim()}`;
      } catch (e) { if (key() === context && this.manualFetch) this.note = `Fetch failed: ${e}`; }
      finally { this.fetching = false; this.manualFetch = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  list(kind) { return kind === "staged" ? this.staged : kind === "changes" ? this.changes : this.files; }

  // Keep the open file valid: follow it between Staged and Changes, else fall back to the first file.
  reconcile() {
    if (this.sel && this.kind !== "commit") { this.kind = "commit"; this.open = null; this.setLines([]); }
    if (!this.sel && this.kind === "commit") { this.kind = "changes"; this.open = null; this.setLines([]); }
    if (this.open && !this.list(this.kind).some((f) => f.path === this.open)) {
      const other = this.sel ? null : ["staged", "changes"].find((k) => k !== this.kind && this.list(k).some((f) => f.path === this.open));
      if (other) this.kind = other; else { this.open = null; this.setLines([]); }
    }
    if (!this.open && !this.closed) {
      const kind = this.sel ? "commit" : this.staged.length ? "staged" : "changes", f = this.list(kind)[0];
      if (f) { this.kind = kind; this.open = f.path; }
    }
  }

  async loadFiles(context) {
    if (!this.sel) { this.files = []; return; }
    const r = await exec("git", [...READ, "show", "--format=", "--numstat", "-z", "--no-renames", this.sel], { cwd: this.root, on: this.on });
    if (key() !== context) return;
    this.files = r.code === 0 ? parseNumstat(r.stdout).map((f) => ({ ...f, status: "M" })) : [];
  }

  async loadDiff(path, context) {
    const kind = this.kind, file = this.list(kind).find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map((l) => `+${l}`)];
      }
    } else {
      const args = kind === "commit" ? ["show", "--format=", this.sel] : kind === "staged" ? ["diff", "--cached"] : ["diff"];
      const r = await exec("git", [...READ, ...args, "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path && this.kind === kind) this.setLines(lines.slice(0, 1500).map((l) => l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map((l) => l.length * 7 + 50));
  }

  pickCommit(sha, cx) {
    this.sel = this.sel === sha ? null : sha; this.kind = this.sel ? "commit" : "changes"; this.open = null; this.closed = false; this.setLines([]); this.files = [];
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        await this.loadFiles(context);
        this.reconcile();
        if (this.open) await this.loadDiff(this.open, context);
      } catch { this.setLines(["Cannot preview this diff"]); }
      cx.notify();
    });
    cx.notify();
  }

  stage(args, cx) {
    if (!this.root) return;
    const { root, on } = this;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: root, on });
        if (r.code !== 0) this.error = (r.stderr || r.stdout).trim();
      } catch (e) { this.error = String(e); }
      this.loading = false; this.refresh(cx); cx.notify();
    });
  }

  // Commit what is staged.
  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || !this.staged.length) return;
    const { root, on } = this, context = this.context, message = this.message.trim();
    this.busy = "commit"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Ask Haiku for a commit message from the staged diff .
  generate(cx) {
    if (!this.root || this.busy || this.loading || !this.staged.length) return;
    const { root, on } = this, context = this.context;
    this.busy = "ai"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const d = await exec("git", [...READ, "diff", "--cached", "--no-ext-diff", "--no-color"], { cwd: root, on });
        if (d.code !== 0) throw new Error(d.stderr.trim());
        const diff = d.stdout.slice(0, 40000);
        if (!diff.trim()) throw new Error("no text changes to describe");
        // Project and global instructions: their commit-message rules win over the defaults below.
        const h = (await home()).replace(/\/$/, ""), docs = [];
        for (const [label, path, remote] of [["Global", `${h}/.claude/CLAUDE.md`], ["Global", `${h}/.claude/AGENTS.md`], ["Global", `${h}/AGENTS.md`], ["Project", `${root}/CLAUDE.md`, true], ["Project", `${root}/AGENTS.md`, true]]) {
          const text = await readTextFile(path, remote ? { on } : {}).catch(() => null);
          if (text?.trim()) docs.push(`### ${label} instructions (${path})\n${text.slice(0, 8000)}`);
        }
        const rules = docs.length ? `\n\nFollow any commit message conventions in these instruction files (format, language, prefixes, trailers, length); ignore everything unrelated to commit messages. Project rules override global ones.\n\n${docs.join("\n\n")}` : "";
        const prompt = "Write a git commit message for the diff below: by default a concise imperative subject line (max 72 chars), then optionally a blank line and a short body. Reply with the message only, no quotes or code fences." + rules + "\n\n### Diff\n" + diff;
        const r = await exec("claude", ["-p", "--model", "haiku", "--no-session-persistence", "--disable-slash-commands", "--tools=", "--setting-sources", "", "--strict-mcp-config", "--system-prompt", "You write git commit messages. Reply with the message only.", "--", prompt], { cwd: root, on, timeout: 90000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        const msg = r.stdout.trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
        if (!msg) throw new Error("empty reply");
        if (key() === context) { this.message = msg; this.input.set_value(msg); }
      } catch (e) { if (key() === context) this.note = `Message generation failed: ${e}`; }
      finally { this.busy = null; cx.notify(); }
    });
    cx.notify();
  }

  canMerge() { return Boolean(this.root && this.base && this.branch && this.branch !== "(detached)" && this.branch !== this.base && this.commits.length > 0 && !this.dirty && !this.busy); }

  // Merge this branch into local main. Main is usually checked out in another worktree: merge there.
  // One click, no confirmation: the outcome is shown in the note afterwards.
  merge(cx) {
    if (!this.canMerge()) return;
    const { root, on, base, branch } = this, context = this.context, count = this.commits.length;
    this.busy = "merge"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const wt = await exec("git", [...READ, "worktree", "list", "--porcelain"], { cwd: root, on });
        let dir = null, cur = null;
        for (const l of wt.stdout.split("\n")) {
          if (l.startsWith("worktree ")) cur = l.slice(9);
          else if (l === `branch refs/heads/${base}`) dir = cur;
        }
        const before = (await exec("git", [...READ, "rev-parse", base], { cwd: root, on })).stdout.trim();
        let r;
        if (dir) {
          const st = await exec("git", [...READ, "status", "--porcelain", "--untracked-files=no"], { cwd: dir, on });
          if (st.stdout.trim()) throw new Error(`${base} has uncommitted changes in ${dir}`);
          r = await exec("git", ["merge", branch], { cwd: dir, on });
          if (r.code !== 0) { await exec("git", ["merge", "--abort"], { cwd: dir, on }); throw new Error((r.stderr || r.stdout).trim()); }
        } else {
          // main isn't checked out anywhere: only a fast-forward is possible.
          r = await exec("git", ["fetch", ".", `${branch}:${base}`], { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        const after = (await exec("git", [...READ, "rev-parse", "--short", base], { cwd: root, on })).stdout.trim();
        const stat = (await exec("git", [...READ, "diff", "--shortstat", before, base], { cwd: root, on })).stdout.trim();
        if (key() === context && dir && dir !== root) this.cleanup = { branch, worktree: root, mainDir: dir };
        if (key() === context) this.note = `Merged ${branch} into ${base} (${count} commit${count === 1 ? "" : "s"}, now at ${after})${stat ? " · " + stat : ""}`;
      } catch (e) { if (key() === context) this.note = `Merge failed: ${e}`; }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // After a merge from a linked worktree: remove that worktree and delete the merged branch (from main's worktree).
  cleanUp(cx) {
    const c = this.cleanup, { on } = this, context = this.context;
    if (!c || this.busy) return;
    this.busy = "cleanup"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["worktree", "remove", c.worktree], ["branch", "-d", c.branch]]) {
          const r = await exec("git", args, { cwd: c.mainDir, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.cleanup = null; this.note = `Deleted branch ${c.branch} and its worktree`; }
      } catch (e) { if (key() === context) this.note = `Clean-up failed: ${e}`; }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  onBase() { return Boolean(this.root && this.base && this.branch === this.base); }

  // On main there is nothing to merge into: push it instead.
  diverged() { return this.upBehind > 0 && this.unpushed > 0; }
  canPull() { return this.onBase() && !this.busy && this.upBehind > 0 && !this.dirty; }
  canPush() { return this.onBase() && !this.busy && this.unpushed !== 0 && !(this.upBehind > 0); }

  pull(cx) {
    if (!this.canPull()) return;
    const { root, on, branch } = this, context = this.context, merge = this.diverged();
    this.busy = "pull"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", merge ? ["pull", "--no-rebase", "--no-edit"] : ["pull", "--ff-only"], { cwd: root, on, timeout: 120000 });
        if (r.code !== 0) {
          if (merge) await exec("git", ["merge", "--abort"], { cwd: root, on }); // conflicts: leave main as it was
          throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) this.note = merge ? `Pulled and merged origin into ${branch}` : `Pulled ${branch}`;
      } catch (e) { if (key() === context) this.note = `${merge ? "Pull and merge" : "Pull"} failed${merge ? " (aborted, main unchanged)" : ""}: ${e}`; }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  push(cx) {
    if (!this.canPush()) return;
    const { root, on, branch } = this, context = this.context;
    this.busy = "push"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["push"], { cwd: root, on, timeout: 120000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        if (key() === context) this.note = `Pushed ${branch}`;
      } catch (e) { if (key() === context) this.note = `Push failed: ${e}`; }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Throw away working-tree changes: restore tracked files, delete untracked ones. One file, or all (null).
  discard(file, cx) {
    if (!this.root) return;
    const { root, on } = this;
    cx.spawn(async (cx) => {
      try {
        const runs = file
          ? [file.fresh ? ["clean", "-f", "--", file.path] : ["restore", "--", file.path]]
          : [["restore", "--", "."], ["clean", "-fd"]];
        for (const args of runs) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) { this.error = (r.stderr || r.stdout).trim(); break; }
        }
      } catch (e) { this.error = String(e); }
      this.loading = false; this.refresh(cx); cx.notify();
    });
  }

  pickFile(path, cx, kind) {
    const same = this.open === path && this.kind === kind;
    this.kind = kind; this.open = same ? null : path; this.closed = !this.open; this.setLines([]);
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.loadDiff(path, context); } catch { this.setLines(["Cannot preview this diff"]); }
      cx.notify();
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // A full-width strip that names each section, in its own color: committed (accent), uncommitted (amber), diff (muted).
  banner(t, color, title, count, caption, right) {
    return h_flex().h(28).flex_none().px(12).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
      .child(div().w(3).h(12).rounded(2).flex_none().bg(color))
      .child(div().text_size(10).font_semibold().text_color(color).flex_none().child(title.toUpperCase()))
      .when(count !== null, (e) => e.child(div().px(5).rounded(8).bg(t.background).text_size(10).text_color(t.muted).child(String(count))))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(caption))
      .when(Boolean(right), (e) => e.child(right));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const btn = (id, label, onTap, dbl, tip) => div().id(id).h(20).min_w(20).px(6).flex().items_center().justify_center().rounded(5).flex_none().text_size(12).text_color(dbl && this.armed === id ? t.ansi1 : t.muted).cursor_pointer()
      .when(dbl && this.armed === id, (e) => e.bg(t.ansi1 + "30")).hover((s) => s.bg(dbl && this.armed === id ? t.ansi1 + "40" : t.hover)).on_mouse_down("left", stop).on_click((e, cx) => { cx.stop_propagation(); if (!dbl) return onTap(cx); if (this.armed === id) { this.armed = null; onTap(cx); } else { this.armed = id; cx.notify(); cx.timer.after(1000, (cx) => { if (this.armed === id) { this.armed = null; cx.notify(); } }); } }).child(label);
    const empty = (msg) => div().p(8).text_color(t.dim).child(msg);
    const section = (id, color, title, list, caption, kind, right, action) => {
      const add = list.reduce((n, f) => n + f.add, 0), del = list.reduce((n, f) => n + f.del, 0);
      return v_flex().flex_none().border_b(1).border_color(t.border)
        .child(this.banner(t, color, title, list.length, caption,
          h_flex().gap(8).items_center().text_size(11).child(div().text_color(t.ansi2).child(`+${add}`)).child(div().text_color(t.ansi1).child(`−${del}`)).when(Boolean(right), (e) => e.child(right))))
        .child(div().flex_none().h(list.length ? Math.min(list.length * 28 + 12, 170) : 36).relative()
          .child(v_flex().id(`br-${id}`).absolute().inset_0().overflow_y_scroll().p(6).children(list.map((f) => {
            const parts = f.path.split("/"), name = parts.pop();
            return h_flex().id(`br-${id}-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path && this.kind === kind, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pickFile(f.path, cx, kind))
              .child(div().w(14).text_size(11).text_color(f.status === "A" || f.status === "U" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked).child(f.status))
              .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
              .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
              .children((action ?? []).map((a) => btn(`${id}-${a.label}-${f.path}`, a.label, (cx) => a.run(f, cx), a.dbl)));
          })).when(!list.length, () => empty(this.error ? "" : this.loading ? "Loading…" : kind === "commit" ? "No files" : "No pending changes")))
          .child(Scrollbar.vertical(`br-${id}`).absolute().inset_0()));
    };
    const canCommit = Boolean(this.message.trim() && this.staged.length && !this.busy && !this.loading), canMerge = this.canMerge(), canAi = Boolean(this.staged.length && !this.busy && !this.loading);
    const title = this.base ? `${this.branch} ↔ ${this.base}` : "Branch review";
    return v_flex().id("branch-review").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().truncate().child(title))
        .when(Boolean(this.base), (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.commits.length} ahead · ${this.behind} behind`)))
        .when(this.dirty > 0, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.blocked).child(`${this.dirty} uncommitted`)))
        .when(this.upBehind > 0, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.accent).child(`↓${this.upBehind} upstream`)))
        .child(div().flex_1())
        .child(btn("fetch", this.fetching ? "Fetching…" : "↻ Fetch", (cx) => { this.manualFetch = true; this.fetchedAt.delete(this.root); this.fetch(cx); })))
      // Commits: history, drawn as a timeline
      .child(v_flex().flex_none().border_b(1).border_color(t.border)
        .child(this.banner(t, t.accent, "Committed", this.commits.length, this.sel ? "one commit selected · click it again for all" : `on ${this.branch || "branch"}, ahead of ${this.base ?? "main"} · click to inspect`))
        .child(div().flex_none().h(this.commits.length ? Math.min(this.commits.length * 46 + 12, 220) : 36).relative()
          .child(v_flex().id("br-commits").absolute().inset_0().overflow_y_scroll().p(6)
            .children(this.commits.map((c, i) =>
              h_flex().id(`br-c-${c.sha}`).h(46).flex_none().px(8).gap(10).items_center().rounded(7).cursor_pointer().when(this.sel === c.sha, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pickCommit(c.sha, cx))
                .child(div().w(10).h_full().flex_none().relative()
                  .when(i < this.commits.length - 1, (e) => e.child(div().absolute().left(4).top(23).bottom(-23).w(2).bg(t.border)))
                  .child(div().absolute().top(18).left(0).w(10).h(10).rounded(5).border_2().border_color(t.accent).bg(this.sel === c.sha ? t.accent : t.background)))
                .child(v_flex().flex_1().min_w(0).child(div().truncate().child(c.subject))
                  .child(h_flex().gap(8).text_size(11).text_color(t.dim).child(div().text_color(t.accent).font_family("JetBrains Mono").child(c.short)).child(div().truncate().child(c.author)).child(div().flex_none().child(c.when))))))
            .when(!this.commits.length, () => empty(this.error || (this.loading ? "Loading…" : this.base ? `No commits ahead of ${this.base}` : "No folder"))))
          .child(Scrollbar.vertical("br-commits").absolute().inset_0())))
      // Staged / Changes (or the selected commit's files)
      .children(this.sel
        ? [section("commit", t.muted, "Files changed", this.files, `in ${(this.commits.find((c) => c.sha === this.sel) ?? {}).short ?? "commit"} only`, "commit")]
        : [
          ...(this.staged.length ? [section("staged", t.ansi2, "Staged changes", this.staged, "ready to commit", "staged", h_flex().gap(4).child(btn("unstage-all", "− Unstage all", (cx) => this.stage(["restore", "--staged", "--", "."], cx))).child(btn("discard-staged", "Discard all", (cx) => this.stage(["restore", "--source=HEAD", "--staged", "--worktree", "--", "."], cx), true)),
            [{ label: "−", run: (f, cx) => this.stage(["restore", "--staged", "--", f.path], cx) },
             { label: "⟲", dbl: true, run: (f, cx) => this.stage(["restore", "--source=HEAD", "--staged", "--worktree", "--", f.path], cx) }])] : []),
          section("changes", t.blocked, "Changes", this.changes, "working tree · not staged", "changes", this.changes.length ? h_flex().gap(4).child(btn("stage-all", "+ Stage all", (cx) => this.stage(["add", "-A"], cx))).child(btn("discard-all", "Discard all", (cx) => this.discard(null, cx), true)) : null,
            [{ label: "+", run: (f, cx) => this.stage(["add", "--", f.path], cx) },
             { label: "⟲", dbl: true, run: (f, cx) => this.discard(f, cx) }])])
      // Diff
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("br-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("br-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("br-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.list(this.kind).length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().flex_none().px(10).pt(8).text_size(11).text_color(/^(Merged|Pushed|Pulled|Deleted)/.test(this.note) ? t.ansi2 : t.ansi1).child(this.note)))
      .when(Boolean(this.cleanup), (e) => e.child(div().flex_none().px(10).pt(8).child(h_flex().px(10).py(6).gap(8).items_center().rounded(8).border_1().border_color(t.border).bg(t.raised).text_size(11)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`Merged. Delete branch ${this.cleanup.branch} and its worktree?`))
        .child(btn("cleanup-yes", this.busy === "cleanup" ? "Deleting…" : "Delete", (cx) => this.cleanUp(cx)))
        .child(btn("cleanup-no", "Keep", (cx) => { this.cleanup = null; cx.notify(); })))))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("br-commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", stop).child(Input.new(this.input).h_full().flex_1().min_w(0).text_size(12).text_color(t.foreground))
          .child(div().id("br-ai").h(20).w(20).ml(6).flex().items_center().justify_center().flex_none().rounded(5).text_color(canAi ? t.accent : t.dim).when(canAi, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.generate(cx); }).child((this.busy === "ai" ? svg("mods/branch-review/ai.svg").spin(900) : svg("mods/branch-review/ai.svg")).size(14).flex_none())))
        .child(div().id("br-commit").h(32).px(14).flex().items_center().flex_none().rounded(8).bg(canCommit ? t.solid : t.raised).text_color(canCommit ? t.solid_foreground : t.dim).text_size(12).when(canCommit, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy === "commit" ? "Committing…" : "Commit"))
        .child(this.onBase()
          ? (this.upBehind > 0
            ? div().id("br-push").h(32).px(14).flex().items_center().flex_none().rounded(8).border_1().border_color(this.diverged() ? t.ansi1 : t.border).bg(this.canPull() ? t.raised : t.background).text_color(this.canPull() ? t.foreground : t.dim).text_size(12).when(this.canPull(), (e) => e.cursor_pointer()).on_click((_e, cx) => this.pull(cx)).child(this.busy === "pull" ? "Pulling…" : this.dirty ? `Pull ${this.base} (commit or discard first)` : this.diverged() ? `Diverged: pull & merge (${this.upBehind}↓ ${this.unpushed}↑)` : `Pull ${this.base} (${this.upBehind})`)
            : div().id("br-push").h(32).px(14).flex().items_center().flex_none().rounded(8).border_1().border_color(this.diverged() ? t.ansi1 : t.border).bg(this.canPush() ? t.raised : t.background).text_color(this.diverged() ? t.ansi1 : this.canPush() ? t.foreground : t.dim).text_size(12).when(this.canPush(), (e) => e.cursor_pointer()).on_click((_e, cx) => this.push(cx)).child(this.busy === "push" ? "Pushing…" : this.diverged() ? `${this.base} diverged: rebase or merge manually` : this.unpushed ? `Push ${this.base} (${this.unpushed})` : `Push ${this.base}`))
          : div().id("br-merge").h(32).px(14).flex().items_center().flex_none().rounded(8).border_1().border_color(t.border).bg(canMerge ? t.raised : t.background).text_color(canMerge ? t.foreground : t.dim).text_size(12).when(canMerge, (e) => e.cursor_pointer()).on_click((_e, cx) => this.merge(cx)).child(this.busy === "merge" ? "Merging…" : `Merge to ${this.base ?? "main"}`)));
  }
}
