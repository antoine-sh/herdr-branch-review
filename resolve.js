import { exec, readTextFile, writeTextFile } from "herdr";

// AI resolution of a merge left in conflict in `dir` (the base's worktree). Returns the resolved file names;
// throws (caller aborts the merge) when anything looks unsafe.
const MAX_BYTES = 60000;

async function resolveFile(dir, on, file, base, branch) {
  const path = `${dir}/${file}`;
  const text = await readTextFile(path, { on });
  if (text.includes("\0")) throw new Error(`${file} is binary`);
  if (text.length > MAX_BYTES) throw new Error(`${file} is too large to resolve automatically`);
  if (!/^<<<<<<< /m.test(text)) throw new Error(`${file} has no conflict markers`);
  const prompt = `Resolve the git merge conflicts in the file below. "ours" is ${base}, "theirs" is ${branch}. Keep the intent of both sides; where they truly contradict, prefer ${branch}'s change. Reply with the COMPLETE resolved file only: no conflict markers, no commentary, no code fences.\n\n### ${file}\n${text}`;
  const r = await exec("claude", ["-p", "--model", "sonnet", "--no-session-persistence", "--disable-slash-commands", "--tools=", "--setting-sources", "", "--strict-mcp-config", "--system-prompt", "You resolve git merge conflicts. Reply with the full resolved file only.", "--", prompt], { cwd: dir, on, timeout: 180000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "claude failed");
  let out = r.stdout;
  if (/^```/.test(out) && !text.includes("```")) out = out.replace(/^```[^\n]*\n/, "").replace(/\n```\s*$/, "");
  if (!out.trim()) throw new Error(`empty reply for ${file}`);
  if (/^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(out)) throw new Error(`${file} still has conflict markers`);
  out = out.replace(/\s+$/, "") + (text.endsWith("\n") ? "\n" : "");
  await writeTextFile(path, out);
}

export async function resolveConflicts(dir, on, base, branch) {
  if (on) throw new Error("AI conflict resolution works on this computer only");
  const st = await exec("git", ["status", "--porcelain"], { cwd: dir, on });
  const unmerged = st.stdout.split("\n").filter((l) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(l));
  const files = unmerged.filter((l) => l.startsWith("UU ")).map((l) => l.slice(3));
  if (!unmerged.length) throw new Error("merge failed without conflicts");
  if (files.length !== unmerged.length) throw new Error("delete/rename conflicts need a manual merge");
  for (const f of files) {
    await resolveFile(dir, on, f, base, branch);
    const a = await exec("git", ["add", "--", f], { cwd: dir, on });
    if (a.code !== 0) throw new Error(a.stderr.trim());
  }
  const c = await exec("git", ["commit", "--no-edit"], { cwd: dir, on });
  if (c.code !== 0) throw new Error((c.stderr || c.stdout).trim());
  return files;
}
