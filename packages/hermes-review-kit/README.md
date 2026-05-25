# Hermes Review Kit

Public Swamp package for nightly Hermes review automation.

## Included pieces

- **Model**: `@mgreten/hermes-review-collector`
  - scans recent Hermes sessions and nearby repo activity
  - writes a structured JSON summary for nightly review
- **Report**: `@mgreten/hermes-review-report`
  - turns the collector output into a concise human summary
  - highlights reusable patterns, publishable ideas, and approval questions
- **Workflow**: `@mgreten/hermes-daily-review`
  - runs nightly at 11:00 p.m. Mountain / 05:00 UTC
  - attaches the review report automatically

## Intended use

This kit is meant to support:

- Hermes daily reviews
- Harmony support triage patterns
- repeatable review/publishability workflows
- public Swamp community reuse

## Local setup

1. Create the model instance:

```bash
swamp model create @mgreten/hermes-review-collector hermes-review-collector
```

2. Point the workflow at that model instance name if you choose a different one.
3. Run the workflow manually once before relying on the nightly schedule.

## Notes

The collector is intentionally local-first:

- reads `~/.hermes/sessions` for session transcripts
- scans recent files under the repo root for activity signals
- avoids network calls and external APIs

## Example run

```bash
swamp workflow run hermes-daily-review --repo-dir /opt/data/swamp-hub
```

## What to expect

A successful nightly run should produce a report that answers three questions:

1. What happened today that matters tomorrow?
2. Which actions or workflows were repeatable enough to turn into a Swamp model, report, or workflow?
3. Which items need Mat's approval before anything is published publicly?

If the collector starts reaching outside the local repository and Hermes session store, that is a design smell. The intended shape is deterministic, local-first, and easy to audit.
