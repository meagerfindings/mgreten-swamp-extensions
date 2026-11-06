/**
 * Tests for frigate-timelapse. Every remote action goes through `ssh` via
 * Deno.Command with no injection seam, so each test swaps Deno.Command for a
 * fake that answers by remote command string and restores it in a finally
 * block. No ssh, curl, docker or ffmpeg process is started. Hosts and paths
 * are synthetic (192.0.2.x, nonexistent roots).
 */

// deno-lint-ignore no-import-prefix
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./frigate_timelapse.ts";

type FakeOutput = { code: number; stdout?: string; stderr?: string };
type Call = { cmd: string; args: string[] };
type Responder = (remote: string) => FakeOutput;
type Write = { spec: string; name: string; data: Record<string, unknown> };
type Log = { level: string; message: string; props?: Record<string, unknown> };

const encoder = new TextEncoder();
const HOST = "192.0.2.20";
const ROOT = "/nonexistent-test-root/archive";
const CROOT = "/nonexistent-container-root/archive";
const CAM = "cam_test";
const FFMPEG = "/opt/fake/ffmpeg";

const GLOBALS = {
  frigateUrl: "http://192.0.2.10:5000",
  sshHost: HOST,
  camera: CAM,
  containerName: "nvr",
  hostArchiveDir: ROOT,
  containerArchiveDir: CROOT,
  ffmpegPath: FFMPEG,
};

