/** Strictly normalize and retain live-provider and physical-device canary evidence. */
import { z } from "npm:zod@4";

const MAX_REPORT_BYTES = 1_048_576;
const SafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const ShortText = z.string().min(1).max(200);
const Text = z.string().min(1).max(500);
const StringList = z.array(ShortText).max(100);
const PublicUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username &&
    !url.password && !url.search && !url.hash;
}, "must be public HTTP(S) without credentials, query, or fragment");

const MetadataVersion = z.union([
  z.string().min(1).max(100),
  z.number().int().nonnegative(),
]);
const DevicePolicySchema = z.strictObject({
  provider: SafeId,
  platforms: z.array(SafeId).min(1).max(20),
  inputModes: z.array(SafeId).min(1).max(20),
});

const LiveProviderPolicySchema = z.strictObject({
  expectedTranscriptionModels: z.array(ShortText).min(1).max(20),
  expectedMetadataModels: z.array(ShortText).min(1).max(20),
  expectedAudioSha256: Sha,
  expectedKeywords: z.array(ShortText).min(1).max(100),
  minimumKeywordMatches: z.number().int().positive(),
  requiredMetadataSchemaVersions: z.array(MetadataVersion).min(1).max(20),
  requiredMetadataFeatures: z.array(z.enum([
    "title",
    "themes",
    "sentiment",
    "summary",
  ])).min(1).max(4),
}).superRefine((policy, context) => {
  if (policy.minimumKeywordMatches > new Set(policy.expectedKeywords).size) {
    context.addIssue({
      code: "custom",
      path: ["minimumKeywordMatches"],
      message: "cannot exceed the number of unique expected keywords",
    });
  }
  for (
    const key of [
      "expectedTranscriptionModels",
      "expectedMetadataModels",
      "expectedKeywords",
      "requiredMetadataSchemaVersions",
      "requiredMetadataFeatures",
    ] as const
  ) {
    if (new Set(policy[key]).size !== policy[key].length) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: "must be unique",
      });
    }
  }
});

const PhysicalDevicePolicySchema = z.strictObject({
  devicePolicies: z.array(DevicePolicySchema).min(1).max(50),
  minimumBlobBytes: z.number().int().positive(),
  minimumDurationSeconds: z.number().finite().positive(),
  minimumSignalRms: z.number().finite().nonnegative(),
  minimumToneRatio: z.number().finite().nonnegative(),
}).superRefine((policy, context) => {
  for (const [index, item] of policy.devicePolicies.entries()) {
    for (const key of ["platforms", "inputModes"] as const) {
      if (new Set(item[key]).size !== item[key].length) {
        context.addIssue({
          code: "custom",
          path: ["devicePolicies", index, key],
          message: "must be unique",
        });
      }
    }
  }
  const deviceKeys = policy.devicePolicies.map((item) => item.provider);
  if (new Set(deviceKeys).size !== deviceKeys.length) {
    context.addIssue({
      code: "custom",
      path: ["devicePolicies"],
      message: "provider policies must be unique",
    });
  }
});

/** Strict policy applied to configured canary report kinds. */
export const GlobalArgumentsSchema = z.strictObject({
  liveProviderPolicy: LiveProviderPolicySchema.optional(),
  physicalDevicePolicy: PhysicalDevicePolicySchema.optional(),
}).superRefine((policy, context) => {
  if (!policy.liveProviderPolicy && !policy.physicalDevicePolicy) {
    context.addIssue({
      code: "custom",
      message: "at least one canary policy is required",
    });
  }
});

