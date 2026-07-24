# Public Draft Check

A deterministic Swamp guardrail that checks a candidate public draft for common disclosure indicators and returns a typed report to an agent or workflow.

It does not rewrite the draft or decide that it is safe to publish. A clear report means only that no configured deterministic rule matched; independent agent review and human approval remain required.

## What it does

- Accepts a candidate draft and caller-supplied sensitive terms through the `check` method.
- Blocks on exact sensitive terms, common credential-like values, private hostnames, Tailscale hostnames, and validated RFC1918 IPv4 addresses.
- Flags common absolute filesystem paths, email addresses, and UUIDs for review.
- Reports only rule identifiers, counts, and line/column locations; matched text is not echoed.
- Persists a typed `current` report for a downstream agent or workflow.

## What it does not do

- It does not rewrite or redact the draft.
- It does not detect every credential, personal detail, or contextual disclosure.
- It does not decide that a draft is safe to publish.
- It does not read files, inspect agent memory, make network requests, or publish anything.

Deterministic checking is a guardrail, not proof. Review every draft before sharing it.

## Check input

```json
{
  "draft": "The candidate Markdown produced by an agent.",
  "sensitiveTerms": ["known-private-hostname", "known-project-name"]
}
```

## Output

The `check` method stores the `current` report with a `clear`, `review_required`, or `blocked` status. Findings include a stable rule identifier, severity, occurrence count, and one-based Unicode line/column locations. Up to 50 locations are returned per rule; `locationsTruncated` indicates additional occurrences. Reports never include the candidate text, matched values, or surrounding snippets.

`clear` does not mean safe or approved. Every report has `manualReviewRequired: true`.

```json
{
  "status": "blocked",
  "blockingRuleCount": 1,
  "reviewRuleCount": 0,
  "findings": [
    {
      "rule": "caller-supplied-sensitive-term",
      "severity": "block",
      "count": 1,
      "locations": [{ "line": 3, "column": 12 }],
      "locationsTruncated": false,
      "message": "A caller-supplied sensitive term remains."
    }
  ],
  "manualReviewRequired": true,
  "limitations": [
    "A clear report only means that no configured deterministic rule matched.",
    "Semantic or contextual disclosures require independent agent and human review.",
    "The checker does not rewrite the draft or approve it for publication."
  ]
}
```

## Project status

The source is public at [meagerfindings/swamp-public-draft-check](https://github.com/meagerfindings/swamp-public-draft-check). Registry releases use the package name `@mgreten/public-draft-check`.

## License

MIT. See [LICENSE.md](LICENSE.md).
