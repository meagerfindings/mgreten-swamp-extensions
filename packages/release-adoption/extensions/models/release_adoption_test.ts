import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing";
import {
  compareCalVer,
  diffSurfaces,
  filterReleasesInRange,
  mergeOpportunity,
  model,
  parseCalVer,
  parseWorkflowYaml,
  resourceName,
  sanitizeName,
  scanScript,
} from "./release_adoption.ts";
import { report } from "../reports/release_adoption_brief.ts";

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
      "20260726.015855.0-sha.a",
      "20260727.000000.0-sha.b",
    ).map((r) => r.tag_name),
    ["20260726.015855.0-sha.b", "20260727.000000.0-sha.c"],
  );
});

Deno.test("parses and numerically compares complete CalVer tags", () => {
  assertEquals(parseCalVer("v20260727.000815.0-sha.db74fcac"), [
    20260727,
    815,
    0,
  ]);
  assertEquals(parseCalVer("20260726.9"), [20260726, 9]);
  assertEquals(parseCalVer("20260726.9-sha.abc"), [20260726, 9]);
  assertEquals(parseCalVer("20260726junk"), null);
  assertEquals(parseCalVer("20260726.x-sha.abc"), null);
  assertEquals(parseCalVer("20260726.1-sha."), null);
  assertEquals(compareCalVer([20260726, 10], [20260726, 9]), 1);
  assertEquals(compareCalVer([20260726, 9], [20260726, 9, 0]), 0);
});

Deno.test("filters differing widths, missing segments, v tags, and invalid tags", () => {
  const releases = [
    "20260726.9",
    "20260726.10-sha.a",
    "v20260726.10.0-sha.b",
    "20260726.11",
    "20260726junk",
    "not-a-version",
  ].map((tag_name) => ({ tag_name }));
  assertEquals(
    filterReleasesInRange(releases, "v20260726.10", "20260726.10.0-sha.f"),
    [releases[1], releases[2]],
  );
  assertThrows(
    () => filterReleasesInRange(releases, "20260726junk", "20260726.11"),
    Error,
    "release range endpoints must be complete CalVer tags",
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
    }, "2026-07-27T01:00:00.000Z"),
    {
      ...existing,
      proposal: "new",
      status: "applied",
      commit: "abc",
      updatedAt: "2026-07-27T01:00:00.000Z",
    },
  );
});

Deno.test("sanitizes resource names", () => {
  assertEquals(sanitizeName(" 2026/07 release! "), "2026-07-release");
  assertEquals(sanitizeName("///"), "unnamed");
});

Deno.test("resource names retain readable slugs and avoid slug collisions", async () => {
  const first = await resourceName("opp", "a/b");
  const second = await resourceName("opp", "a b");
  assertMatch(first, /^opp-a-b-[a-f0-9]{8}$/);
  assertEquals(first === second, false);
  assertEquals(first, await resourceName("opp", "a/b"));
});

Deno.test("record-opportunity execute preserves omitted commit and status", async () => {
  const name = await resourceName("opp", "one");
  const existing = {
    id: "one",
    campaignId: "campaign",
    repo: "owner/repo",
    target: "workflow",
    feature: "feature",
    proposal: "old",
    status: "applied" as const,
    commit: "abcdef",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { githubRepo: "swamp-club/swamp", fleetRepos: [] },
    methodName: "record-opportunity",
    storedResources: { [name]: existing },
  });
  await model.methods["record-opportunity"].execute({
    id: "one",
    campaignId: "campaign",
    repo: "owner/repo",
    target: "workflow",
    feature: "feature",
    proposal: "new",
  }, context);
  const written = getWrittenResources()[0];
  assertEquals(written.name, name);
  assertEquals(written.data.status, "applied");
  assertEquals(written.data.commit, "abcdef");
  assertEquals(written.data.proposal, "new");
});