const Transcription = z.strictObject({
  model: ShortText,
  durationMs: z.number().int().nonnegative(),
  audioSha256: Sha.nullable(),
  expectedKeywords: StringList,
  matchedKeywords: StringList,
  transcriptWordCount: z.number().int().nonnegative(),
});
const Metadata = z.strictObject({
  model: ShortText,
  durationMs: z.number().int().nonnegative(),
  schemaVersion: MetadataVersion.nullable(),
  titlePresent: z.boolean(),
  themes: StringList,
  sentiment: ShortText.nullable(),
  summaryWordCount: z.number().int().nonnegative().nullable(),
  validationErrors: StringList,
});
const Checks = z.strictObject({
  permissionPromptHandled: z.boolean(),
  permissionGranted: z.boolean(),
  permissionDenied: z.boolean(),
  recordingCreated: z.boolean(),
  previewVisible: z.boolean(),
  uploadAttempted: z.boolean(),
  uploadCompleted: z.boolean(),
  storedAudioVerified: z.boolean(),
  microphoneReleased: z.boolean(),
  memoryDeleted: z.boolean(),
});
const Recording = z.strictObject({
  blobBytes: z.number().int().nonnegative().nullable(),
  storedBytes: z.number().int().nonnegative().nullable(),
  durationSeconds: z.number().finite().nonnegative().nullable(),
  contentType: ShortText.nullable(),
  signalRms: z.number().finite().nonnegative().nullable(),
  tone440Ratio: z.number().finite().nonnegative().nullable(),
});
const ReportBase = {
  schemaVersion: z.literal(1),
  runAt: z.iso.datetime({ offset: true }),
  outcome: z.enum(["passed", "failed"]),
  cleanupOutcome: z.enum(["completed", "failed", "not-applicable"]),
  errorMessage: z.string().min(1).max(10_000).optional(),
};
const LiveReport = z.strictObject({
  ...ReportBase,
  kind: z.literal("live-ai-provider"),
  details: z.strictObject({ transcription: Transcription, metadata: Metadata }),
});
const DeviceReport = z.strictObject({
  ...ReportBase,
  kind: z.literal("physical-device"),
  details: z.strictObject({
    provider: SafeId,
    inputMode: SafeId,
    permissionScenario: z.enum(["allow", "deny"]),
    platform: SafeId,
    deviceName: ShortText,
    osVersion: ShortText,
    browserName: ShortText,
    browserVersion: ShortText.nullable(),
    checks: Checks,
    recording: Recording,
  }),
});
const RawReport = z.discriminatedUnion("kind", [LiveReport, DeviceReport]);

/** Arguments identifying the report and its runner provenance. */
export const ImportArgumentsSchema = z.strictObject({
  reportPath: z.string().min(1).max(4096),
  executionExitCode: z.number().int().nonnegative(),
  runId: SafeId,
  sha: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  branch: z.string().min(1).max(255),
  pullRequest: Text.optional(),
  deployment: Text.optional(),
  runUrl: PublicUrl,
  environment: SafeId,
  trigger: Text,
  artifactName: SafeId,
  artifactUrl: PublicUrl,
});

const RunBase = {
  schemaVersion: z.literal(1),
  runAt: z.iso.datetime({ offset: true }),
  runId: SafeId,
  sha: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  branch: z.string().min(1).max(255),
  pullRequest: Text.optional(),
  deployment: Text.optional(),
  runUrl: PublicUrl,
  environment: SafeId,
  trigger: Text,
  artifact: z.strictObject({ name: SafeId, url: PublicUrl }),
  reportSha256: Sha,
  authority: z.literal("recording-only"),
  executionExitCode: z.number().int().nonnegative(),
  outcome: z.enum(["passed", "failed"]),
  cleanupOutcome: z.enum(["completed", "failed", "not-applicable"]),
  errorMessage: z.string().min(1).max(10_000).optional(),
};
const QualityRunSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...RunBase,
    kind: z.literal("live-ai-provider"),
    details: LiveReport.shape.details,
  }),
  z.strictObject({
    ...RunBase,
    kind: z.literal("physical-device"),
    details: DeviceReport.shape.details,
  }),
]);

/** A normalized, durable canary run. */
export type QualityRun = z.infer<typeof QualityRunSchema>;
/** Configurable consistency policy. */
export type QualityPolicy = z.infer<typeof GlobalArgumentsSchema>;
/** Import provenance supplied by the runner. */
export type ImportArguments = z.infer<typeof ImportArgumentsSchema>;

