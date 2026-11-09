import { View } from "gpui-kit";
import { v_flex, InputState } from "gpui-base";
import { run, watchFolder, theme } from "herdr";
import { location, contextKey, worktreeSpaces } from "./context.js";
import { loadRepo, commitFiles, diffLines } from "./git.js";
import * as ops from "./ops.js";
import { generateMessage } from "./message.js";
import { diffRows, diffWidth, diffPane } from "./diff.js";
import { header, commitList, fileSections, notices, footer } from "./ui.js";

// Branch review: every commit and change of this worktree's branch against local main.
// This file holds the panel's state and how it changes; reading git is in git.js, changing it in ops.js,
// where to look in context.js, and drawing in ui.js and diff.js.

// What each location parks when the panel moves to another, and gets back on return.
const KEEP = ["root", "on", "base", "mbSha", "branch", "behind", "commits", "staged", "changes", "files", "dirty", "error", "sel", "kind", "open", "closed", "rows", "diffWidth", "note", "unpushed", "upBehind", "cleanup"];
const reason = (e) => e instanceof Error ? e.message : String(e);

export default class BranchReview extends View {
  init(_props, cx) {
    this.commits = []; this.files = []; this.staged = []; this.changes = []; this.kind = "changes"; this.rows = []; this.diffWidth = 0;
    this.watching = new Set(); this.fetchedAt = new Map(); this.saved = new Map(); this.dismissed = new Set();
    this.sel = null; // selected commit sha; null = whole branch + uncommitted
    this.message = "";
    this.focus = cx.focus_handle();
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

  // ── Loading ─────────────────────────────────────────────────────────────

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

  // Clear the repository view. The note and clean-up offer survive (a clean-up removes the folder we show).
  reset() {
    Object.assign(this, { root: null, base: null, mbSha: null, branch: "", behind: 0, unpushed: null, upBehind: null, dirty: 0, error: null,
      commits: [], files: [], staged: [], changes: [], kind: "changes", open: null, sel: null });
    this.setLines([]);
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location(), context = contextKey();
    if (context !== this.context) {
      // Each space keeps its own view: park the old one, bring back this one's (refreshed below).
      if (this.context) this.saved.set(this.context, Object.fromEntries(KEEP.map((k) => [k, this[k]])));
      this.context = context;
      const back = this.saved.get(context);
      if (back) Object.assign(this, back); else { this.reset(); this.closed = false; this.note = null; this.cleanup = null; }
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const repo = await loadRepo(cwd, on, this.dismissed);
        if (contextKey() !== context) return;
        if (repo.error) { this.reset(); this.root = repo.root ?? null; this.error = repo.error; return; }
        const { cleanup, ...state } = repo;
        if (this.busy !== "cleanup") this.cleanup = cleanup;
        Object.assign(this, state, { on, error: null });
        this.watch(this.root, cx);
        this.autoFetch(cx);
        if (this.sel && !this.commits.some((c) => c.sha === this.sel)) this.sel = null;
        await this.loadFiles(context);
        this.reconcile();
        if (this.open) { try { await this.loadDiff(this.open, context); } catch { if (contextKey() === context) this.setLines(["Cannot preview this diff"]); } }
      } catch (e) { if (contextKey() === context) this.error = String(e); }
      finally {
        this.loading = false;
        if (this.again) { this.again = false; this.refresh(cx); }
        cx.notify();
      }
    });
  }

  // Automatic fetch: at most every 5 minutes per repo.
  autoFetch(cx) {
    if (!this.root || Date.now() - (this.fetchedAt.get(this.root) ?? 0) < 300000) return;
    this.fetch(cx);
  }

  // The Fetch button: now, and report a failure.
  fetchNow(cx) {
    this.manualFetch = true; this.fetchedAt.delete(this.root); this.fetch(cx);
  }

  fetch(cx) {
    if (!this.root || this.fetching) return;
    const { root, on } = this, context = this.context;
    this.fetching = true; this.fetchedAt.set(root, Date.now());
    cx.spawn(async (cx) => {
      try { await ops.fetchRemote(root, on); }
      catch (e) { if (contextKey() === context && this.manualFetch) this.note = `Fetch failed: ${reason(e)}`; }
      finally { this.fetching = false; this.manualFetch = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  async loadFiles(context) {
    if (!this.sel) { this.files = []; return; }
    const files = await commitFiles(this.root, this.on, this.sel);
    if (contextKey() === context) this.files = files;
  }

  async loadDiff(path, context) {
    const kind = this.kind, file = this.list(kind).find((f) => f.path === path);
    if (!file) return;
    const lines = await diffLines(file, kind, this.sel, this.root, this.on);
    if (contextKey() === context && this.open === path && this.kind === kind) this.setLines(lines);
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = diffWidth(lines);
  }

  // ── Selection ───────────────────────────────────────────────────────────

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

  pickCommit(sha, cx) {
    this.focus.focus();
    this.sel = this.sel === sha ? null : sha; this.kind = this.sel ? "commit" : "changes"; this.open = null; this.closed = false; this.setLines([]); this.files = [];
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        await this.loadFiles(context);
        this.reconcile();
        if (this.open) await this.loadDiff(this.open, context);
      } catch { if (contextKey() === context) this.setLines(["Cannot preview this diff"]); }
      cx.notify();
    });
    cx.notify();
  }

  pickFile(path, cx, kind) {
    this.focus.focus();
    const same = this.open === path && this.kind === kind;
    this.kind = kind; this.open = same ? null : path; this.closed = !this.open; this.setLines([]);
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.loadDiff(path, context); } catch { if (contextKey() === context) this.setLines(["Cannot preview this diff"]); }
      cx.notify();
    });
    cx.notify();
  }

  // Enter on the selected file: open it in neovim in a new tab.
  openInNvim() {
    if (!this.root || !this.open) return;
    run("tab.new", { name: this.open.split("/").pop(), folder: this.root, argv: ["nvim", `${this.root}/${this.open}`] });
  }

  // ── File actions: quick, no busy state; a failure lands in the note ─────

  change(label, op, cx) {
    if (!this.root) return;
    const { root, on } = this;
    cx.spawn(async (cx) => {
      try { await op(root, on); } catch (e) { this.note = `${label} failed: ${reason(e)}`; }
      this.refresh(cx); cx.notify();
    });
  }
  // One file (path), or all (null).
  stage(path, cx) { this.change("git add", (root, on) => ops.stage(root, on, path), cx); }
  unstage(path, cx) { this.change("git restore", (root, on) => ops.unstage(root, on, path), cx); }
  revert(path, cx) { this.change("git restore", (root, on) => ops.revert(root, on, path), cx); }
  discard(file, cx) { this.change("Discard", (root, on) => ops.discard(root, on, file), cx); }

  // ── Branch actions: one at a time (`busy`) ──────────────────────────────

  // Run `work(here)`; the note it returns, or its failure under `failed`, is shown if the panel still looks here.
  act(busy, failed, work, cx, { refresh = true, after } = {}) {
    const context = this.context, here = () => contextKey() === context;
    this.busy = busy; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const note = await work(here);
        if (note && here()) this.note = note;
      } catch (e) { if (here()) this.note = `${failed}: ${reason(e)}`; }
      finally { this.busy = null; after?.(); if (refresh) this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  canCommit() { return Boolean(this.message.trim() && this.staged.length && !this.busy && !this.loading); }
  canGenerate() { return Boolean(this.root && this.staged.length && !this.busy && !this.loading); }
  canMerge() { return Boolean(this.root && this.base && this.branch && this.branch !== "(detached)" && this.branch !== this.base && this.commits.length > 0 && !this.dirty && !this.busy); }
  onBase() { return Boolean(this.root && this.base && this.branch === this.base); }
  // On main there is nothing to merge into: pull or push it instead.
  diverged() { return this.upBehind > 0 && this.unpushed > 0; }
  canPull() { return this.onBase() && !this.busy && this.upBehind > 0 && !this.dirty; }
  canPush() { return this.onBase() && !this.busy && this.unpushed !== 0 && !(this.upBehind > 0); }

  // Commit what is staged.
  commit(cx) {
    if (!this.canCommit() || !this.root) return;
    const { root, on } = this, message = this.message.trim();
    this.act("commit", "Commit failed", async (here) => {
      await ops.commit(root, on, message);
      if (here()) { this.message = ""; this.input.set_value(""); }
    }, cx);
  }

  // Ask Haiku for a commit message from the staged diff.
  generate(cx) {
    if (!this.canGenerate()) return;
    const { root, on } = this;
    this.act("ai", "Message generation failed", async (here) => {
      const msg = await generateMessage(root, on);
      if (here()) { this.message = msg; this.input.set_value(msg); }
    }, cx, { refresh: false });
  }

  // Merge this branch into local main. One click, no confirmation: the outcome is shown in the note afterwards.
  merge(cx) {
    if (!this.canMerge()) return;
    const { root, on, base, branch } = this, count = this.commits.length;
    this.act("merge", "Merge failed", async () => {
      const { after, stat } = await ops.merge(root, on, base, branch);
      return `Merged ${branch} into ${base} (${count} commit${count === 1 ? "" : "s"}, now at ${after})${stat ? " · " + stat : ""}`;
    }, cx);
  }

  pull(cx) {
    if (!this.canPull()) return;
    const { root, on, branch } = this, merge = this.diverged();
    this.act("pull", merge ? "Pull and merge failed (aborted, main unchanged)" : "Pull failed", async () => {
      await ops.pull(root, on, merge);
      return merge ? `Pulled and merged origin into ${branch}` : `Pulled ${branch}`;
    }, cx);
  }

  push(cx) {
    if (!this.canPush()) return;
    const { root, on, branch } = this;
    this.act("push", "Push failed", async () => { await ops.push(root, on); return `Pushed ${branch}`; }, cx);
  }

  // After a merge from a linked worktree: remove that worktree and delete the merged branch (from main's worktree).
  cleanUp(cx) {
    const c = this.cleanup, { on } = this;
    if (!c || this.busy) return;
    // Spaces that only work in this worktree go with it (picked now, while their folders still exist).
    const doomed = worktreeSpaces(c.worktree, on);
    let removed = false;
    this.act("cleanup", "Clean-up failed", async (here) => {
      await ops.removeWorktree(c, on);
      removed = true;
      await ops.deleteBranch(c, on);
      if (here()) this.cleanup = null;
      return `Deleted branch ${c.branch} and its worktree`;
    }, cx, { after: () => { if (removed) for (const id of doomed) run("space.close", { id, confirmed: true }); } });
  }

  // "Keep": don't offer this worktree's clean-up again.
  keepWorktree(cx) {
    this.dismissed.add(`${this.cleanup.worktree}\n${this.cleanup.branch}`); this.cleanup = null; cx.notify();
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  render(cx) {
    if (contextKey() !== this.context) this.refresh(cx);
    const t = theme();
    return v_flex().id("branch-review").track_focus(this.focus).on_key_down((e, cx) => { if (e.key === "enter" && !this.typing && this.open) { cx.stop_propagation(); this.openInNvim(); } })
      .size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(header(this, t))
      .child(commitList(this, t))
      .children(fileSections(this, t))
      .child(diffPane(this, t))
      .children(notices(this, t))
      .child(footer(this, t));
  }
}
