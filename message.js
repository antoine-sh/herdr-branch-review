import { exec, readTextFile, home } from "herdr";
import { readGit } from "./git.js";

// A commit message for the staged diff, written by Haiku (the `claude` CLI on the repository's machine).
export async function generateMessage(root, on) {
  const d = await readGit(["diff", "--cached", "--no-ext-diff", "--no-color"], root, on);
  if (d.code !== 0) throw new Error(d.stderr.trim());
  const diff = d.stdout.slice(0, 40000);
  if (!diff.trim()) throw new Error("no text changes to describe");
  // Project and global instructions: their commit-message rules win over the defaults below.
  const h = home().replace(/\/$/, ""), docs = [];
  for (const [label, path, remote] of [["Global", `${h}/.claude/CLAUDE.md`], ["Global", `${h}/.claude/AGENTS.md`], ["Global", `${h}/AGENTS.md`], ["Project", `${root}/CLAUDE.md`, true], ["Project", `${root}/AGENTS.md`, true]]) {
    const text = await readTextFile(path, remote ? { on } : {}).catch(() => null);
    if (text?.trim()) docs.push(`### ${label} instructions (${path})\n${text.slice(0, 8000)}`);
  }
  const rules = docs.length ? `\n\nFollow any commit message conventions in these instruction files (format, language, prefixes, trailers, length); ignore everything unrelated to commit messages. Project rules override global ones.\n\n${docs.join("\n\n")}` : "";
  const prompt = "Write a git commit message for the diff below: by default a short concise imperative subject line (max 72 chars), then optionally a blank line and a short body. Reply with the message only, no quotes or code fences." + rules + "\n\n### Diff\n" + diff;
  const r = await exec("claude", ["-p", "--model", "haiku", "--no-session-persistence", "--disable-slash-commands", "--tools=", "--setting-sources", "", "--strict-mcp-config", "--system-prompt", "You write git commit messages. Reply with the message only.", "--", prompt], { cwd: root, on, timeout: 90000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  const msg = r.stdout.trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
  if (!msg) throw new Error("empty reply");
  return msg;
}
