# Public-Safe Draft

A deterministic Swamp model for turning caller-supplied reflective writing into a review-required public draft.

It preserves a thesis, a meaningful journey, and a reusable lesson while replacing common operational breadcrumbs with a configurable redaction label.

## What it does

- Accepts only text provided to the `draft` method.
- Composes a Markdown draft with thesis, journey, reusable lesson, and publication reminder.
- Redacts caller-supplied sensitive terms plus common credential-like values, Tailnet URLs, local hostnames, private IP addresses, and absolute Unix-style paths.
- Persists a typed `current` draft artifact with redaction metadata, a manual review checklist, and stated limitations.

## What it does not do

- It does not read conversations, agent memory, private files, credentials, or network services.
- It does not decide that a draft is safe to publish.
- It does not publish, write source material, or make network requests.

Automated redaction is a safeguard, not proof. Review every generated draft before sharing it.

## Method input

```json
{
  "title": "Making a Private Debugging Story Safe to Share",
  "thesis": "A useful public reflection preserves the real journey while removing operational details and naming the lesson clearly.",
  "journey": "Describe the discovery, repair, and outcome in your own words.",
  "lesson": "State the reusable practice a reader can apply.",
  "sensitiveTerms": ["known-private-hostname", "known-project-name"]
}
```

## Output

The `draft` method stores the `current` resource. It includes the generated Markdown, a redaction summary that never echoes the matched values, three manual privacy-review prompts, and model limitations.

## Development status

This repository is private for review. It is not a registry release, and its contents must be audited before any visibility change or Swamp registry publication.

## License

MIT. See [LICENSE.md](LICENSE.md).
