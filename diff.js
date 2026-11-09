import { div } from "gpui-kit";
import { h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { settings } from "herdr";

// The diff pane: unified diff lines → numbered rows, drawn in a virtual list.

export function diffRows(lines) {
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

// Width the rows need, so long lines scroll sideways instead of wrapping.
export const diffWidth = (lines) => Math.max(300, ...lines.map((l) => l.length * 7 + 50));

function diffRow({ kind, number, text }, t) {
  if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
  const add = kind === "+", del = kind === "-", tone = add ? t.ansi2 : t.ansi1;
  return h_flex().w_full().h(20).flex_none().gap(10).when(add || del, (e) => e.bg(tone + "40"))
    .child(div().w(3).h_full().flex_none().when(add || del, (e) => e.bg(tone)))
    .child(div().w(30).flex_none().text_right().text_color(add || del ? tone : t.dim).child(number === undefined ? "" : String(number)))
    .child(div().w(10).flex_none().text_color(tone).child(add ? "+" : del ? "−" : ""))
    .child(div().flex_1().min_w(0).truncate().when(add || del, (e) => e.text_color(t.foreground)).when(!add && !del, (e) => e.text_color(t.muted)).child(text));
}

// `v`: the BranchReview view (rows, diffWidth, open file).
export function diffPane(v, t) {
  return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
    .child(div().id("br-diff-x").size_full().overflow_x_scroll()
      .child(div().w_full().min_w(v.diffWidth).h_full().child(v_virtual_list("br-diff", v.rows.length, 20, (i) => String(i),
        (range) => v.rows.slice(range.start, range.end).map((row) => diffRow(row, t))).size_full())))
    .child(Scrollbar.vertical("br-diff").viewport_from_layout().absolute().inset_0())
    .child(Scrollbar.horizontal("br-diff-x").absolute().inset_0())
    .when(!v.open && v.list(v.kind).length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes")));
}
