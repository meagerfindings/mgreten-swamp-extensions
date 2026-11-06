# Quality Canary Evidence

`@mgreten/quality-canary-evidence` imports reports produced by authoritative
live-AI-provider and physical-device canary runners. It reads one local JSON
file (maximum 1 MiB), strictly validates and normalizes it, records its SHA-256
digest and runner provenance, reconciles the runner exit code with configured
consistency rules, and retains an infinite-lifetime `qualityRun` resource.

The model is **recording-only**. It does not run a canary, call an AI or device
provider, approve a release, or grant deployment authority. A caller-declared
pass becomes a failure whenever the runner failed, cleanup failed, or any
configured consistency check fails. Report schemas reject unknown fields.

## Configuration

Policy is explicit global configuration under optional, strict
`liveProviderPolicy` and `physicalDevicePolicy` objects. At least one is
required, so consumers may configure live-provider canaries only,
physical-device canaries only, or both. A report is rejected when its
corresponding policy is absent. Each nested policy owns all checks relevant to
that report kind and validates its own uniqueness and coherence.

### Live-provider only

```yaml
globalArguments:
  liveProviderPolicy:
    expectedTranscriptionModels: [speech-model]
    expectedMetadataModels: [metadata-model]
    expectedAudioSha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    expectedKeywords: [cedar, river, silver]
    minimumKeywordMatches: 2
    requiredMetadataSchemaVersions: [1]
    requiredMetadataFeatures: [title, themes, sentiment, summary]
```

### Physical-device only

```yaml
globalArguments:
  physicalDevicePolicy:
    devicePolicies:
      - provider: device-cloud
        platforms: [android, ios]
        inputModes: [injected]
    minimumBlobBytes: 100
    minimumDurationSeconds: 1
    minimumSignalRms: 0.01
    minimumToneRatio: 0.1
```

### Both

```yaml
globalArguments:
  liveProviderPolicy:
    expectedTranscriptionModels: [speech-model]
    expectedMetadataModels: [metadata-model]
    expectedAudioSha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    expectedKeywords: [cedar, river, silver]
    minimumKeywordMatches: 2
    requiredMetadataSchemaVersions: [1]
    requiredMetadataFeatures: [title, themes, sentiment, summary]
  physicalDevicePolicy:
    devicePolicies:
      - provider: device-cloud
        platforms: [android, ios]
        inputModes: [injected]
    minimumBlobBytes: 100
    minimumDurationSeconds: 1
    minimumSignalRms: 0.01
    minimumToneRatio: 0.1
```

Live-provider reports use only `liveProviderPolicy`; physical-device reports use
only `physicalDevicePolicy`. An empty `globalArguments` object is invalid, as is
importing either report kind with only the other kind's policy configured.

Import provenance identifies the immutable runner execution and public artifact.
URLs cannot contain credentials, query parameters, or fragments.

```bash
swamp model method run my-quality-canaries importReport \
  --input reportPath=/tmp/canary.json \
  --input executionExitCode=0 \
  --input runId=canary-123 \
  --input sha=abcdef1 \
  --input branch=main \
  --input runUrl=https://ci.example/runs/123 \
  --input environment=production \
  --input trigger=manual \
  --input artifactName=canary-123 \
  --input artifactUrl=https://ci.example/artifacts/123
```

Each run is stored at `quality-<environment>-<runId>`, so current and historical
runs remain independently addressable. An exact replay is a no-op. Reusing any
historical environment/run ID with changed report bytes, digest, provenance, or
normalized evidence is rejected. A different run ID creates a different resource
instance rather than a new version of an environment-wide instance.

The resource lifetime is `infinite`: Swamp does not expire these instances.
`garbageCollection: 1` retains one version per run-addressable instance because
successful imports are immutable and exact replays do not write another version.
Repository operators or datastore retention policies can still remove data
externally; this extension provides no retention-period guarantee or pruning
method.

## Why this is not `test-evidence-validator`

The generic `@mgreten/test-evidence-validator` validates parsed test-runner
counts and recognized multi-language commands, then commit-pins a generic test
verdict. This extension instead understands domain-specific live model output,
metadata features, permission scenarios, device recording integrity, cleanup,
audio signal thresholds, and provider/platform/input-mode policy. Use the
generic validator for ordinary suites; use this model only for these two canary
report contracts.
