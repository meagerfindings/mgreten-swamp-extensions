# @mgreten/manyfold-importer

Import local 3D model files into a directory that Manyfold can see. This extension is designed for self-hosted Manyfold deployments where a library is backed by a mounted filesystem path. It plans and performs copy, move, hardlink, or symlink imports, keeps relative directory structure when desired, records an import summary resource, and defaults to dry-run mode so agents can inspect changes before moving large collections.

## Installation

```sh
swamp extension pull @mgreten/manyfold-importer
```

## Setup

Create a model instance with the Manyfold library path visible to the runner:

```sh
swamp model create manyfold-importer --type @mgreten/manyfold-importer \
  --global-args '{"defaultLibraryPath":"/srv/manyfold/models"}'
```

If you later wire an API scan endpoint, add a base URL and vault-backed token:

```sh
swamp model create manyfold-importer --type @mgreten/manyfold-importer \
  --global-args '{"defaultLibraryPath":"/srv/manyfold/models","manyfoldBaseUrl":"https://manyfold.example.test","apiToken":"${{ vault.get(app-secrets, MANYFOLD_API_TOKEN) }}"}'
```

## Usage

Preview an import without changing files:

```sh
swamp model method run manyfold-importer importDirectory \
  --input '{"sourcePath":"/incoming/3d-models","dryRun":true}'
```

Import by preserving the source tree under the library:

```sh
swamp model method run manyfold-importer importDirectory \
  --input '{"sourcePath":"/incoming/3d-models","dryRun":false,"mode":"copy","preserveRelativePaths":true}'
```

Use hardlinks for a watched directory on the same filesystem:

```sh
swamp model method run manyfold-importer importDirectory \
  --input '{"sourcePath":"/watched/dropbox","destinationPath":"/srv/manyfold/models","mode":"hardlink","dryRun":false}'
```

## Global Arguments

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultLibraryPath` | string | unset | Destination path for imports when a method call does not pass `destinationPath`. |
| `defaultExtensions` | string[] | common 3D model/archive/slicer extensions | File extensions included by default. |
| `manyfoldBaseUrl` | string | unset | Base URL for optional scan API calls. |
| `apiToken` | string | unset | Optional bearer token or vault expression for API calls. |

## Method: `uploadFile`

Upload a single local file to an HTTP endpoint using multipart form data. Keep this as the primitive for API-first workflows, then call it repeatedly from a workflow or a future watcher when your Manyfold endpoint/auth flow is known.

```sh
swamp model method run manyfold-importer uploadFile \
  --input '{"sourcePath":"/incoming/benchy.stl","uploadUrl":"https://manyfold.example.test/upload","dryRun":true}'
```

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `sourcePath` | string | yes | Local file to upload. |
| `uploadUrl` | string | yes | Full HTTP upload URL. |
| `uploadFieldName` | string | no | Multipart file field name; default `file`. |
| `dryRun` | boolean | no | Defaults to `true`; plans without sending the file. |

## Method: `importDirectory`

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `sourcePath` | string | yes | Source file or directory to scan. |
| `destinationPath` | string | no | Destination library path; defaults to `defaultLibraryPath`. |
| `mode` | enum | no | `copy`, `move`, `hardlink`, or `symlink`; default `copy`. |
| `dryRun` | boolean | no | Defaults to `true`; plans without writing files. |
| `overwrite` | boolean | no | Replace destination files that already exist. |
| `extensions` | string[] | no | Override extension filter for this run. |
| `preserveRelativePaths` | boolean | no | Keep source subdirectories under destination; default `true`. |
| `triggerScan` | boolean | no | Calls `scanEndpoint` after import when configured. |
| `scanEndpoint` | string | no | Relative scan endpoint; Manyfold versions may differ. |

## How It Works

The extension walks the source tree, filters files by extension, computes destination paths, and records a summary of planned, imported, skipped, and failed files. It does not store credentials in outputs and does not require API credentials for filesystem imports. For watched directories, run it repeatedly in dry-run mode first, then use `copy`, `hardlink`, or `move` depending on whether the destination is on the same filesystem and whether the source should be retained.

## License

MIT — see LICENSE for details.
