# @mgreten/road-trip-risk-watch

Native Swamp model for checkpointed route-risk monitoring.

It polls official NWS endpoints for each checkpoint, computes a stable risk
fingerprint, persists the last fingerprint to a local state file, and stays
silent unless something changes materially.

## Assessment and manual progress

`assess` compares up to eight caller-supplied routes and 30 total checkpoints.
Supply `tripDate`, `etaKind` (`estimated`, `routed`, or `caller-supplied`),
and `routes` with named checkpoints and coordinates. Each checkpoint may have an
ISO timestamp `eta`, or an `offsetMinutes` relative to `anchorTime`; offsets
are planning estimates, not traffic-aware routing. `displayTimeZone` defaults
to UTC. Optional `windowStart` and `windowEnd` bound the assessment, with an
inclusive start and exclusive end.

For manual driving progress, provide `manualCheckIn` with `checkpoint` and
offset-aware `observedAt`, optionally `delayMinutes` and `maxAgeMinutes`.
All routes must contain the same uniquely named checkpoint at the same
coordinates and have monotonic original offsets; earlier checkpoints are
removed and remaining estimates are reanchored. The default maximum age is 60
minutes. This is not GPS, navigation, rerouting, or live traffic estimation.

No automated road-condition adapter is included. `roadSources` may be omitted
or empty; requesting any provider is rejected rather than silently ignored.
`roadObservations` can record separately inspected official
traveler-page reports, with source, source URL, observation time and, when
known, an explicitly zoned source timestamp. A missing or stale report is
unknown, not evidence of safe roads. Check official sources before travel.
NWS data is open and free under the [NWS API guidance](https://www.weather.gov/documentation/services-web-api),
subject to rate limits and the [NWS disclaimer](https://www.weather.gov/disclaimer):
do not imply NWS endorsement or present modified information as official.
Forecasts shown here are derived from National Weather Service data; this
package is not affiliated with or endorsed by NWS. Observe source timestamps
and limit polling to the data and refresh frequency needed.

The automated COtrip adapter is excluded pending verified automated-use,
display, caching and redistribution terms. Official traveler-page links and
caller-supplied manual observations remain available; the package does not
fetch those pages. No HERE or Utah API integration is included.

The version upgrade preserves all existing global settings unchanged. New
assessment inputs are method arguments, not changes to the legacy configuration.

The method writes seven-day `assessmentData` JSON and `assessment` HTML files,
plus `assessmentStatus`, written last as a completion marker. Use the output
handles from one successful method run. If reading stored outputs independently,
require the same `assessmentId` in the status, JSON and HTML's `assessment-id`
meta tag; reject missing or mismatched IDs rather than combining latest versions.
Writes are not a multi-file transaction: a failed run may leave partial files,
but does not write its completion marker. An earlier marker remains an earlier
snapshot, not proof of a fresh successful check. Recheck its `retrievedAt`.

These outputs can contain route names, checkpoint labels,
coordinates, times and road observations; Swamp also persists method inputs.
Treat them as sensitive, restrict access, and configure retention to suit your
environment. The summary omits coordinates and endpoint names but can still
identify intermediate checkpoints. Do not send it to an unapproved audience.

This package does not schedule checks, send notifications, enforce a trip-wide
request budget, or confirm departure. Those capabilities require separately
reviewed orchestration. A forecast is not a safety recommendation, a complete
itinerary, or complete road-condition coverage.

## Legacy method

### `collect`

Polls each checkpoint, classifies local route risk, updates the fingerprint state
file, and writes:

- `summary/latestSummary` — structured route-risk summary, only on changed runs.
- `digest/latestDigest` — markdown summary, only on changed runs.

## Usage

```bash
swamp model @mgreten/road-trip-risk-watch method run collect road-trip-risk-watch \
  --input tripLabel='Indianapolis IN → Denver CO' \
  --input statePath=./state/road-trip-risk-watch.json \
  --input checkpointsJson='[{"name":"Indianapolis, IN","role":"start","lat":39.7684,"lon":-86.1581},{"name":"Kansas City, MO","role":"overnight-option-a","lat":39.0997,"lon":-94.5786},{"name":"Salina, KS","role":"overnight-option-b","lat":38.8403,"lon":-97.6114},{"name":"Denver, CO","role":"destination","lat":39.7392,"lon":-104.9903}]'
```

`collect` is retained for compatibility; it makes network calls per checkpoint
and does not provide a trip-wide budget, delivery acknowledgement or finite trip
window. An exclusive OS file lock rejects overlapping collection for the same
state-file path on the same host. The `.lock` file stays in place; the OS releases
the lock when the process closes it or exits. Do not delete an active lock file.
Use one canonical state path on a local filesystem; this is not a distributed
lock. Failed report writes leave the previous fingerprint eligible for retry.
Output persistence, the local state file and subsequent engine success-record
bookkeeping are not one transaction. A crash after reports and state have been
written can leave reports available without a successful invocation record.
Do not treat the fingerprint as a notification delivery receipt or an empty
report as proof of safe conditions.

Legacy `summary` and `digest` outputs have **no time-based expiration**, with up
to 30 versions retained per output. They include route labels, precise locations
and forecast times. The state file also retains route information and is not
covered by output garbage collection. Routine collection logs omit trip labels,
but stored outputs and Swamp method inputs remain sensitive. Restrict access and
apply an explicit retention/deletion policy in your environment. Existing
retention settings and all five global settings are unchanged by this upgrade.

## State

The default state file is:

```text
./state/road-trip-risk-watch.json
```

It stores the last fingerprint, route label, overall risk, and checkpoint
fingerprints so repeated runs can stay quiet when nothing changes.
