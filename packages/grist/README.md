# @mgreten/grist

A [Swamp](https://swamp.club) model extension providing generic [Grist](https://getgrist.com) REST API operations — list tables, inspect columns, read records, write records, create tables, and add columns.

Use this as a building block for Grist-backed Swamp extensions, or as a standalone tool for ad-hoc Grist document operations from the command line.

Works with both self-hosted Grist and [Grist Cloud](https://getgrist.com).

---

## Methods

| Method | Description |
|--------|-------------|
| `checkApi` | Verify connectivity, token, and document access |
| `listTables` | List all table IDs in the document |
| `getColumns` | List columns (id, label, type) for a table |
| `getRecords` | Fetch records with optional server-side filtering |
| `addRecords` | Insert one or more records |
| `updateRecords` | Update existing records by row id |
| `createTable` | Create a new table with specified columns |
| `addColumns` | Add columns to an existing table |

All mutating methods accept `dryRun: true` to preview without writing.

---

## Prerequisites

- A running Grist instance (self-hosted or [getgrist.com](https://getgrist.com))
- A Grist API token with read/write access to your document
- [Swamp](https://swamp.club) CLI installed

### Get Your Document ID

Open your Grist document. The URL looks like:

```
https://grist.example.com/o/myorg/doc/YOURDOCID/p/1
```

The document ID is the alphanumeric string after `/doc/`.

### Get Your API Token

Go to **Profile → API key** in the Grist UI and generate a key.

---

## Vault Setup

Store your token in Swamp vault — never hardcode it:

```bash
swamp vault create @swamp/local my-grist-vault
swamp vault put my-grist-vault GRIST_API_TOKEN
```

---

## Model Creation

```bash
swamp model create @mgreten/grist my-grist \
  --global-arg gristBaseUrl=https://grist.example.com \
  --global-arg gristDocId=YOUR_DOC_ID \
  --global-arg 'gristApiToken=${{ vault.get(my-grist-vault, GRIST_API_TOKEN) }}' \
  --json
```

If your URL includes an org path like `/o/myorg/`, the extension strips it automatically.

---

## Usage

### Check connectivity

```bash
swamp model method run my-grist checkApi
```

### List tables

```bash
swamp model method run my-grist listTables
```

### Inspect columns

```bash
swamp model method run my-grist getColumns --input tableId=MyTable
```

### Fetch records

```bash
swamp model method run my-grist getRecords --input tableId=MyTable
```

With a filter (returns only records where `status` is `active` or `pending`):

```bash
swamp model method run my-grist getRecords \
  --input tableId=MyTable \
  --input 'filter={"status":["active","pending"]}'
```

With a limit:

```bash
swamp model method run my-grist getRecords \
  --input tableId=MyTable \
  --input limit=50
```

### Insert records

```bash
swamp model method run my-grist addRecords \
  --input tableId=MyTable \
  --input 'records=[{"name":"Alice","score":95}]'
```

Preview without writing:

```bash
swamp model method run my-grist addRecords \
  --input tableId=MyTable \
  --input 'records=[{"name":"Alice","score":95}]' \
  --input dryRun=true
```

### Update records

```bash
swamp model method run my-grist updateRecords \
  --input tableId=MyTable \
  --input 'records=[{"id":42,"fields":{"score":100}}]'
```

### Create a table

```bash
swamp model method run my-grist createTable \
  --input tableId=NewTable \
  --input 'columns=[{"id":"name","label":"Name","type":"Text"},{"id":"count","label":"Count","type":"Int"}]'
```

Dry-run first:

```bash
swamp model method run my-grist createTable \
  --input tableId=NewTable \
  --input 'columns=[{"id":"name","label":"Name","type":"Text"}]' \
  --input dryRun=true
```

### Add columns to an existing table

```bash
swamp model method run my-grist addColumns \
  --input tableId=MyTable \
  --input 'columns=[{"id":"notes","label":"Notes","type":"Text"}]'
```

---

## Grist Column Types

| Type | Description |
|------|-------------|
| `Text` | Plain text |
| `Int` | Integer |
| `Numeric` | Floating-point number |
| `Bool` | Boolean (true/false) |
| `Date` | Date (days since epoch in API) |
| `DateTime` | Date + time with timezone |
| `Choice` | Single-select from a list |
| `ChoiceList` | Multi-select from a list |

---

## Filter Syntax

Filters use Grist's column-equality format: keys are column IDs, values are arrays of allowed values (OR within a column, AND across columns).

```json
{ "status": ["active", "pending"], "owner": ["alice"] }
```

Only simple equality is supported server-side. For range queries or complex logic, fetch all records and filter in your workflow.

---

## License

MIT — see [LICENSE.txt](LICENSE.txt)
