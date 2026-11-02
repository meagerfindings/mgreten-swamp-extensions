# Election evidence compiler

Politically neutral Swamp types for assembling reviewed public evidence. The compiler has no party scores, preferred organizations, voter profile, past votes or built-in endorsements. User-supplied prose still requires editorial and privacy review. A successful audit establishes structural completeness, not factual truth or political neutrality of every submitted sentence.

## Install

In an initialized Swamp repository:

```bash
swamp extension pull @mgreten/election-packet --json
swamp model type describe @mgreten/election-packet --json
swamp model type describe @mgreten/election-pdf --json
```

## Methods and data

`@mgreten/election-packet` has three methods:

- `prepare`: accepts `ballot`, `sources` and `asOf`; returns a new `draft` dataset with one pending subject per ballot entry. It does not carry research or choices forward.
- `audit`: accepts `packet`; returns `ready`, `issues`, `unknowns` and `itemCount`.
- `render`: accepts `packet`; refuses unresolved audit issues, then returns `document.markdown`, `html`, `appendixMarkdown` and `appendixHtml`.

The JSON in `examples/election-packet.json` is a **fictional test**, not a real ballot or evidence source. Its outer `packet` is the render/audit input. `outputStem` is used by PDF/local orchestration. Copy the structure, not its reviewed flags, dates or synthetic findings. Inspect the actual schema with `swamp model type describe @mgreten/election-packet --json`.

The schema binds each candidate, measure and judge to an explicit ballot item ID and kind. Label candidates with office and name. Include every candidate listed for that office, not just a selected candidate. Record sourced Yes/No and fiscal effects for each measure, alongside independently attributed organizations' positions. Judge records contain appointment, evaluation, accountability and specific cases with the judge's role, legal remedy and limits.

Each fact has `text`, `status` (`documented`, `allegation`, `opinion`, `unknown`) and source IDs. Explain unavailable evidence explicitly as `unknown`; a placeholder is not research. Every other status needs a citation. Each fact is limited to 55 words. Short summaries and judge appointments/evaluations appear in the concise packet; candidate details and judicial cases/accountability appear in the separate appendix. Source links appear in both.

Audits reject missing/extra/mismatched entries, duplicate IDs, pending review, unresearched placeholders, invalid citation IDs, source access dates after `asOf`, and current sources checked over 30 days before `asOf`. Historical sources are explicitly marked. Set `asOf` to the actual research cutoff and recheck current election facts each cycle. The compiler does not verify that a source was read, confirm a district, OCR a ballot, fetch a URL, investigate allegations or determine a vote.

Only public HTTPS citations without query strings are accepted. Link to the canonical public page/PDF rather than a signed attachment, account URL or token-bearing download. This URL rule is a conservative format restriction, not a public-access or privacy guarantee. Citation kind distinguishes official, campaign, reporting, advocacy and opinion sources. Renderers escape prose as text, not authored HTML.

## PDF export

`@mgreten/election-pdf` takes a configured absolute `outputRoot`. Its `export` method accepts the same `packet` and a relative `outputStem`, with existing parent directories. It creates `<stem>.pdf` and `<stem> - Evidence.pdf` beneath that root. Existing outputs are refused; use a new versioned stem. Symlink descendants and traversal components are refused. It renders from the validated packet rather than accepting arbitrary HTML.

The exporter requires `uvx`, WeasyPrint's native text/font libraries, and fonts on the execution host. It invokes pinned `weasyprint==68.0`; `uvx` may download that package and dependencies on its first use. No election content is uploaded by the exporter. It uses generated HTML with inline styles and source hyperlinks, not remote images/styles. PDFs are local files; the Swamp `receipt` records their paths. Native libraries and fonts can still affect layout, so inspect representative PDF pages before delivery. A multi-file write is not a transaction against another local editor or sync client.

## Packaging boundary

`manifest.yaml` allowlists these two neutral model files, this README and the fictional JSON example. It includes **no workflows, source notes, real ballot data, voter profiles, vote histories or runtime receipts**. Model instances and their configured roots are also outside the bundle. This manifest is not authorization to publish. Before an explicitly authorized release, inspect the resolved archive, dependencies and metadata; never publish a runtime directory or add a broad file glob.

## Checks

```bash
~/.swamp/deno/deno check extensions/models/election_packet.ts extensions/models/election_pdf.ts
~/.swamp/deno/deno test --allow-read --allow-write --allow-run --allow-env=PATH extensions/models/
```

Tests use fictional evidence. PDF tests substitute a temporary local renderer using `/bin/sh` and `cat`; they do not download or run WeasyPrint. They check distinct concise/appendix output, failed rendering, invalid PDF output, overwrite protection and path safety. Real election research and voter decisions are not test fixtures.
