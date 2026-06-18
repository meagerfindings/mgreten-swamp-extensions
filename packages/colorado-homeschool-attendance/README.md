# @mgreten/colorado-homeschool-attendance

A [Swamp](https://swamp.club) model extension for tracking Colorado homeschool attendance and learning sessions, backed by a self-hosted or cloud [Grist](https://getgrist.com) document.

> **Not legal advice.** This tool is designed to help families organize their homeschool records. Always verify current Colorado homeschool law requirements with a qualified attorney or the Colorado Department of Education.

---

## What It Does

- Tracks **students**, **school years**, **subjects**, and **resources** in Grist
- Records **learning sessions** (student, date, subject, minutes, description) from any source
- Ingests **capture events** from Discord, Todoist, voice transcripts, email, Obsidian, or manual entry
- Computes **attendance days** by aggregating sessions per student per date
- Generates **progress summaries** and persists **compliance snapshots** to Grist
- Exports school year data as JSON, Markdown, or CSV
- First-class **test entry isolation**: all smoke-test data is tagged `is_test=true` and excluded from exports and summaries by default

## What It Does NOT Do

- No immunization records
- No exemption statements
- No medical records
- No public school / camp immunization tracking
- No legal filings or official compliance submissions

## Colorado Defaults

The model defaults to Colorado's commonly-cited homeschool requirements:

| Setting | Default |
|---------|---------|
| Required instructional days | 172 |
| Target avg contact hours/day | 4 |

These are stored on the `SchoolYears` table in Grist — override them per year. **Confirm your legal requirements independently.**

---

## Prerequisites

- A running [Grist](https://getgrist.com) instance (self-hosted or cloud)
- A Grist API token with read/write access to your document
- [Swamp](https://swamp.club) CLI installed

## Grist Setup

### Self-hosted Grist

If you run Grist in Docker (e.g. at `https://grist.example.com`), create a document in the org you want to use, then grab your API token from **Profile → API key**.

### Grist Cloud

Create a free account at [getgrist.com](https://getgrist.com), create a document, and generate an API key from your profile.

### Get Your Document ID

Open your Grist document. The URL looks like:

```
https://grist.example.com/o/homeschool/doc/YOURDOCID/
```

The document ID is the alphanumeric string after `/doc/`.

---

## Vault Setup

Store your Grist API token in Swamp vault so it's never hardcoded:

```bash
swamp vault create @swamp/local homeschool-grist
swamp vault put homeschool-grist GRIST_API_TOKEN
```

---

## Model Creation

```bash
swamp model create @mgreten/colorado-homeschool-attendance homeschool-attendance \
  --global-arg gristBaseUrl=https://grist.example.com \
  --global-arg gristDocId=YOUR_DOC_ID \
  --global-arg 'gristApiToken=${{ vault.get(homeschool-grist, GRIST_API_TOKEN) }}' \
  --global-arg timezone=America/Denver \
  --global-arg defaultSchoolYear=2026-2027 \
  --json
```

Replace `https://grist.example.com` with your Grist URL. If your URL includes an org path like `/o/homeschool/`, the extension strips it automatically.

---

## Usage

### 1. Validate Configuration

Confirm Swamp can reach your Grist document:

```bash
swamp model method run homeschool-attendance validateConfig
```

### 2. Set Up Grist Schema

Preview what would be created:

```bash
swamp model method run homeschool-attendance ensureSchema \
  --input dryRun=true
```

Create missing tables and columns:

```bash
swamp model method run homeschool-attendance ensureSchema \
  --input createMissing=true
```

### 3. Add Test Entries (Smoke Test)

Create test records to verify the pipeline works end-to-end:

```bash
swamp model method run homeschool-attendance addTestEntries \
  --input schoolYear=2026-2027 \
  --input 'students=["Alice","Bob"]' \
  --input testReason="initial smoke test"
```

List them:

```bash
swamp model method run homeschool-attendance listTestEntries \
  --input schoolYear=2026-2027
```

### 4. Add a Capture Event

```bash
swamp model method run homeschool-attendance addCaptureEvent \
  --input source=manual \
  --input eventDate=2026-09-15 \
  --input rawText="Alice did 45 min of Singapore Math 5A today"
```

### 5. Add Learning Sessions

```bash
swamp model method run homeschool-attendance addLearningSessions \
  --input 'sessions=[{"student":"Alice","date":"2026-09-15","subject":"Math","minutes":45,"description":"Singapore Math 5A lesson 3"}]'
```

### 6. Compute Attendance Days

Aggregate sessions into per-day attendance records:

```bash
swamp model method run homeschool-attendance computeAttendanceDays \
  --input schoolYear=2026-2027
```

### 7. Summarize Progress

```bash
swamp model method run homeschool-attendance summarizeProgress \
  --input schoolYear=2026-2027
```

### 8. Export

Export as JSON (tests excluded by default):

```bash
swamp model method run homeschool-attendance exportSchoolYear \
  --input schoolYear=2026-2027
```

Export as Markdown:

```bash
swamp model method run homeschool-attendance exportSchoolYear \
  --input schoolYear=2026-2027 \
  --input format=markdown
```

To include test entries in an export (not recommended for compliance use):

```bash
swamp model method run homeschool-attendance exportSchoolYear \
  --input schoolYear=2026-2027 \
  --input includeTests=true
```

---

## Test Entry Isolation

Every method that writes data accepts `isTest: boolean` and `testReason: string`. Every method that reads data accepts `includeTests: boolean` (default `false`).

- `addTestEntries` creates realistic-looking sessions, capture events, and attendance days all tagged `is_test=true`
- `summarizeProgress`, `computeAttendanceDays`, and `exportSchoolYear` filter out `is_test=true` records by default
- To inspect only test entries: `listTestEntries`

---

## Suggested Grist Views (Manual Setup)

Grist view/page creation is not supported via the API. Create these pages manually in the Grist UI:

| Page Name | How to set it up |
|-----------|-----------------|
| **Current Year Dashboard** | AttendanceDays + LearningSessions filtered to active school year |
| **2026-2027 Attendance** | AttendanceDays table → Add filter: `school_year = 2026-2027` |
| **2026-2027 Learning Sessions** | LearningSessions → Add filter: `school_year = 2026-2027` |
| **Needs Review** | LearningSessions → filter: `review_status = needs_review` AND `is_test = false` |
| **Test Entries** | LearningSessions + CaptureEvents → filter: `is_test = true` |
| **Monthly Check** | LearningSessions → group by month (add formula column for month extraction) |
| **By Student** | AttendanceDays → group by `student` |
| **By Subject** | LearningSessions → group by `subject` |
| **Archive / Exports** | ComplianceSnapshots table view |

---

## Backup

Your Grist document is the canonical store. Protect it:

- Enable Grist's built-in snapshot/backup feature (self-hosted: configure S3 or local snapshots)
- Run `exportSchoolYear` periodically and archive the output files
- ComplianceSnapshots table preserves a timestamped history of every `summarizeProgress` run

---

## Privacy

Homeschool records contain family data including children's names, ages, and daily activities. Treat this data accordingly:

- Use a self-hosted Grist instance for maximum privacy control
- Restrict Grist API token scope to the minimum necessary document
- Do not commit `GRIST_API_TOKEN` to source control — always use vault expressions

---

## License

MIT — see [LICENSE](LICENSE.txt)
