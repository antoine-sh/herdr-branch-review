import { spaces, panes, focused } from "herdr";

// Where the panel looks, from Herdr's live data. No git here.

// The focused pane's folder (else the space's), and the machine it is on (null: this one).
export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

// Identity of the current location: each one keeps its own view, and async work drops results for another.
export const contextKey = () => JSON.stringify(location());

// Ids of the spaces on machine `on` whose terminals all live inside `dir` (a space without live folders: its folder).
export function worktreeSpaces(dir, on) {
  const inside = (p) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
  const all = panes();
  return spaces().filter((s) => (s.machine ?? null) === (on ?? null)).filter((s) => {
    const tabs = new Set(s.tabs.map((t) => t.id));
    const cwds = all.filter((p) => tabs.has(p.tab) && p.terminal && p.cwd).map((p) => p.cwd);
    return cwds.length ? cwds.every(inside) : Boolean(s.folder) && inside(s.folder);
  }).map((s) => s.id);
}
