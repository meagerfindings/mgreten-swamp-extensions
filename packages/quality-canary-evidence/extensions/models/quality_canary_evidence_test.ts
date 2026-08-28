import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260823.31";
import {
  GlobalArgumentsSchema,
  model,
  normalizeQualityReport,
  type QualityPolicy,
} from "./quality_canary_evidence.ts";

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};
async function assertRejects(
  operation: () => Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error("non-Error rejection");
    assert(
      error.message.includes(expected),
      `expected error containing ${
        JSON.stringify(expected)
      }, got ${error.message}`,
    );
    return;
  }
  throw new Error(`expected rejection containing ${JSON.stringify(expected)}`);
}
const liveProviderPolicy: NonNullable<QualityPolicy["liveProviderPolicy"]> = {
  expectedTranscriptionModels: ["speech-model"],
  expectedMetadataModels: ["metadata-model"],
  expectedAudioSha256: "a".repeat(64),
  expectedKeywords: ["cedar", "river", "silver"],
  minimumKeywordMatches: 2,
  requiredMetadataSchemaVersions: [1],
  requiredMetadataFeatures: ["title", "themes", "sentiment", "summary"],
};
const physicalDevicePolicy: NonNullable<
  QualityPolicy["physicalDevicePolicy"]
> = {
  devicePolicies: [{
    provider: "device-cloud",
    platforms: ["android", "ios"],
    inputModes: ["injected"],
  }],
  minimumBlobBytes: 100,
  minimumDurationSeconds: 1,
  minimumSignalRms: 0.01,
  minimumToneRatio: 0.1,
};
const policy: QualityPolicy = { liveProviderPolicy, physicalDevicePolicy };
const REPORT_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const args = {
  reportPath: "unused",
  executionExitCode: 0,
  runId: "run-1",
  sha: "abcdef1",
  branch: "main",
  runUrl: "https://example.com/run",
  environment: "production",
  trigger: "manual",
  artifactName: "canary",
  artifactUrl: "https://example.com/artifact",
};
const live = () => ({
  schemaVersion: 1 as const,
  kind: "live-ai-provider" as const,
  runAt: "2026-08-28T12:00:00Z",
  outcome: "passed" as const,
  cleanupOutcome: "not-applicable" as const,
  details: {
    transcription: {
      model: "speech-model",
      durationMs: 20,
      audioSha256: "a".repeat(64),
      expectedKeywords: ["silver", "cedar", "river"],
      matchedKeywords: ["cedar", "river"],
      transcriptWordCount: 4,
    },
    metadata: {
      model: "metadata-model",
      durationMs: 10,
      schemaVersion: 1,
      titlePresent: true,
      themes: ["travel"],
      sentiment: "happy",
      summaryWordCount: 5,
      validationErrors: [],
    },
  },
});
const device = (scenario: "allow" | "deny" = "allow") => ({
  schemaVersion: 1 as const,
  kind: "physical-device" as const,
  runAt: "2026-08-28T12:00:00Z",
  outcome: "passed" as const,
  cleanupOutcome: scenario === "allow"
    ? "completed" as const
    : "not-applicable" as const,
  details: {
    provider: "device-cloud",
    inputMode: "injected",
    permissionScenario: scenario,
    platform: "ios",
    deviceName: "Phone",
    osVersion: "18",
    browserName: "Safari",
    browserVersion: null,
    checks: scenario === "allow"
      ? {
        permissionPromptHandled: true,
        permissionGranted: true,
        permissionDenied: false,
        recordingCreated: true,
        previewVisible: true,
        uploadAttempted: true,
        uploadCompleted: true,
        storedAudioVerified: true,
        microphoneReleased: true,
        memoryDeleted: true,
      }
      : {
        permissionPromptHandled: true,
        permissionGranted: false,
        permissionDenied: true,
        recordingCreated: false,
        previewVisible: false,
        uploadAttempted: false,
        uploadCompleted: false,
        storedAudioVerified: false,
        microphoneReleased: false,
        memoryDeleted: false,
      },
    recording: scenario === "allow"
      ? {
        blobBytes: 100,
        storedBytes: 100,
        durationSeconds: 1,
        contentType: "audio/webm",
        signalRms: 0.01,
        tone440Ratio: 0.1,
      }
      : {
        blobBytes: null,
        storedBytes: null,
        durationSeconds: null,
        contentType: null,
        signalRms: null,
        tone440Ratio: null,
      },
  },
});

