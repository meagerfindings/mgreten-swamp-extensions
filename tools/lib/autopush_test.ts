import { assertEquals } from "@std/assert";
import { pushReleaseCommits } from "./autopush.ts";

const temps: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const d of temps) Deno.removeSync(d, { recursive: true });
});

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await new Deno.Command("git", { args: ["-C", dir, ...args], stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

async function commit(dir: string, file: string, text: string, msg: string): Promise<string> {
  await Deno.writeTextFile(`${dir}/${file}`, text);
  await git(dir, "add", file);
  await git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

/** A bare origin with one commit, a working clone, and a second clone acting as another pusher. */
async function setup() {
  const base = await Deno.makeTempDir({ prefix: "autopush-test-" });
  temps.push(base);
  const origin = `${base}/origin.git`;
  await git(base, "init", "-q", "--bare", "-b", "main", origin);
  const clone = async (name: string) => {
    await git(base, "clone", "-q", origin, `${base}/${name}`);
    await git(`${base}/${name}`, "config", "user.email", "t@example.org");
    await git(`${base}/${name}`, "config", "user.name", "t");
    await git(`${base}/${name}`, "checkout", "-q", "-B", "main");
    return `${base}/${name}`;
  };
  const work = await clone("work");
  await commit(work, "a.txt", "a\n", "base");
  await git(work, "push", "-q", "origin", "main");
  const other = await clone("other");
  await git(other, "pull", "-q", "origin", "main");
  return { origin, work, other };
}

const originLog = (origin: string) => git(origin, "log", "--format=%s", "main");

Deno.test("pushes only this run's release commits, fast-forward", async () => {
  const { origin, work } = await setup();
  const r1 = await commit(work, "x.txt", "1\n", "release(x): 1");
  const r2 = await commit(work, "y.txt", "1\n", "release(y): 1");
  const res = await pushReleaseCommits(work, [r1, r2]);
  assertEquals([res.status, res.commits], ["pushed", 2]);
  assertEquals(await git(origin, "rev-parse", "main"), r2);
});

Deno.test("never pushes when an unpushed commit was not made by the run", async () => {
  const { origin, work } = await setup();
  const before = await git(origin, "rev-parse", "main");
  await commit(work, "m.txt", "maint\n", "chore(swamp): repo upgrade");
  const r = await commit(work, "x.txt", "1\n", "release(x): 1");
  const res = await pushReleaseCommits(work, [r]);
  assertEquals(res.status, "skipped");
  assertEquals(await git(origin, "rev-parse", "main"), before);
});

Deno.test("rebases release commits onto a moved origin and keeps origin's commit", async () => {
  const { origin, work, other } = await setup();
  const theirs = await commit(other, "b.txt", "b\n", "feat: elsewhere");
  await git(other, "push", "-q", "origin", "main");
  const r = await commit(work, "x.txt", "1\n", "release(x): 1");
  const res = await pushReleaseCommits(work, [r]);
  assertEquals(res.status, "pushed");
  assertEquals(await originLog(origin), "release(x): 1\nfeat: elsewhere\nbase");
  assertEquals(await git(origin, "rev-parse", "main~1"), theirs);
});

Deno.test("a conflicting origin change is never overwritten (no force) and the rebase is aborted", async () => {
  const { origin, work, other } = await setup();
  const theirs = await commit(other, "a.txt", "theirs\n", "feat: edit a");
  await git(other, "push", "-q", "origin", "main");
  const r = await commit(work, "a.txt", "mine\n", "release(a): 1");
  const res = await pushReleaseCommits(work, [r]);
  assertEquals(res.status, "skipped");
  assertEquals(await git(origin, "rev-parse", "main"), theirs);
  assertEquals(await git(work, "rev-parse", "HEAD"), r);
  assertEquals(await git(work, "status", "--porcelain"), "");
});

Deno.test("no release commits from the run means no push even when others are unpushed", async () => {
  const { origin, work } = await setup();
  const before = await git(origin, "rev-parse", "main");
  await commit(work, "x.txt", "1\n", "release(x): 1");
  assertEquals((await pushReleaseCommits(work, [])).status, "none");
  assertEquals(await git(origin, "rev-parse", "main"), before);
});
