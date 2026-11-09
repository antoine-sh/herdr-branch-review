import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar } from "gpui-base";
import { worktreeSpaces } from "./context.js";

// The panel's pieces (all but the diff), drawn from the BranchReview view `v`; clicks call its methods.

const stop = (_e, cx) => cx.stop_propagation();
const empty = (t, msg) => div().p(8).text_color(t.dim).child(msg);
const pill = (t, color, text) => div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(color).child(text);

// A small text button. `dbl`: destructive, the first click arms it (red) for a second, a second click runs it.
function button(v, t, id, label, onTap, dbl) {
  const armed = dbl && v.armed === id;
  return div().id(id).h(20).min_w(20).px(6).flex().items_center().justify_center().rounded(5).flex_none().text_size(12).text_color(armed ? t.ansi1 : t.muted).cursor_pointer()
    .when(armed, (e) => e.bg(t.ansi1 + "30")).hover((s) => s.bg(armed ? t.ansi1 + "40" : t.hover)).on_mouse_down("left", stop)
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (!dbl) return onTap(cx);
      if (v.armed === id) { v.armed = null; onTap(cx); }
      else { v.armed = id; cx.notify(); cx.timer.after(1000, (cx) => { if (v.armed === id) { v.armed = null; cx.notify(); } }); }
    }).child(label);
}

// A footer button (Commit, Merge, Pull, Push); the caller adds its colors.
const bigButton = (id, enabled, onTap, label) => div().id(id).h(32).px(14).flex().items_center().flex_none().rounded(8).text_size(12)
  .when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => onTap(cx)).child(label);

// A full-width strip that names each section, in its own color: committed (accent), uncommitted (amber), diff (muted).
function banner(t, color, title, count, caption, right) {
  return h_flex().h(28).flex_none().px(12).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
    .child(div().w(3).h(12).rounded(2).flex_none().bg(color))
    .child(div().text_size(10).font_semibold().text_color(color).flex_none().child(title.toUpperCase()))
    .when(count !== null, (e) => e.child(div().px(5).rounded(8).bg(t.background).text_size(10).text_color(t.muted).child(String(count))))
    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(caption))
    .when(Boolean(right), (e) => e.child(right));
}

// Title, ahead/behind/uncommitted/upstream pills, Fetch.
export function header(v, t) {
  return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
    .child(div().font_semibold().truncate().child(v.base ? `${v.branch} ↔ ${v.base}` : "Branch review"))
    .when(Boolean(v.base), (e) => e.child(pill(t, t.muted, `${v.commits.length} ahead · ${v.behind} behind`)))
    .when(v.dirty > 0, (e) => e.child(pill(t, t.blocked, `${v.dirty} uncommitted`)))
    .when(v.upBehind > 0, (e) => e.child(pill(t, t.accent, `↓${v.upBehind} upstream`)))
    .child(div().flex_1())
    .child(button(v, t, "fetch", v.fetching ? "Fetching…" : "↻ Fetch", (cx) => v.fetchNow(cx)));
}

// The branch's commits, drawn as a timeline.
export function commitList(v, t) {
  const commits = v.commits;
  return v_flex().flex_none().border_b(1).border_color(t.border)
    .child(banner(t, t.accent, "Committed", commits.length, v.sel ? "one commit selected · click it again for all" : `on ${v.branch || "branch"}, ahead of ${v.base ?? "main"} · click to inspect`))
    .child(div().flex_none().h(commits.length ? Math.min(commits.length * 46 + 12, 220) : 36).relative()
      .child(v_flex().id("br-commits").absolute().inset_0().overflow_y_scroll().p(6)
        .children(commits.map((c, i) =>
          h_flex().id(`br-c-${c.sha}`).h(46).flex_none().px(8).gap(10).items_center().rounded(7).cursor_pointer().when(v.sel === c.sha, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => v.pickCommit(c.sha, cx))
            .child(div().w(10).h_full().flex_none().relative()
              .when(i < commits.length - 1, (e) => e.child(div().absolute().left(4).top(23).bottom(-23).w(2).bg(t.border)))
              .child(div().absolute().top(18).left(0).w(10).h(10).rounded(5).border_2().border_color(t.accent).bg(v.sel === c.sha ? t.accent : t.background)))
            .child(v_flex().flex_1().min_w(0).child(div().truncate().child(c.subject))
              .child(h_flex().gap(8).text_size(11).text_color(t.dim).child(div().text_color(t.accent).font_family("JetBrains Mono").child(c.short)).child(div().truncate().child(c.author)).child(div().flex_none().child(c.when))))))
        .when(!commits.length, () => empty(t, v.error || (v.loading ? "Loading…" : v.base ? `No commits ahead of ${v.base}` : "No folder"))))
      .child(Scrollbar.vertical("br-commits").absolute().inset_0()));
}

