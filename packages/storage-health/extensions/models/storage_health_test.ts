/** Tests for the storage-health model.
 *
 * The model shells out through `Deno.Command` (local `/bin/sh` or `ssh`).
 * These tests swap `Deno.Command` for a fake that records each invocation and
 * returns synthetic `df` / `find` output, then restore it. No real `df`,
 * `find`, or `ssh` process is spawned.
 */

// deno-lint-ignore no-import-prefix
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { model } from "./storage_health.ts";

type Invocation = { cmd: string; args: string[] };
type Reply = { code?: number; stdout?: string; stderr?: string };
type Written = { spec: string; name: string; data: Record<string, unknown> };

/** Swap Deno.Command for a fake driven by `respond`, restoring it afterwards. */
async function withFakeCommand<T>(
  respond: (inv: Invocation) => Reply,
  fn: (calls: Invocation[]) => Promise<T>,
): Promise<T> {
  const calls: Invocation[] = [];
  const original = Deno.Command;
  class FakeCommand {
    #inv: Invocation;
    constructor(cmd: string, options: { args?: string[] }) {
      this.#inv = { cmd, args: options.args ?? [] };
      calls.push(this.#inv);
    }
    output() {
      const reply = respond(this.#inv);
      const enc = new TextEncoder();
      return Promise.resolve({
        code: reply.code ?? 0,
        success: (reply.code ?? 0) === 0,
        stdout: enc.encode(reply.stdout ?? ""),
        stderr: enc.encode(reply.stderr ?? ""),
      });
    }
  }
  (Deno as unknown as { Command: unknown }).Command = FakeCommand;
  try {
    return await fn(calls);
  } finally {
    (Deno as unknown as { Command: unknown }).Command = original;
  }
}

/** The shell command string actually executed (last arg for sh -c and ssh). */
const shellText = (inv: Invocation) => inv.args[inv.args.length - 1];

function makeContext(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  const noop = () => {};
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    logger: { info: noop, warning: noop },
    writeResource: (spec: string, name: string, data: unknown) => {
      written.push({ spec, name, data: data as Record<string, unknown> });
      return Promise.resolve(`${spec}/${name}`);
    },
  };
  return { context, written };
}

/** Reply with a df line per mount (as produced by the model's awk filter). */
function dfReplies(byMount: Record<string, string>, find: Record<string, Reply> = {}) {
  return (inv: Invocation): Reply => {
    const text = shellText(inv);
    const df = text.match(/^df -Pm "([^"]+)"/);
    if (df) {
      const line = byMount[df[1]];
      if (line === undefined) throw new Error(`unexpected df for ${df[1]}`);
      return { stdout: `${line}\n` };
    }
    const fd = text.match(/^find "([^"]+)"/);
    if (fd) {
      const reply = find[fd[1]];
      if (!reply) throw new Error(`unexpected find for ${fd[1]}`);
      return reply;
    }
    throw new Error(`unexpected command ${text}`);
  };
}

const byName = (written: Written[], spec: string) =>
  written.filter((w) => w.spec === spec);

Deno.test("global arguments apply documented defaults", () => {
  assertEquals(model.globalArguments.parse({}), {
    sshHost: "local",
    mounts: "/",
    warnPercent: 75,
    criticalPercent: 90,
    backupPaths: "",
    backupKeepTarget: 0,
  });
  assertThrows(() => model.globalArguments.parse({ warnPercent: "75" }));
});

