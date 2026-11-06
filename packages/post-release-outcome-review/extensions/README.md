# Post-Release Outcome Review

`@mgreten/post-release-outcome-review` validates and stores a caller-supplied,
deterministic outcome review for a released artifact. A human remains
responsible for deciding and carrying out any follow-up.

## Authority boundary

The model has exactly one method, `record`. It validates input and writes one
`review` resource. It does not read systems, call network services, change
deployments, or execute a recommendation. Every accepted review must declare:

```json
{
  "disposition": "recommendation-only",
  "humanDecisionRequired": true,
  "mayExecute": false,
  "productionEffects": "none"
}
```

Allowed recommendations are `keep`, `iterate`, `revert`, `gather_evidence`, and
`stop`. The chosen recommendation must match the policy mapping for the
deterministically derived aggregate outcome.

## Use

```sh
swamp extension pull @mgreten/post-release-outcome-review
swamp model create @mgreten/post-release-outcome-review release-review
swamp model method run release-review record \
  --input recordId=review-2026-08-23 \
  --input review="$(cat review.json)"
```

The schema version is `2.0`. A review binds immutable references for the
release, work order, and measurement plan; includes one observation per policy
metric; and supplies digest-bound, fresh post-window evidence. `recordId` must
exactly match the review's `reviewId`, so identical replays target the same
resource identity. It rejects mismatched units, overlapping thresholds, invented
comparisons, or an early review. See the synthetic test file for a complete
valid fixture and negative cases.