async function withFakeSsh<T>(
  respond: Responder,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const calls: Call[] = [];
  const original = Deno.Command;
  class FakeCommand {
    #remote: string;
    constructor(cmd: string, opts?: { args?: string[] }) {
      const args = opts?.args ?? [];
      calls.push({ cmd, args });
      this.#remote = args[args.length - 1] ?? "";
    }
    output() {
      const res = respond(this.#remote);
      return Promise.resolve({
        success: res.code === 0,
        code: res.code,
        signal: null,
        stdout: encoder.encode(res.stdout ?? ""),
        stderr: encoder.encode(res.stderr ?? ""),
      });
    }
  }
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = FakeCommand;
  try {
    return await fn(calls);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = original;
  }
}

function makeContext(globals: Record<string, unknown> = GLOBALS) {
  const writes: Write[] = [];
  const logs: Log[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(globals),
    logger: {
      info: (message: string, props?: Record<string, unknown>) =>
        logs.push({ level: "info", message, props }),
      warning: (message: string, props?: Record<string, unknown>) =>
        logs.push({ level: "warning", message, props }),
    },
    writeResource: (spec: string, name: string, data: unknown) => {
      writes.push({ spec, name, data: data as Record<string, unknown> });
      return Promise.resolve({ name });
    },
  };
  return { context, writes, logs };
}

const remotes = (calls: Call[]) => calls.map((c) => c.args[c.args.length - 1]);
const ok = (stdout = ""): FakeOutput => ({ code: 0, stdout });
const fail = (stderr = "No such file"): FakeOutput => ({ code: 1, stderr });

Deno.test("global and method argument schemas apply defaults and reject bad input", () => {
  const parsed = model.globalArguments.parse({
    frigateUrl: "http://192.0.2.10:5000",
    sshHost: HOST,
    camera: CAM,
    hostArchiveDir: ROOT,
    containerArchiveDir: CROOT,
  });
  assertEquals(parsed.containerName, "frigate");
  assertEquals(parsed.ffmpegPath, "/usr/lib/ffmpeg/7.0/bin/ffmpeg");
  assertEquals(
    model.globalArguments.safeParse({ ...GLOBALS, sshHost: undefined }).success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({ ...GLOBALS, camera: 5 }).success,
    false,
  );

  assertEquals(model.methods.captureSnapshot.arguments.parse({}), {
    phase: "construction",
  });
  assertEquals(
    model.methods.compileDay.arguments.parse({ date: "2026-06-01" }),
    { date: "2026-06-01", phase: "construction", fps: 30, crf: 23 },
  );
  assertEquals(model.methods.compileDay.arguments.safeParse({}).success, false);
  assertEquals(
    model.methods.compileDays.arguments.safeParse({ fps: "30" }).success,
    false,
  );
  assertEquals(model.methods.startPhase.arguments.safeParse({}).success, false);
  assertEquals(
    model.resources.phaseList.schema.safeParse({
      camera: CAM,
      phases: [{ name: "a", startDate: "2026-01-01", status: "paused" }],
      timestamp: "t",
    }).success,
    false,
  );
});

Deno.test("captureSnapshot runs the ssh sequence and records the snapshot", async () => {
  const { context, writes } = makeContext();
  const dir = `${ROOT}/${CAM}/snapshots/framing`;
  const file = `${dir}/20260601_120000.jpg`;
  await withFakeSsh((remote) => {
    if (remote === "date +%Y%m%d_%H%M%S") return ok("20260601_120000\n");
    if (remote === "date +%Y-%m-%dT%H:%M:%S%z") {
      return ok("2026-06-01T12:00:01+0000");
    }
    if (remote.startsWith("stat ")) return ok(" 48213 \n");
    return ok();
  }, async (calls) => {
    const out = await model.methods.captureSnapshot.execute(
      { phase: "framing" },
      context,
    );
    assertEquals(out, {
      dataHandles: [{ name: "snapshot-cam_test-framing-20260601_120000" }],
    });
    assertEquals(calls[0], {
      cmd: "ssh",
      args: [
        "-o",
        "ConnectTimeout=10",
        "-o",
        "BatchMode=yes",
        HOST,
        "date +%Y%m%d_%H%M%S",
      ],
    });
    assertEquals(remotes(calls), [
      "date +%Y%m%d_%H%M%S",
      `mkdir -p "${dir}"`,
      `curl -s -f -o "${file}" "http://192.0.2.10:5000/api/${CAM}/latest.jpg"`,
      `stat -c %s "${file}"`,
      "date +%Y-%m-%dT%H:%M:%S%z",
    ]);
  });
  assertEquals(writes, [{
    spec: "snapshot",
    name: "snapshot-cam_test-framing-20260601_120000",
    data: {
      phase: "framing",
      file,
      camera: CAM,
      timestamp: "2026-06-01T12:00:01+0000",
      size: 48213,
    },
  }]);
});

Deno.test("captureSnapshot propagates a failed curl with exit code and stderr", async () => {
  const { context, writes } = makeContext();
  await withFakeSsh((remote) => {
    if (remote.startsWith("date")) return ok("20260601_120000");
    if (remote.startsWith("curl")) {
      return { code: 22, stderr: "  curl: (22) 404 \n" };
    }
    return ok();
  }, async (calls) => {
    await assertRejects(
      () => model.methods.captureSnapshot.execute({ phase: "p" }, context),
      Error,
      "SSH command failed (exit 22): curl: (22) 404",
    );
    // Nothing after the failing curl runs.
    assertEquals(calls.length, 3);
  });
  assertEquals(writes.length, 0);
});

Deno.test("listSnapshots groups by date, skips non-dated files and sorts days", async () => {
  const { context, writes } = makeContext();
  const dir = `${ROOT}/${CAM}/snapshots/framing`;
  const listing = [
    `${dir}/20260601_080000.jpg`,
    `${dir}/20260601_090000.jpg`,
    `${dir}/20260601_170000.jpg`,
    `${dir}/20260531_235959.jpg`,
    `${dir}/cover.jpg`,
    "",
  ].join("\n");
  await withFakeSsh(() => ok(listing), async (calls) => {
    await model.methods.listSnapshots.execute({ phase: "framing" }, context);
    assertEquals(remotes(calls), [
      `find "${dir}" -maxdepth 1 -name '*.jpg' | sort`,
    ]);
  });
  assertEquals(writes[0].spec, "snapshotIndex");
  assertEquals(writes[0].name, "snapshotIndex-cam_test-framing");
  assertEquals(writes[0].data.days, [
    {
      date: "20260531",
      count: 1,
      firstFile: `${dir}/20260531_235959.jpg`,
      lastFile: `${dir}/20260531_235959.jpg`,
    },
    {
      date: "20260601",
      count: 3,
      firstFile: `${dir}/20260601_080000.jpg`,
      lastFile: `${dir}/20260601_170000.jpg`,
    },
  ]);
  // total counts every listed file, including the undated one.
  assertEquals(writes[0].data.total, 5);
});

Deno.test("listSnapshots returns an empty index when the directory is missing", async () => {
  const { context, writes } = makeContext();
  await withFakeSsh(() => fail(), async () => {
    await model.methods.listSnapshots.execute({ phase: "none" }, context);
  });
  assertEquals(writes[0].data.days, []);
  assertEquals(writes[0].data.total, 0);
  assertEquals(writes[0].data.phase, "none");
});

Deno.test("compileDay builds the docker exec ffmpeg command with container paths", async () => {
  const { context, writes } = makeContext();
  const snap = `${ROOT}/${CAM}/snapshots/framing`;
  const vid = `${ROOT}/${CAM}/videos/framing`;
  await withFakeSsh(
    (remote) => remote.includes("wc -l") ? ok("   45\n") : ok(),
    async (calls) => {
      await model.methods.compileDay.execute(
        { date: "2026-06-01", phase: "framing", fps: 20, crf: 18 },
        context,
      );
      assertEquals(remotes(calls), [
        `find "${snap}" -maxdepth 1 -name '20260601_*.jpg' | wc -l`,
        `mkdir -p "${vid}"`,
        `docker exec nvr ${FFMPEG} -y -framerate 20 -pattern_type glob -i '${CROOT}/${CAM}/snapshots/framing/20260601_*.jpg' -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart "${CROOT}/${CAM}/videos/framing/20260601.mp4"`,
      ]);
    },
  );
  assertEquals(writes[0].spec, "compiledVideo");
  assertEquals(writes[0].name, "compiledVideo-cam_test-framing-20260601");
  const { timestamp: _t, ...rest } = writes[0].data;
  // 45 frames at 20 fps = 2.25 s, rounded to 2.
  assertEquals(rest, {
    phase: "framing",
    date: "2026-06-01",
    camera: CAM,
    file: `${vid}/20260601.mp4`,
    frameCount: 45,
    durationSec: 2,
  });
});

Deno.test("compileDay with zero frames throws before ffmpeg runs", async () => {
  const { context, writes } = makeContext();
  await withFakeSsh(() => ok("0"), async (calls) => {
    await assertRejects(
      () =>
        model.methods.compileDay.execute(
          { date: "2026-06-02", phase: "p", fps: 30, crf: 23 },
          context,
        ),
      Error,
      `No snapshots found for date 2026-06-02 in ${ROOT}/${CAM}/snapshots/p.`,
    );
    assertEquals(calls.length, 1);
  });
  assertEquals(writes.length, 0);
});

Deno.test("compileDays filters the inclusive range, skips empty days and concatenates", async () => {
  const { context, writes, logs } = makeContext();
  const snap = `${ROOT}/${CAM}/snapshots/p1`;
  const vid = `${ROOT}/${CAM}/videos/p1`;
  const cvid = `${CROOT}/${CAM}/videos/p1`;
  const counts: Record<string, string> = {
    "20260530": "9",
    "20260531": "0",
    "20260601": "12",
    "20260602": "7",
    "20260603": "5",
  };
  await withFakeSsh((remote) => {
    if (remote.includes("sort -u")) {
      return ok(
        ["20260530", "20260531", "20260601", "20260602", "20260603", "cover.jp"]
          .join("\n"),
      );
    }
    const m = remote.match(/-name '(\d{8})_\*\.jpg' \| wc -l$/);
    if (m) return ok(counts[m[1]]);
    return ok();
  }, async (calls) => {
    await model.methods.compileDays.execute(
      {
        phase: "p1",
        startDate: "2026-05-31",
        endDate: "2026-06-02",
        fps: 10,
        crf: 25,
      },
      context,
    );
    const ff = (d: string) =>
      `docker exec nvr ${FFMPEG} -y -framerate 10 -pattern_type glob -i '${CROOT}/${CAM}/snapshots/p1/${d}_*.jpg' -c:v libx264 -pix_fmt yuv420p -crf 25 -movflags +faststart "${cvid}/${d}.mp4"`;
    const list = `${vid}/.concat_list_p1.txt`;
    assertEquals(remotes(calls), [
      `find "${snap}" -maxdepth 1 -name '*.jpg' | sed 's|.*/||' | cut -c1-8 | sort -u`,
      `mkdir -p "${vid}"`,
      `find "${snap}" -maxdepth 1 -name '20260531_*.jpg' | wc -l`,
      `find "${snap}" -maxdepth 1 -name '20260601_*.jpg' | wc -l`,
      ff("20260601"),
      `find "${snap}" -maxdepth 1 -name '20260602_*.jpg' | wc -l`,
      ff("20260602"),
      `rm -f "${list}" && echo "file '${cvid}/20260601.mp4'" >> "${list}" && echo "file '${cvid}/20260602.mp4'" >> "${list}"`,
      `docker exec nvr ${FFMPEG} -y -f concat -safe 0 -i "${cvid}/.concat_list_p1.txt" -c copy "${cvid}/phase_p1_full.mp4"`,
      `rm -f "${list}"`,
    ]);
  });
  assertEquals(
    logs.filter((l) => l.level === "warning").map((l) => l.props),
    [{ date: "20260531" }],
  );
  assertEquals(writes[0].spec, "phaseVideo");
  assertEquals(writes[0].name, "phaseVideo-cam_test-p1");
  const { timestamp: _t, ...rest } = writes[0].data;
  assertEquals(rest, {
    phase: "p1",
    camera: CAM,
    file: `${vid}/phase_p1_full.mp4`,
    dayCount: 2,
    totalFrames: 19,
  });
});

Deno.test("compileDays errors on an empty range and when every day is empty", async () => {
  const first = makeContext();
  await withFakeSsh(() => ok("20260530\n20260604"), async (calls) => {
    await assertRejects(
      () =>
        model.methods.compileDays.execute(
          {
            phase: "p1",
            startDate: "2026-05-31",
            endDate: "2026-06-03",
            fps: 30,
            crf: 23,
          },
          first.context,
        ),
      Error,
      `No snapshot dates found for phase 'p1' in ${ROOT}/${CAM}/snapshots/p1 within the specified date range`,
    );
    assertEquals(calls.length, 1);
  });

  const second = makeContext();
  await withFakeSsh(
    (remote) => remote.includes("sort -u") ? ok("20260601") : ok("0"),
    async (calls) => {
      await assertRejects(
        () =>
          model.methods.compileDays.execute(
            { phase: "p1", fps: 30, crf: 23 },
            second.context,
          ),
        Error,
        "No per-day videos were produced",
      );
      // listing, mkdir, one count; no ffmpeg or concat.
      assertEquals(calls.length, 3);
    },
  );
  assertEquals(first.writes.length + second.writes.length, 0);
});

Deno.test("startPhase appends to existing phases.json and writes it back", async () => {
  const { context, writes } = makeContext();
  const phasesFile = `${ROOT}/${CAM}/phases.json`;
  const existing = {
    phases: [{
      name: "foundation",
      startDate: "2026-05-01",
      status: "complete",
      snapshotCount: 3,
    }],
  };
  let writeCmd = "";
  await withFakeSsh((remote) => {
    if (remote.startsWith("cat ")) return ok(JSON.stringify(existing));
    if (remote.startsWith("python3")) writeCmd = remote;
    return ok();
  }, async (calls) => {
    await model.methods.startPhase.execute(
      { phase: "framing", description: "Walls up" },
      context,
    );
    assertEquals(remotes(calls).slice(0, 2), [
      `mkdir -p "${ROOT}/${CAM}/snapshots/framing" "${ROOT}/${CAM}/videos/framing"`,
      `cat "${phasesFile}"`,
    ]);
    assertEquals(calls.length, 3);
  });
  const prefix =
    `python3 -c "import sys; open('${phasesFile}', 'w').write(sys.stdin.read())" <<'PHASESEOF'\n`;
  assertEquals(writeCmd.startsWith(prefix), true);
  assertEquals(writeCmd.endsWith("\nPHASESEOF"), true);
  const written = JSON.parse(
    writeCmd.slice(prefix.length, -"\nPHASESEOF".length),
  );
  assertEquals(written.phases.length, 2);
  assertEquals(written.phases[0], existing.phases[0]);
  const today = new Date().toISOString().slice(0, 10);
  assertEquals(written.phases[1], {
    name: "framing",
    description: "Walls up",
    startDate: today,
    status: "active",
    snapshotCount: 0,
  });
  assertEquals(writes[0].spec, "phaseStatus");
  assertEquals(writes[0].name, "phaseStatus-cam_test-framing");
  assertEquals(writes[0].data.status, "created");
  assertEquals(writes[0].data.phasesFile, phasesFile);
});

Deno.test("startPhase creates phases.json when missing and rejects duplicates", async () => {
  const fresh = makeContext();
  let writeCmd = "";
  await withFakeSsh((remote) => {
    if (remote.startsWith("cat ")) return fail();
    if (remote.startsWith("python3")) writeCmd = remote;
    return ok();
  }, async () => {
    await model.methods.startPhase.execute({ phase: "site" }, fresh.context);
  });
  const body = writeCmd.slice(
    writeCmd.indexOf("\n") + 1,
    -"\nPHASESEOF".length,
  );
  const parsed = JSON.parse(body);
  assertEquals(parsed.phases.length, 1);
  assertEquals(parsed.phases[0].name, "site");
  assertEquals("description" in parsed.phases[0], false);

  const dup = makeContext();
  await withFakeSsh(
    (remote) =>
      remote.startsWith("cat ")
        ? ok(JSON.stringify({
          phases: [{ name: "site", startDate: "2026-01-01", status: "active" }],
        }))
        : ok(),
    async (calls) => {
      await assertRejects(
        () => model.methods.startPhase.execute({ phase: "site" }, dup.context),
        Error,
        `Phase 'site' already exists in ${ROOT}/${CAM}/phases.json.`,
      );
      assertEquals(remotes(calls).some((r) => r.startsWith("python3")), false);
    },
  );
  assertEquals(dup.writes.length, 0);
});

Deno.test("listPhases enriches each phase with a live count, zero on failure", async () => {
  const { context, writes } = makeContext();
  const phases = [
    {
      name: "a",
      startDate: "2026-01-01",
      status: "complete",
      snapshotCount: 99,
    },
    { name: "b", startDate: "2026-02-01", status: "active", snapshotCount: 1 },
  ];
  await withFakeSsh((remote) => {
    if (remote.startsWith("cat ")) return ok(JSON.stringify({ phases }));
    if (remote.includes('/snapshots/a"')) return ok(" 17\n");
    return fail();
  }, async (calls) => {
    await model.methods.listPhases.execute({}, context);
    assertEquals(remotes(calls), [
      `cat "${ROOT}/${CAM}/phases.json"`,
      `find "${ROOT}/${CAM}/snapshots/a" -maxdepth 1 -name '*.jpg' | wc -l`,
      `find "${ROOT}/${CAM}/snapshots/b" -maxdepth 1 -name '*.jpg' | wc -l`,
    ]);
  });
  assertEquals(writes[0].spec, "phaseList");
  assertEquals(writes[0].name, "phaseList-cam_test");
  assertEquals(writes[0].data.phases, [
    { ...phases[0], snapshotCount: 17 },
    { ...phases[1], snapshotCount: 0 },
  ]);
});

Deno.test("listPhases returns an empty list when phases.json is missing", async () => {
  const { context, writes, logs } = makeContext();
  await withFakeSsh(() => fail(), async (calls) => {
    await model.methods.listPhases.execute({}, context);
    assertEquals(calls.length, 1);
  });
  assertEquals(writes[0].data.phases, []);
  assertEquals(
    logs.some((l) => l.message === "No phases.json found for camera {camera}"),
    true,
  );
});