Deno.test("open-campaign execute reopens idempotently and preserves openedAt", async () => {
  const name = await resourceName("campaign", "campaign");
  const existing = {
    id: "campaign",
    fromVersion: "20260726.1",
    toVersion: "20260726.2",
    phase: "done" as const,
    openedAt: "2026-07-27T00:00:00.000Z",
    notes: "keep",
  };
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { githubRepo: "swamp-club/swamp", fleetRepos: [] },
    methodName: "open-campaign",
    storedResources: { [name]: existing },
  });
  await model.methods["open-campaign"].execute({
    id: "campaign",
    fromVersion: "20260726.1",
    toVersion: "20260727.1",
  }, context);
  assertEquals(getWrittenResources()[0].data, {
    ...existing,
    toVersion: "20260727.1",
    phase: "open",
  });
});

function reportContext(
  methodArgs: Record<string, unknown>,
  artifacts: Array<
    { name: string; version: number; specName: string; data: unknown }
  >,
) {
  return {
    definition: { name: "release-adoption" },
    methodName: "record-opportunity",
    executionStatus: "success",
    modelType: "@mgreten/release-adoption",
    modelId: "model-id",
    methodArgs,
    dataHandles: [],
    dataRepository: {
      findAllForModel: () =>
        Promise.resolve(artifacts.map((item) => ({
          name: item.name,
          version: item.version,
          tags: { specName: item.specName },
          createdAt: "2026-07-27T00:00:00.000Z",
        }))),
      getContent: (
        _type: string,
        _id: string,
        name: string,
        version?: number,
      ) => {
        const item = artifacts.find((candidate) =>
          candidate.name === name && candidate.version === version
        );
        return Promise.resolve(
          item ? new TextEncoder().encode(JSON.stringify(item.data)) : null,
        );
      },
    },
    logger: { info: () => {} },
  };
}

Deno.test("report returns campaign_not_found for an explicit miss", async () => {
  const context = reportContext({ campaignId: "missing" }, [{
    name: "campaign-present",
    version: 1,
    specName: "campaign",
    data: { id: "present" },
  }]);
  const result = await report.execute(context);
  assertEquals(result.json.reason, "campaign_not_found");
});

Deno.test("report uses latest opportunity artifact version and safe markdown", async () => {
  const campaign = {
    id: "campaign",
    fromVersion: "20260726.1",
    toVersion: "20260727.1",
    phase: "open",
    openedAt: "2026-07-27T00:00:00.000Z",
  };
  const base = {
    id: "opp",
    campaignId: "campaign",
    repo: "owner/repo",
    target: "target|cell",
    feature: "feature",
    proposal: "proposal",
  };
  const context = reportContext({ campaignId: "campaign" }, [
    { name: "campaign", version: 1, specName: "campaign", data: campaign },
    {
      name: "opp-one",
      version: 1,
      specName: "opportunity",
      data: { ...base, status: "proposed" },
    },
    {
      name: "opp-one",
      version: 2,
      specName: "opportunity",
      data: { ...base, status: "applied" },
    },
    {
      name: "notes",
      version: 1,
      specName: "releaseNotes",
      data: {
        campaignId: "campaign",
        releases: [{
          tag: "#tag",
          name: "name",
          url: "https://example.com",
          body: "body\n```\n# heading",
        }],
      },
    },
    {
      name: "inventory",
      version: 1,
      specName: "fleetInventory",
      data: {
        campaignId: "campaign",
        repos: [{
          name: "repo|cell",
          present: false,
          error: "line one\nline two",
          workflows: [],
          models: [],
          extensionModels: [],
          reports: [],
          swampInvokingScripts: [],
        }],
      },
    },
  ]);
  const result = await report.execute(context);
  assertEquals((result.json.opportunities as unknown[]).length, 1);
  assertMatch(result.markdown, /### Applied[\s\S]*target\|cell/);
  assertMatch(result.markdown, /repo\\\|cell.*line one line two/);
  assertMatch(result.markdown, /````text/);
});