// One list of files (`kind`: commit, staged or changes) under its banner. `actions`: per-file buttons.
function fileSection(v, t, id, color, title, list, caption, kind, right, actions) {
  const add = list.reduce((n, f) => n + f.add, 0), del = list.reduce((n, f) => n + f.del, 0);
  return v_flex().flex_none().border_b(1).border_color(t.border)
    .child(banner(t, color, title, list.length, caption,
      h_flex().gap(8).items_center().text_size(11).child(div().text_color(t.ansi2).child(`+${add}`)).child(div().text_color(t.ansi1).child(`−${del}`)).when(Boolean(right), (e) => e.child(right))))
    .child(div().flex_none().h(list.length ? Math.min(list.length * 28 + 12, 170) : 36).relative()
      .child(v_flex().id(`br-${id}`).absolute().inset_0().overflow_y_scroll().p(6).children(list.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`br-${id}-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(v.open === f.path && v.kind === kind, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => v.pickFile(f.path, cx, kind))
          .child(div().w(14).text_size(11).text_color(f.status === "A" || f.status === "U" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
          .children((actions ?? []).map((a) => button(v, t, `${id}-${a.label}-${f.path}`, a.label, (cx) => a.run(f, cx), a.dbl)));
      })).when(!list.length, () => empty(t, v.error ? "" : v.loading ? "Loading…" : kind === "commit" ? "No files" : "No pending changes")))
      .child(Scrollbar.vertical(`br-${id}`).absolute().inset_0()));
}

// The selected commit's files, or Staged (when any) and Changes.
export function fileSections(v, t) {
  if (v.sel) return [fileSection(v, t, "commit", t.muted, "Files changed", v.files, `in ${(v.commits.find((c) => c.sha === v.sel) ?? {}).short ?? "commit"} only`, "commit")];
  const staged = v.staged.length ? [fileSection(v, t, "staged", t.ansi2, "Staged changes", v.staged, "ready to commit", "staged",
    h_flex().gap(4).child(button(v, t, "unstage-all", "− Unstage all", (cx) => v.unstage(null, cx))).child(button(v, t, "discard-staged", "Discard all", (cx) => v.revert(null, cx), true)),
    [{ label: "−", run: (f, cx) => v.unstage(f.path, cx) },
     { label: "⟲", dbl: true, run: (f, cx) => v.revert(f.path, cx) }])] : [];
  return [...staged, fileSection(v, t, "changes", t.blocked, "Changes", v.changes, "working tree · not staged", "changes",
    v.changes.length ? h_flex().gap(4).child(button(v, t, "stage-all", "+ Stage all", (cx) => v.stage(null, cx))).child(button(v, t, "discard-all", "Discard all", (cx) => v.discard(null, cx), true)) : null,
    [{ label: "+", run: (f, cx) => v.stage(f.path, cx) },
     { label: "⟲", dbl: true, run: (f, cx) => v.discard(f, cx) }])];
}

// The last action's outcome, and the offer to delete a merged worktree.
export function notices(v, t) {
  const out = [], c = v.cleanup;
  if (v.note) out.push(div().flex_none().px(10).pt(8).text_size(11).text_color(/^(Merged|Pushed|Pulled|Deleted)/.test(v.note) ? t.ansi2 : t.ansi1).child(v.note));
  if (c) out.push(div().flex_none().px(10).pt(8).child(h_flex().px(10).py(6).gap(8).items_center().rounded(8).border_1().border_color(t.border).bg(t.raised).text_size(11)
    .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${c.branch} is merged into ${v.base}. Delete the branch and its worktree${worktreeSpaces(c.worktree, v.on).length ? " and close its space" : ""}?${c.locked !== null ? ` (worktree locked${c.locked ? ": " + c.locked : ""})` : ""}`))
    .child(button(v, t, "cleanup-yes", v.busy === "cleanup" ? "Deleting…" : "Delete", (cx) => v.cleanUp(cx)))
    .child(button(v, t, "cleanup-no", "Keep", (cx) => v.keepWorktree(cx)))));
  return out;
}

// Commit message (with the AI button), Commit, and Merge (on a branch) or Pull/Push (on main).
export function footer(v, t) {
  const canCommit = v.canCommit(), canAi = v.canGenerate(), canMerge = v.canMerge();
  const icon = svg("mods/branch-review/ai.svg");
  let sync;
  if (!v.onBase()) sync = bigButton("br-merge", canMerge, (cx) => v.merge(cx), v.busy === "merge" ? "Merging (AI resolves conflicts)…" : `Merge to ${v.base ?? "main"}`)
    .border_1().border_color(t.border).bg(canMerge ? t.raised : t.background).text_color(canMerge ? t.foreground : t.dim);
  else if (v.upBehind > 0) sync = bigButton("br-push", v.canPull(), (cx) => v.pull(cx), v.busy === "pull" ? "Pulling…" : v.dirty ? `Pull ${v.base} (commit or discard first)` : v.diverged() ? `Diverged: pull & merge (${v.upBehind}↓ ${v.unpushed}↑)` : `Pull ${v.base} (${v.upBehind})`)
    .border_1().border_color(v.diverged() ? t.ansi1 : t.border).bg(v.canPull() ? t.raised : t.background).text_color(v.canPull() ? t.foreground : t.dim);
  else sync = bigButton("br-push", v.canPush(), (cx) => v.push(cx), v.busy === "push" ? "Pushing…" : v.diverged() ? `${v.base} diverged: rebase or merge manually` : v.unpushed ? `Push ${v.base} (${v.unpushed})` : `Push ${v.base}`)
    .border_1().border_color(v.diverged() ? t.ansi1 : t.border).bg(v.canPush() ? t.raised : t.background).text_color(v.diverged() ? t.ansi1 : v.canPush() ? t.foreground : t.dim);
  return h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
    .child(div().id("br-commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(v.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", stop).child(Input.new(v.input).h_full().flex_1().min_w(0).text_size(12).text_color(t.foreground))
      .child(div().id("br-ai").h(20).w(20).ml(6).flex().items_center().justify_center().flex_none().rounded(5).text_color(canAi ? t.accent : t.dim).when(canAi, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); v.generate(cx); }).child((v.busy === "ai" ? icon.spin(900) : icon).size(14).flex_none())))
    .child(bigButton("br-commit", canCommit, (cx) => v.commit(cx), v.busy === "commit" ? "Committing…" : "Commit").bg(canCommit ? t.solid : t.raised).text_color(canCommit ? t.solid_foreground : t.dim))
    .child(sync);
}