Deno.test("strict policy is coherent", () => {
  assert(
    GlobalArgumentsSchema.safeParse(policy).success,
    "valid policy rejected",
  );
  assert(
    !GlobalArgumentsSchema.safeParse({
      liveProviderPolicy: { ...liveProviderPolicy, minimumKeywordMatches: 4 },
    })
      .success,
    "impossible threshold accepted",
  );
  assert(
    !GlobalArgumentsSchema.safeParse({
      physicalDevicePolicy: {
        ...physicalDevicePolicy,
        devicePolicies: [
          ...physicalDevicePolicy.devicePolicies,
          physicalDevicePolicy.devicePolicies[0],
        ],
      },
    }).success,
    "duplicate provider accepted",
  );
  assert(!GlobalArgumentsSchema.safeParse({}).success, "empty policy accepted");
});
Deno.test("live-only, device-only, and combined policies pass", () => {
  assert(
    normalizeQualityReport(live(), args, { liveProviderPolicy }, REPORT_SHA256)
      .outcome ===
      "passed",
    "live-only failed",
  );
  assert(
    normalizeQualityReport(
      device(),
      args,
      { physicalDevicePolicy },
      REPORT_SHA256,
    ).outcome ===
      "passed",
    "device-only failed",
  );
  assert(
    normalizeQualityReport(device("deny"), args, policy, REPORT_SHA256)
      .outcome === "passed",
    "deny failed",
  );
});
Deno.test("reports are rejected when their policy is absent", () => {
  for (
    const [report, configured] of [
      [live(), { physicalDevicePolicy }],
      [device(), { liveProviderPolicy }],
    ] as const
  ) {
    let rejected = false;
    try {
      normalizeQualityReport(report, args, configured, REPORT_SHA256);
    } catch {
      rejected = true;
    }
    assert(rejected, "report without matching policy accepted");
  }
});
Deno.test("caller pass fails closed on consistency and runner failures", () => {
  const wrong = live();
  wrong.details.transcription.model = "other";
  assert(
    normalizeQualityReport(wrong, args, policy, REPORT_SHA256).outcome ===
      "failed",
    "wrong model passed",
  );
  assert(
    normalizeQualityReport(
      live(),
      { ...args, executionExitCode: 1 },
      policy,
      REPORT_SHA256,
    )
      .outcome === "failed",
    "runner failure passed",
  );
  const quiet = device();
  quiet.details.recording.signalRms = 0;
  assert(
    normalizeQualityReport(quiet, args, policy, REPORT_SHA256).outcome ===
      "failed",
    "quiet audio passed",
  );
});
Deno.test("strict schemas reject unknown fields and unsafe URLs", () => {
  for (
    const [raw, input] of [[{ ...live(), extra: true }, args], [live(), {
      ...args,
      runUrl: "https://user:secret@example.com/run",
    }]] as const
  ) {
    let rejected = false;
    try {
      normalizeQualityReport(raw, input, policy, REPORT_SHA256);
    } catch {
      rejected = true;
    }
    assert(rejected, "invalid evidence accepted");
  }
});
Deno.test("normalizer requires a valid caller-supplied report digest", () => {
  for (const digest of [undefined, "", "a".repeat(63), "g".repeat(64)]) {
    let rejected = false;
    try {
      Reflect.apply(normalizeQualityReport, undefined, [
        live(),
        args,
        policy,
        digest,
      ]);
    } catch {
      rejected = true;
    }
    assert(rejected, `invalid report digest accepted: ${String(digest)}`);
  }
});

