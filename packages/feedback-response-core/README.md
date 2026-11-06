# Feedback Response Core

`@mgreten/feedback-response-core` is a standalone, privacy-bounded Swamp model
for deterministic feedback classification and draft creation. It has exactly one
method: `classifyAndDraft`.

## Boundaries

- The method accepts only a redacted feedback artifact and preserves the
  explicit limitation: pattern-based redaction is **not** a guarantee that all
  private information was detected.
- Input validation rejects common email, URL, credential, diagnosis, and
  promise-like patterns. This is defense in depth, not a PII detector.
- The model has no global configuration, tokens, routes, provider calls, or
  network calls. It creates a persisted response packet only.
- A draft is content for later human handling. This package has no contact,
  sending, source-closure, approval, or authority interface.

## Usage

Create a model instance of type `@mgreten/feedback-response-core`, then call
`classifyAndDraft` with one complete input envelope. The artifact must already
be normalized and redacted by the producer. Exactly one of `bug`, `confusion`,
`feature_request`, or `other` must appear in `artifact.labels`.

```yaml
type: "@mgreten/feedback-response-core"
version: "2026.08.23.1"
```

The method input includes a stable response ID, evaluation timestamp, artifact,
assessment flags, and product-decision state. An unknown decision must use null
for every decision binding field:

```json
{
  "schemaVersion": "1.0",
  "responseId": "response-synthetic-1",
  "evaluatedAt": "2026-08-23T12:00:00Z",
  "artifact": {
    "schemaVersion": "1.0",
    "feedbackId": "feedback-synthetic-1",
    "sourceId": "source-synthetic-1",
    "normalizedText": "Playback stops after pause.",
    "labels": ["bug"],
    "provenance": {
      "inputEnvelopeId": "envelope-synthetic-1",
      "sourceId": "source-synthetic-1",
      "normalizedAt": "2026-08-23T12:00:00Z",
      "normalizer": "bounded-normalizer",
      "normalizerVersion": "1"
    },
    "redaction": {
      "method": "deterministic-redaction",
      "methodVersion": "1",
      "performedAt": "2026-08-23T12:00:00Z",
      "inputEnvelopeId": "envelope-synthetic-1",
      "categoriesRemoved": [],
      "replacementCount": 0,
      "reviewStatus": "not_reviewed",
      "limitations": "pattern-based redaction does not guarantee detection of all private information"
    }
  },
  "assessment": {
    "suspectedDataLoss": false,
    "suspectedSecurityIncident": false,
    "confirmedBroadOutage": false,
    "blocksCoreUse": true,
    "repeatedContact": false,
    "sensitiveIssue": false,
    "duplicate": false,
    "actionable": true,
    "praiseOnly": false
  },
  "productDecision": {
    "availability": "unknown",
    "decisionId": null,
    "version": null,
    "sha256": null,
    "customerSafeStatement": null
  }
}
```

On success the method writes one infinite-lifetime `response` resource named by
`responseId`. An exact replay is idempotent; changed content under the same ID is
rejected. Critical security or data-loss assessments and sensitive issues
are held without a draft. Other validated inputs produce a generic draft or a
no-draft disposition according to the assessment flags. Every generated draft
contains a deterministic SHA-256 binding, but still requires human review.

## Compatibility

This is a deliberate extraction and rename of the reusable
`@mgreten/feedback-response` classify/draft core. It is **not** a drop-in
replacement for that integration model:

- Type: use `@mgreten/feedback-response-core` at version `2026.08.23.1`.
- Method: `classifyAndDraft` retains the input assessment, category, redaction,
  and product-decision validation rules, and retains deterministic SHA-256
  bindings.
- Artifact: provide the redacted artifact fields defined by this package. An
  adapter from the original normalized artifact may omit its integration-only
  `handling` object.
- Output: this package intentionally omits the original `approval` and
  `authority` fields, all publication arguments, and the publisher method.
- Copy: drafts are generic; no product name or product-specific wording is
  included.

Consumers should treat the persisted packet as classification evidence, not a
message-send instruction. Its output shape is bounded as follows:

```json
{
  "classification": {
    "severity": "medium",
    "urgency": "within-1-business-day",
    "escalationReasons": ["blocks-core-use"],
    "draftDisposition": "personalized-draft"
  },
  "draft": {
    "text": "Generic acknowledgement and reviewed-decision context.",
    "facts": ["Bounded classification facts."],
    "unknowns": ["No reviewed decision is currently available."],
    "nextStep": "Human review is required before any use of this draft.",
    "binding": { "id": "response-synthetic-1", "version": "1.0", "sha256": "<64 lowercase hex characters>" }
  }
}
```

Licensed under the MIT License. See [LICENSE](LICENSE).
