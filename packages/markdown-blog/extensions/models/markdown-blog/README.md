# Markdown Blog

Write in Markdown. Inspect the HTML. Write that exact version locally. Verify it
before handing it to your deployment workflow.

`@mgreten/markdown-blog` is an extension package containing one model type and a
write-and-verify workflow. It is not a hosting service or an AI writer. There
are no added JavaScript packages beyond Swamp's existing Zod schema dependency.

For the story behind the package, read
[I Wanted to Write, Not Manage a Website](https://matgreten.dev/posts/i-replaced-jekyll-with-a-publishing-workflow/).
That article describes my site's full publishing workflow; this package covers
local rendering, writing, and verification, not deployment.

## Requirements

- Swamp with `context.extensionFile()` and manifest `binaries` support;
  developed against `20261003.192630.0-sha.bed0772a`.
- Local Linux execution, Python 3.10, Python-Markdown **3.3.6**, and PyYAML
  **5.4.1**. Other hosts are not yet certified. No remote-worker support is
  claimed: Swamp does not automatically deliver `binaries` assets to workers.
- A trusted local repository on a filesystem supporting hard links and atomic
  rename. No hostile concurrent filesystem writers.

The renderer uses `python3 -I -B`. It checks package versions and fails rather
than installing dependencies or silently switching parsers. An existing
virtualenv can be selected with
`pythonExecutable=/absolute/path/to/venv/bin/python`; isolated mode ignores
user-site packages and `PYTHONPATH`. The pinned requirements describe the
existing tested environment, not a promise that old PyYAML builds on every
modern Python. Inspect the bundled Python source when Swamp warns about a
binary.

## Quick start

Install from the Swamp registry:

```bash
swamp extension pull @mgreten/markdown-blog
swamp model create @mgreten/markdown-blog my-blog \
  --global-arg 'siteTitle=My Notes' --global-arg outputDir=public/posts
```

Create a draft such as `drafts/hello.md`:

```markdown
---
title: Hello, Markdown
date: 2026-10-15
slug: hello-markdown
excerpt: A small example of deliberate publishing.
---

Private planning goes here.

<!-- blog:content:start -->

This is the **public article**.

## A useful heading

An ordinary paragraph with a [public link](https://example.com/).

<!-- blog:content:end -->

Private follow-up goes here.
```

Run commands from your Swamp repository:

```bash
swamp model method run my-blog preview --input sourcePath=drafts/hello.md
swamp data query 'model("my-blog") && name == "preview-hello-markdown"' \
  --select content --single --json
```

Inspect `previewPath`. It is relative to your repository and includes the render
hash, so newer previews do not replace older ones. Use the site root when
serving previews if your template refers to root-relative CSS or assets.

Copy **both hashes from the preview you actually reviewed**, then run:

```bash
swamp workflow validate @mgreten/markdown-blog/write-and-verify
swamp workflow run @mgreten/markdown-blog/write-and-verify \
  --input modelName=my-blog --input sourcePath=drafts/hello.md \
  --input operation=create \
  --input expectedRenderHash='<reviewed renderHash>' \
  --input expectedHtmlHash='<reviewed htmlHash>'
```

Do not substitute an automatically fetched latest hash. The workflow has no
automatic preview or deployment step; supplying hashes is not proof that a
person approved anything. Human review remains your responsibility.

## Model methods and data

| Method    | Inputs                                          | Result                                                                                                    |
| --------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `preview` | `sourcePath`                                    | `preview-<slug>`: public metadata, source/render/HTML hashes, renderer identity, output and preview paths |
| `write`   | `sourcePath`, `expectedRenderHash`, `operation` | `post-<slug>`: public metadata, source/HTML hashes, renderer identity and local output path               |
| `verify`  | `sourcePath`, `expectedHtmlHash`                | `verification-<slug>` with the same artifact fields; fails if the current source/template or post differs |

All methods return Swamp data handles. No complete Markdown source or private
frontmatter is persisted by this model. Swamp can still record method inputs
such as your source path; use a private datastore for private drafts.

`create` refuses an existing post. `update` requires one and replaces the whole
page from Markdown and the configured template. Unlike the original
site-specific model, it does **not** recover cover/affiliate metadata from
previous HTML: put images in the public Markdown or your trusted template. A
changed existing page invalidates the old preview before any overwrite.

The write hash covers source bytes, generated HTML, template bytes,
configuration, renderer/helper identity, package version, target path and
previous page. External CSS, linked images and other assets are not frozen.
Rendering is deterministic within the same renderer environment; image
generation is outside this package.

## Configuration and templates

| Global argument    | Default          | Purpose                                                            |
| ------------------ | ---------------- | ------------------------------------------------------------------ |
| `siteTitle`        | `Notes`          | Escaped site title                                                 |
| `outputDir`        | `posts`          | Repo-relative directory; output is `<outputDir>/<slug>/index.html` |
| `templatePath`     | bundled template | Trusted absolute or repo-relative UTF-8 template                   |
| `pythonExecutable` | `python3`        | Existing Python executable, not shell syntax                       |

The default template is intentionally unstyled semantic HTML with no JavaScript,
fonts, trackers, network assets, personal branding or canonical domain.

Templates must contain exactly one `{{body}}`. Other tokens are `{{title}}`,
`{{date}}`, `{{slug}}`, `{{excerpt}}`, `{{siteTitle}}`, `{{series}}`, and
`{{seriesOrder}}`. Unknown tokens fail. Tokens are replaced once; token-looking
text in the article stays literal. Only `body` contains generated HTML; the rest
are escaped text. Place them in HTML text or quoted ordinary attributes, never
JavaScript, CSS or executable URL contexts. Templates are trusted code, not
sanitized user input. Keep page styling and layout in your own template.

## Supported Markdown and privacy boundaries

- Required metadata: `title` (1–200 characters), real `date` (`YYYY-MM-DD`),
  `slug` (1–100 lowercase alphanumeric/hyphen characters), and `excerpt` (1–1000
  characters). Optional: `series` (1–200 characters), integer `seriesOrder`.
- Both content markers must occur exactly once, on standalone lines, in order.
  Everything outside them is excluded from the page. Begin public headings at
  H2; the template supplies H1. Source and template files are limited to 1 MiB
  each.
- Ordinary Markdown, lists, tables, heading anchors and root-level fenced code
  work. Heading IDs begin with `section-`. `diagram` fences display as plain
  text; diagrams are not executed or rendered by another library.
- Raw HTML is escaped. Unsafe links/attributes, fence brace attributes, YAML
  aliases/duplicate keys and unresolved Obsidian links, comments and callouts
  outside code are rejected. Use HTTP(S), root-relative site URLs, mailto links
  or heading fragments, not vault-relative paths.

Do not put private material between the markers or in publication metadata. The
renderer cannot decide whether a sentence was meant to be public.

## Operational boundaries

The model performs **no** Git operations, uploads, CDN purges, cover generation,
homepage/RSS rebuilds or live-site checks. Compose those consumer-owned methods
after successful verification in a separate, explicitly authorized workflow.
This separation follows Swamp's
[extension](https://github.com/swamp-club/swamp/blob/bed0772a/design/primitives/extensions.md)
and
[workflow](https://github.com/swamp-club/swamp/blob/bed0772a/design/primitives/workflows.md)
primitives: distribute capabilities in the package; orchestrate site-specific
actions in the consumer repository.

Exclude `.generated/` and all extension/source files from deployment. Ignore
`.generated/` in Git. Previews are local files, not Swamp-managed file
artifacts; resource garbage collection does not delete them. Remove old previews
deliberately when they are no longer needed.

Writes use a per-post exclusive lock, a temporary sibling file, and atomic
replacement. A killed process can leave a `.markdown-blog.lock` or temporary
file; confirm no writer is active before removing it. Locks do not coordinate
unrelated editors. A datastore failure after replacement can leave correct HTML
without a recorded result: run `verify` with the reviewed `htmlHash`, rather
than blindly retrying `create`. If content changed, take a new preview and
explicitly update.

## Development

From a Swamp repository, add the source checkout:

```bash
swamp extension source add /path/to/swamp-markdown-blog
```

Tests use disposable directories and real Python parsing, not production posts:

```bash
~/.swamp/deno/deno test -A extensions/models/markdown-blog/markdown_blog_test.ts
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Mat Greten.

This package is maintained in the `mgreten` collective; it contains no deployment
credentials or company configuration.