function liveConsistent(
  report: z.infer<typeof LiveReport>,
  policy: z.infer<typeof LiveProviderPolicySchema>,
): boolean {
  const transcription = report.details.transcription;
  const metadata = report.details.metadata;
  const expected = new Set(policy.expectedKeywords);
  const matches = new Set(transcription.matchedKeywords);
  const features = policy.requiredMetadataFeatures;
  return report.cleanupOutcome === "not-applicable" && !report.errorMessage &&
    policy.expectedTranscriptionModels.includes(transcription.model) &&
    policy.expectedMetadataModels.includes(metadata.model) &&
    transcription.audioSha256 === policy.expectedAudioSha256 &&
    transcription.expectedKeywords.length === expected.size &&
    transcription.expectedKeywords.every((keyword) => expected.has(keyword)) &&
    matches.size >= policy.minimumKeywordMatches &&
    [...matches].every((keyword) => expected.has(keyword)) &&
    transcription.transcriptWordCount > 0 && metadata.schemaVersion !== null &&
    policy.requiredMetadataSchemaVersions.some((version) =>
      version === metadata.schemaVersion
    ) &&
    metadata.validationErrors.length === 0 &&
    (!features.includes("title") || metadata.titlePresent) &&
    (!features.includes("themes") || metadata.themes.length > 0) &&
    (!features.includes("sentiment") || metadata.sentiment !== null) &&
    (!features.includes("summary") || (metadata.summaryWordCount ?? 0) > 0);
}

function deviceConsistent(
  report: z.infer<typeof DeviceReport>,
  policy: z.infer<typeof PhysicalDevicePolicySchema>,
): boolean {
  const detail = report.details;
  const provider = policy.devicePolicies.find((item) =>
    item.provider === detail.provider
  );
  if (
    !provider || !provider.platforms.includes(detail.platform) ||
    !provider.inputModes.includes(detail.inputMode) || report.errorMessage
  ) return false;
  const checks = detail.checks;
  const recording = detail.recording;
  if (detail.permissionScenario === "deny") {
    return report.cleanupOutcome === "not-applicable" &&
      checks.permissionPromptHandled &&
      checks.permissionDenied && !checks.permissionGranted &&
      !checks.recordingCreated &&
      !checks.previewVisible && !checks.uploadAttempted &&
      !checks.uploadCompleted &&
      !checks.storedAudioVerified && !checks.microphoneReleased &&
      !checks.memoryDeleted &&
      Object.values(recording).every((value) => value === null);
  }
  return report.cleanupOutcome === "completed" &&
    checks.permissionPromptHandled &&
    checks.permissionGranted && !checks.permissionDenied &&
    checks.recordingCreated &&
    checks.previewVisible && checks.uploadAttempted && checks.uploadCompleted &&
    checks.storedAudioVerified && checks.microphoneReleased &&
    checks.memoryDeleted &&
    (recording.blobBytes ?? 0) >= policy.minimumBlobBytes &&
    recording.storedBytes === recording.blobBytes &&
    (recording.durationSeconds ?? 0) >= policy.minimumDurationSeconds &&
    (recording.signalRms ?? -1) >= policy.minimumSignalRms &&
    (recording.tone440Ratio ?? -1) >= policy.minimumToneRatio &&
    /^audio\//i.test(recording.contentType ?? "");
}

/** Normalize strict input and fail closed when report, runner, and policy disagree. */
export function normalizeQualityReport(
  raw: unknown,
  args: ImportArguments,
  policy: QualityPolicy,
  reportSha256: string,
): QualityRun {
  const parsedArgs = ImportArgumentsSchema.parse(args);
  const parsedPolicy = GlobalArgumentsSchema.parse(policy);
  const parsedReportSha256 = Sha.parse(reportSha256);
  const report = RawReport.parse(raw);
  let consistent: boolean;
  if (report.kind === "live-ai-provider") {
    if (!parsedPolicy.liveProviderPolicy) {
      throw new TypeError("No policy configured for live-ai-provider reports");
    }
    consistent = liveConsistent(report, parsedPolicy.liveProviderPolicy);
  } else {
    if (!parsedPolicy.physicalDevicePolicy) {
      throw new TypeError("No policy configured for physical-device reports");
    }
    consistent = deviceConsistent(report, parsedPolicy.physicalDevicePolicy);
  }
  const outcome =
    report.outcome === "passed" && parsedArgs.executionExitCode === 0 &&
      report.cleanupOutcome !== "failed" && consistent
      ? "passed"
      : "failed";
  return QualityRunSchema.parse({
    schemaVersion: 1,
    kind: report.kind,
    runAt: report.runAt,
    runId: parsedArgs.runId,
    sha: parsedArgs.sha,
    branch: parsedArgs.branch,
    pullRequest: parsedArgs.pullRequest,
    deployment: parsedArgs.deployment,
    runUrl: parsedArgs.runUrl,
    environment: parsedArgs.environment,
    trigger: parsedArgs.trigger,
    artifact: { name: parsedArgs.artifactName, url: parsedArgs.artifactUrl },
    reportSha256: parsedReportSha256,
    authority: "recording-only",
    executionExitCode: parsedArgs.executionExitCode,
    outcome,
    cleanupOutcome: report.cleanupOutcome,
    errorMessage: report.errorMessage,
    details: report.details,
  });
}