Deno.test("scan classifies usage at the warn/critical boundaries and recommends actions", async () => {
  await withFakeCommand(
    dfReplies({
      "/": "/dev/sda1 100000 74000 26000 74%",
      "/mnt/data": "/dev/sdb1 200000 150000 50000 75%",
      "/mnt/backup": "/dev/sdc1 409600 368640 2048 90%",
    }),
    async (calls) => {
      const { context, written } = makeContext({
        mounts: " /, /mnt/data ,/mnt/backup,",
      });
      const result = await model.methods.scan.execute({}, context);

      // Local execution goes through /bin/sh -c with the df|awk pipeline.
      assertEquals(calls.length, 3);
      assertEquals(calls[1], {
        cmd: "/bin/sh",
        args: [
          "-c",
          `df -Pm "/mnt/data" | awk 'NR==2 {print $1, $2, $3, $4, $5}'`,
        ],
      });

      const mounts = byName(written, "mountStatus");
      assertEquals(
        mounts.map((m) => [m.data.mount, m.data.usePercent, m.data.status]),
        [
          ["/", 74, "ok"],
          ["/mnt/data", 75, "warning"],
          ["/mnt/backup", 90, "critical"],
        ],
      );
      const { timestamp: _t, ...data } = mounts[1].data;
      assertEquals(data, {
        mount: "/mnt/data",
        device: "/dev/sdb1",
        sizeMb: 200000,
        usedMb: 150000,
        availMb: 50000,
        usePercent: 75,
        status: "warning",
      });
      assertEquals(mounts[1].name, "mountStatus-local-_mnt_data");
      for (const m of mounts) model.resources.mountStatus.schema.parse(m.data);

      const [report] = byName(written, "storageReport");
      assertEquals(report.name, "storageReport-local");
      assertEquals(report.data.host, "local");
      assertEquals(report.data.overallStatus, "critical");
      assertEquals(report.data.recommendations, [
        "WARNING: /mnt/data is 75% full (48.8 GiB free). Review retention policies.",
        "CRITICAL: /mnt/backup is 90% full (2.0 GiB free). Immediate action required.",
      ]);
      model.resources.storageReport.schema.parse(report.data);
      assertEquals(result.dataHandles.length, 4);
      assertEquals(result.dataHandles[3], "storageReport/storageReport-local");
    },
  );
});

Deno.test("custom thresholds change classification", async () => {
  await withFakeCommand(
    dfReplies({ "/srv": "/dev/vda1 1000 500 500 50%" }),
    async () => {
      const { context, written } = makeContext({
        mounts: "/srv",
        warnPercent: 40,
        criticalPercent: 50,
      });
      await model.methods.scan.execute({}, context);
      assertEquals(byName(written, "mountStatus")[0].data.status, "critical");
      assertEquals(byName(written, "storageReport")[0].data.overallStatus, "critical");
    },
  );
});

Deno.test("backup inventory reports snapshot range and keep-target compliance", async () => {
  await withFakeCommand(
    dfReplies(
      { "/": "/dev/sda1 100000 10000 90000 10%" },
      {
        "/mnt/backup/snapshots": {
          stdout: "/mnt/backup/snapshots/2026-01-01\n" +
            "/mnt/backup/snapshots/2026-02-01\n" +
            "/mnt/backup/snapshots/2026-03-01\n",
        },
        "/mnt/missing": { code: 1, stderr: "No such file or directory" },
      },
    ),
    async (calls) => {
      const { context, written } = makeContext({
        backupPaths: "/mnt/backup/snapshots,/mnt/missing",
        backupKeepTarget: 2,
      });
      await model.methods.scan.execute({}, context);

      assertEquals(
        shellText(calls[1]),
        `find "/mnt/backup/snapshots" -maxdepth 1 -type d -name '20*' | sort`,
      );

      const inventories = byName(written, "backupInventory");
      assertEquals(inventories.map((i) => i.name), [
        "backupInventory-local-_mnt_backup_snapshots",
        "backupInventory-local-_mnt_missing",
      ]);
      const strip = (d: Record<string, unknown>) => {
        const { timestamp: _t, ...rest } = d;
        return rest;
      };
      assertEquals(strip(inventories[0].data), {
        path: "/mnt/backup/snapshots",
        snapshotCount: 3,
        oldestSnapshot: "2026-01-01",
        newestSnapshot: "2026-03-01",
        keepTarget: 2,
        compliant: false,
      });
      // A failing find is treated as an empty inventory, not an error.
      assertEquals(strip(inventories[1].data), {
        path: "/mnt/missing",
        snapshotCount: 0,
        oldestSnapshot: "",
        newestSnapshot: "",
        keepTarget: 2,
        compliant: true,
      });
      for (const i of inventories) {
        model.resources.backupInventory.schema.parse(i.data);
      }

      const [report] = byName(written, "storageReport");
      // Mounts are healthy, but non-compliant backups still raise a warning.
      assertEquals(report.data.overallStatus, "warning");
      assertEquals(report.data.recommendations, [
        "Backup path /mnt/backup/snapshots has 3 snapshots (target: 2). " +
        "Oldest: 2026-01-01. Consider pruning.",
      ]);
    },
  );
});

