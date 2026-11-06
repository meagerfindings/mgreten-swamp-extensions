/**
 * Push the release commits a live ext-publish run made, and nothing else.
 *
 * Rules (any rule not met means "skipped", origin untouched):
 *  - HEAD is the branch being pushed and the working tree is clean.
 *  - Every commit in origin/<branch>..HEAD is one of `runShas`.
 *  - If origin moved ahead, those release commits are rebased onto it; a
 *    rebase that does not apply cleanly is aborted.
 *  - The push is a plain fast-forward refspec (no `+`, no --force*); git
 *    itself refuses a non-fast-forward. Nothing is retried.
 */

export interface AutoPushResult {
  status: "none" | "pushed" | "skipped" | "failed";
  detail: string;
  originBefore: string | null;
  headAfter: string | null;
  commits: number;
}

async function git(root: string, ...args: string[]) {
  const out = await new Deno.Command("git", {
    args: ["-C", root, ...args],
    stdout: "piped",
    stderr: "piped",
    env: { GIT_TERMINAL_PROMPT: "0" },
  }).output();
  return {
    ok: out.success,
    stdout: new TextDecoder().decode(out.stdout).trim(),
    stderr: new TextDecoder().decode(out.stderr).trim(),
  };
}

export async function pushReleaseCommits(
  root: string,
  runShas: string[],
  remote = "origin",
  branch = "main",
): Promise<AutoPushResult> {
  const res = (status: AutoPushResult["status"], detail: string, originBefore: string | null = null, headAfter: string | null = null, commits = 0): AutoPushResult =>
    ({ status, detail, originBefore, headAfter, commits });
  if (runShas.length === 0) return res("none", "run made no release commits");

  const current = await git(root, "symbolic-ref", "--short", "HEAD");
  if (current.stdout !== branch) return res("skipped", `HEAD is ${current.stdout || "detached"}, not ${branch}`);
  if ((await git(root, "status", "--porcelain")).stdout) return res("skipped", "working tree not clean");

  const fetch = await git(root, "fetch", "-q", "--no-tags", remote, branch);
  if (!fetch.ok) return res("failed", `fetch ${remote}/${branch}: ${fetch.stderr.slice(0, 200)}`);
  const upstream = `refs/remotes/${remote}/${branch}`;
  const originBefore = (await git(root, "rev-parse", upstream)).stdout;

  const unpushed = (await git(root, "rev-list", `${upstream}..HEAD`)).stdout.split("\n").filter(Boolean);
  if (unpushed.length === 0) return res("none", "nothing unpushed", originBefore);
  const mine = new Set(runShas);
  const foreign = unpushed.filter((c) => !mine.has(c));
  if (foreign.length) {
    return res("skipped", `${foreign.length} unpushed commit(s) not made by this run (e.g. ${foreign.at(-1)!.slice(0, 12)})`, originBefore, null, unpushed.length);
  }

  const behind = (await git(root, "rev-list", "--count", `HEAD..${upstream}`)).stdout;
  if (behind !== "0") {
    const rebase = await git(root, "rebase", "--no-autostash", upstream);
    if (!rebase.ok) {
      await git(root, "rebase", "--abort");
      return res("skipped", `${upstream} is ${behind} ahead and the release commits do not rebase cleanly`, originBefore, null, unpushed.length);
    }
  }
  if (!(await git(root, "merge-base", "--is-ancestor", upstream, "HEAD")).ok) {
    return res("skipped", "not a fast-forward of the remote branch", originBefore, null, unpushed.length);
  }

  const push = await git(root, "push", "--no-follow-tags", remote, `HEAD:refs/heads/${branch}`);
  const head = (await git(root, "rev-parse", "HEAD")).stdout;
  if (!push.ok) return res("failed", `push: ${push.stderr.split("\n").pop()?.slice(0, 200) ?? "failed"}`, originBefore, head, unpushed.length);
  return res("pushed", `pushed ${unpushed.length} release commit(s)${behind !== "0" ? ` after rebasing onto ${originBefore.slice(0, 12)}` : ""}`, originBefore, head, unpushed.length);
}
