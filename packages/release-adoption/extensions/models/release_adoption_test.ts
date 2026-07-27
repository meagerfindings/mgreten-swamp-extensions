import { assertEquals } from "jsr:@std/assert@1";
import {
  diffSurfaces,
  filterReleasesInRange,
  mergeOpportunity,
  parseWorkflowYaml,
  sanitizeName,
  scanScript,
} from "./release_adoption.ts";

Deno.test("filters releases by inclusive CalVer prefix", () => {
  const releases = [
    "20260725.000000.0-sha.a",
    "20260726.015855.0-sha.b",
    "20260727.000000.0-sha.c",
    "20260728.000000.0-sha.d",
  ].map((tag_name) => ({ tag_name }));
  assertEquals(
    filterReleasesInRange(
      releases,
      "20260726.015855.0-sha.x",
      "20260727.000000.0-sha.y",
    ).map((r) => r.tag_name),
    ["20260726.015855.0-sha.b", "20260727.000000.0-sha.c"],
  );
});

Deno.test("diffs commands and per-command options", () => {
  const before = {
    name: "swamp",
    options: [{ name: "--old" }],
    commands: [{ name: "model", options: ["--json"] }, { name: "gone" }],
  };
  const after = {
    name: "swamp",
    options: [{ name: "--new" }],
    commands: [{ name: "model", options: ["--json", "--verbose"] }, {
      name: "added",
    }],
  };
  assertEquals(diffSurfaces(before, after), {
    addedCommands: ["swamp added"],
    removedCommands: ["swamp gone"],
    addedOptions: [{ command: "swamp", option: "--new" }, {
      command: "swamp model",
      option: "--verbose",
    }],
    removedOptions: [{ command: "swamp", option: "--old" }],
  });
});

Deno.test("parses workflow YAML inventory", () => {
  const summary = parseWorkflowYaml(
    `name: Example\njobs:\n  first:\n    steps:\n      - task: '@mgreten/a'\n      - type: '@mgreten/b'\n      - task:\n          type: model_method\n  second:\n    steps:\n      - task: '@mgreten/a'\n`,
    "fallback",
  );
  assertEquals(summary, {
    name: "Example",
    jobCount: 2,
    taskTypes: ["@mgreten/a", "@mgreten/b", "model_method"],
  });
});

Deno.test("finds only swamp run invocations", () => {
  assertEquals(
    scanScript(
      "swamp workflow run foo\necho swamp\nswamp model method run x y\nswamp model search",
    ),
    [1, 3],
  );
});

Deno.test("merges opportunity updates", () => {
  const existing = {
    id: "one",
    campaignId: "c",
    repo: "r",
    target: "t",
    feature: "f",
    proposal: "old",
    status: "proposed" as const,
    notes: "keep",
    updatedAt: "old",
  };
  assertEquals(
    mergeOpportunity(existing, {
      id: "one",
      campaignId: "c",
      repo: "r",
      target: "t",
      feature: "f",
      proposal: "new",
      status: "applied",
      commit: "abc",
    }, "now"),
    {
      ...existing,
      proposal: "new",
      status: "applied",
      commit: "abc",
      updatedAt: "now",
    },
  );
});

Deno.test("sanitizes resource names", () => {
  assertEquals(sanitizeName(" 2026/07 release! "), "2026-07-release");
  assertEquals(sanitizeName("///"), "unnamed");
});