type Handle = { name: string };
type Context = {
  globalArgs: unknown;
  logger: { info(message: string, values?: Record<string, unknown>): void };
  readResource(name: string): Promise<unknown | null>;
  writeResource(
    specName: string,
    name: string,
    data: QualityRun,
  ): Promise<Handle>;
};

function resourceName(environment: string, runId: string): string {
  return `quality-${environment}-${runId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBoundedReport(path: string): Promise<Uint8Array> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    throw new TypeError(
      `Unable to open report file "${path}": ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    const bytes = new Uint8Array(MAX_REPORT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      let count: number | null;
      try {
        count = await file.read(bytes.subarray(offset));
      } catch (error) {
        throw new TypeError(
          `Unable to read report file "${path}": ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (count === null) break;
      offset += count;
    }
    if (offset > MAX_REPORT_BYTES) {
      throw new TypeError(
        `Report file "${path}" exceeds ${MAX_REPORT_BYTES} bytes`,
      );
    }
    return bytes.slice(0, offset);
  } finally {
    file.close();
  }
}

function parseReportJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError(
      `Unable to parse report JSON from "${path}": ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/** Swamp model definition for quality canary evidence. */
export const model = {
  type: "@mgreten/quality-canary-evidence",
  version: "2026.08.28.1",
  globalArguments: GlobalArgumentsSchema,
  resources: {
    qualityRun: {
      description:
        "Run-addressable recording-only evidence from live-provider and physical-device canaries",
      schema: QualityRunSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1,
    },
  },
  methods: {
    importReport: {
      description:
        "Read a bounded local report, reconcile consistency, hash it, and record it",
      arguments: ImportArgumentsSchema,
      execute: async (
        args: ImportArguments,
        context: Context,
      ): Promise<{ dataHandles: Handle[] }> => {
        const parsedArgs = ImportArgumentsSchema.parse(args);
        const policy = GlobalArgumentsSchema.parse(context.globalArgs);
        const name = resourceName(parsedArgs.environment, parsedArgs.runId);
        context.logger.info("Importing quality canary evidence", {
          environment: parsedArgs.environment,
          runId: parsedArgs.runId,
          resourceName: name,
          reportPath: parsedArgs.reportPath,
        });
        const bytes = await readBoundedReport(parsedArgs.reportPath);
        const reportSha256 = Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        const run = normalizeQualityReport(
          parseReportJson(bytes, parsedArgs.reportPath),
          parsedArgs,
          policy,
          reportSha256,
        );
        const existingRaw = await context.readResource(name);
        if (existingRaw !== null) {
          const existing = QualityRunSchema.parse(existingRaw);
          if (JSON.stringify(existing) !== JSON.stringify(run)) {
            throw new TypeError(
              `Run ${run.runId} in environment ${run.environment} already exists with different evidence or provenance`,
            );
          }
          context.logger.info("Completed quality canary evidence import", {
            environment: run.environment,
            runId: run.runId,
            resourceName: name,
            result: "exact-replay",
          });
          return { dataHandles: [] };
        }
        const handle = await context.writeResource("qualityRun", name, run);
        context.logger.info("Completed quality canary evidence import", {
          environment: run.environment,
          runId: run.runId,
          resourceName: name,
          result: "recorded",
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