Deno.test("healthy scan with keepTarget 0 is ok with a single all-clear recommendation", async () => {
  await withFakeCommand(
    dfReplies(
      { "/": "/dev/sda1 100000 10000 90000 10%" },
      {
        "/mnt/backup": {
          stdout: Array.from({ length: 40 }, (_, i) =>
            `/mnt/backup/2026-01-${String(i + 1).padStart(2, "0")}`).join("\n"),
        },
      },
    ),
    async () => {
      const { context, written } = makeContext({ backupPaths: "/mnt/backup" });
      await model.methods.scan.execute({}, context);
      const [inventory] = byName(written, "backupInventory");
      assertEquals(inventory.data.snapshotCount, 40);
      assertEquals(inventory.data.compliant, true);
      const [report] = byName(written, "storageReport");
      assertEquals(report.data.overallStatus, "ok");
      assertEquals(report.data.recommendations, [
        "All monitored mounts and backup paths are within healthy limits.",
      ]);
    },
  );
});

Deno.test("remote hosts are inspected over ssh in batch mode; localhost stays local", async () => {
  await withFakeCommand(
    dfReplies({ "/": "/dev/md0 1000 100 900 10%" }),
    async (calls) => {
      const { context, written } = makeContext({ sshHost: "nas.example.com" });
      await model.methods.scan.execute({}, context);
      assertEquals(calls[0].cmd, "ssh");
      assertEquals(calls[0].args.slice(0, 5), [
        "-o",
        "ConnectTimeout=10",
        "-o",
        "BatchMode=yes",
        "nas.example.com",
      ]);
      assertEquals(byName(written, "storageReport")[0].name, "storageReport-nas.example.com");
      assertEquals(byName(written, "storageReport")[0].data.host, "nas.example.com");

      calls.length = 0;
      const local = makeContext({ sshHost: "localhost" });
      await model.methods.scan.execute({}, local.context);
      assertEquals(calls[0].cmd, "/bin/sh");
    },
  );
});

Deno.test("a failing df aborts the scan with the host, exit code, and stderr", async () => {
  await withFakeCommand(
    () => ({ code: 2, stderr: "df: /nope: No such file or directory\n" }),
    async () => {
      const { context, written } = makeContext({ mounts: "/nope" });
      await assertRejects(
        () => model.methods.scan.execute({}, context),
        Error,
        "Command failed on 'local' (exit 2): df: /nope: No such file or directory",
      );
      assertEquals(written, []);
    },
  );
});

Deno.test("listMounts parses every df row into typed mount entries", async () => {
  await withFakeCommand(
    () => ({
      stdout: "/dev/sda1      /           ext4    100000  42000  42%\n" +
        "tmpfs          /run        tmpfs   1600    2      1%\n" +
        "192.0.2.10:/vol /mnt/nfs   nfs4    500000  499000 100%\n",
    }),
    async (calls) => {
      const { context, written } = makeContext({});
      const result = await model.methods.listMounts.execute({}, context);
      assertEquals(calls.length, 1);
      assertEquals(calls[0].cmd, "/bin/sh");
      assertEquals(written.length, 1);
      assertEquals(written[0].spec, "mountList");
      assertEquals(written[0].name, "mountList-local");
      assertEquals(written[0].data.mounts, [
        { device: "/dev/sda1", mount: "/", fstype: "ext4", sizeMb: 100000, usedMb: 42000, usePercent: 42 },
        { device: "tmpfs", mount: "/run", fstype: "tmpfs", sizeMb: 1600, usedMb: 2, usePercent: 1 },
        { device: "192.0.2.10:/vol", mount: "/mnt/nfs", fstype: "nfs4", sizeMb: 500000, usedMb: 499000, usePercent: 100 },
      ]);
      model.resources.mountList.schema.parse(written[0].data);
      assertEquals(result, { dataHandles: ["mountList/mountList-local"] });
    },
  );
});