async function withReport(
  raw: unknown,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const path = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(path, JSON.stringify(raw));
    await run(path);
  } finally {
    await Deno.remove(path);
  }
}
Deno.test("import rejects a report with no matching policy", async () => {
  await withReport(live(), async (reportPath) => {
    const test = createModelTestContext({
      methodName: "importReport",
      globalArgs: { physicalDevicePolicy },
    });
    let rejected = false;
    try {
      await model.methods.importReport.execute(
        { ...args, reportPath },
        test.context,
      );
    } catch {
      rejected = true;
    }
    assert(rejected, "import accepted report without matching policy");
    assert(
      test.getWrittenResources().length === 0,
      "rejected import wrote data",
    );
  });
});
Deno.test("import hashes, records, and makes same-run replay immutable", async () => {
  await withReport(live(), async (reportPath) => {
    const reportBytes = await Deno.readFile(reportPath);
    const expectedReportSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", reportBytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const first = createModelTestContext({
      methodName: "importReport",
      globalArgs: policy,
    });
    await model.methods.importReport.execute(
      { ...args, reportPath },
      first.context,
    );
    const written = first.getWrittenResources()[0].data as {
      reportSha256: string;
      authority: string;
    };
    assert(
      first.getWrittenResources()[0].specName === "qualityRun" &&
        first.getWrittenResources()[0].name === "quality-production-run-1",
      "run was not written to its run-addressable qualityRun instance",
    );
    assert(
      written.reportSha256 === expectedReportSha256,
      "report digest does not match its exact bytes",
    );
    assert(written.authority === "recording-only", "authority expanded");
    assert(
      first.getLogs().some((log) =>
        log.message === "Importing quality canary evidence"
      ) && first.getLogs().some((log) =>
        log.message === "Completed quality canary evidence import"
      ),
      "entry and completion were not logged",
    );
    const replay = createModelTestContext({
      methodName: "importReport",
      globalArgs: policy,
      storedResources: {
        "quality-production-run-1": first.getWrittenResources()[0].data,
      },
    });
    const result = await model.methods.importReport.execute(
      { ...args, reportPath },
      replay.context,
    );
    assert(
      result.dataHandles.length === 0 &&
        replay.getWrittenResources().length === 0,
      "replay created a version",
    );
  });
});
Deno.test("same run with changed bytes is rejected", async () => {
  const existing = normalizeQualityReport(live(), args, policy, "b".repeat(64));
  await withReport(live(), async (reportPath) => {
    const test = createModelTestContext({
      methodName: "importReport",
      globalArgs: policy,
      storedResources: { "quality-production-run-1": existing },
    });
    let rejected = false;
    try {
      await model.methods.importReport.execute(
        { ...args, reportPath },
        test.context,
      );
    } catch {
      rejected = true;
    }
    assert(rejected, "conflicting replay accepted");
  });
});
Deno.test("changed provenance for a historical run is rejected", async () => {
  await withReport(live(), async (reportPath) => {
    const initial = createModelTestContext({
      methodName: "importReport",
      globalArgs: policy,
    });
    await model.methods.importReport.execute(
      { ...args, reportPath },
      initial.context,
    );
    const historical = initial.getWrittenResources()[0].data;
    const replay = createModelTestContext({
      methodName: "importReport",
      globalArgs: policy,
      storedResources: { "quality-production-run-1": historical },
    });
    await assertRejects(
      () =>
        model.methods.importReport.execute(
          { ...args, reportPath, branch: "release" },
          replay.context,
        ),
      "different evidence or provenance",
    );
    assert(replay.getWrittenResources().length === 0, "conflict wrote data");
  });
});
Deno.test("distinct historical runs use distinct instances", async () => {
  await withReport(live(), async (reportPath) => {
    for (const runId of ["run-old", "run-new"]) {
      const test = createModelTestContext({
        methodName: "importReport",
        globalArgs: policy,
      });
      await model.methods.importReport.execute(
        { ...args, reportPath, runId },
        test.context,
      );
      assert(
        test.getWrittenResources()[0].name === `quality-production-${runId}`,
        "historical run was not independently addressable",
      );
    }
  });
});
Deno.test("published fixture executes against documented policy", async () => {
  const fixturePath = new URL(
    "../fixtures/live-provider.json",
    import.meta.url,
  );
  const fixture = JSON.parse(await Deno.readTextFile(fixturePath));
  assert(
    normalizeQualityReport(
      fixture,
      args,
      { liveProviderPolicy },
      REPORT_SHA256,
    ).outcome ===
      "passed",
    "published fixture does not satisfy documented policy",
  );
  const test = createModelTestContext({
    methodName: "importReport",
    globalArgs: { liveProviderPolicy },
  });
  await model.methods.importReport.execute(
    { ...args, reportPath: fixturePath.pathname },
    test.context,
  );
  assert(test.getWrittenResources().length === 1, "fixture was not imported");
});
Deno.test("bounded read accepts the exact size boundary", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify(live()));
  const file = await Deno.makeTempFile();
  try {
    const exact = new Uint8Array(1_048_576);
    exact.set(encoded);
    exact.fill(0x20, encoded.length);
    await Deno.writeFile(file, exact);
    const test = createModelTestContext({
      methodName: "importReport",
      globalArgs: policy,
    });
    await model.methods.importReport.execute(
      { ...args, reportPath: file },
      test.context,
    );
    assert(test.getWrittenResources().length === 1, "exact boundary rejected");
  } finally {
    await Deno.remove(file);
  }
});
Deno.test("bounded read rejects oversized files with context", async () => {
  const file = await Deno.makeTempFile();
  try {
    await Deno.writeFile(file, new Uint8Array(1_048_577));
    const test = createModelTestContext({ globalArgs: policy });
    await assertRejects(
      () =>
        model.methods.importReport.execute(
          { ...args, reportPath: file },
          test.context,
        ),
      `Report file "${file}" exceeds 1048576 bytes`,
    );
  } finally {
    await Deno.remove(file);
  }
});
Deno.test("missing, directory, and malformed reports have contextual errors", async () => {
  const directory = await Deno.makeTempDir();
  const malformed = await Deno.makeTempFile();
  const missing = `${directory}/missing.json`;
  try {
    await Deno.writeTextFile(malformed, "{not-json");
    for (
      const [reportPath, expected] of [
        [missing, `Unable to open report file "${missing}"`],
        [directory, `Unable to read report file "${directory}"`],
        [malformed, `Unable to parse report JSON from "${malformed}"`],
      ]
    ) {
      const test = createModelTestContext({ globalArgs: policy });
      await assertRejects(
        () =>
          model.methods.importReport.execute(
            { ...args, reportPath },
            test.context,
          ),
        expected,
      );
      assert(
        test.getWrittenResources().length === 0,
        "invalid file wrote data",
      );
    }
  } finally {
    await Deno.remove(malformed);
    await Deno.remove(directory, { recursive: true });
  }
});
