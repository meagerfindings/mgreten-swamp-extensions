# @mgreten/local-dev-server

`@mgreten/local-dev-server` is a generic, local-only Swamp model for controlling
a development server through commands supplied by the model instance. It does
not know about Rails, Docker Compose, Puma, Tailscale, branches, production
hosts, or deployment systems. The configured commands should delegate lifecycle
ownership to a local supervisor such as `amp orb service`, systemd user units,
or another project-specific development process manager.

The model never backgrounds a process, guesses a PID, sends signals, installs
dependencies, edits an application, or contacts a non-loopback health endpoint.
It runs each configured lifecycle command in the selected local working
directory (which must be the Swamp repository or a subdirectory) with
configurable `commandTimeoutMs` and `commandOutputMaxBytes` bounds, terminates
timed-out children, and records only the returned server status, not command
stdout or stderr. Swamp cancellation is propagated to running commands and
health checks; on Linux the command runs in a new process group so timeout or
cancellation terminates descendants as well. On macOS the shell child is
terminated, but a command that deliberately detaches its own process remains the
configured supervisor's responsibility. Failure errors include a short,
credential-pattern-redacted excerpt for diagnosis. An optional health check is
restricted to `localhost`, `127.0.0.1`, or `::1`. Certificate inspection is
optional and read-only: a command may emit an ISO-8601 expiry timestamp, but
this extension does not create, renew, or distribute certificates.

## Install

```sh
swamp extension pull @mgreten/local-dev-server
```

## Configure a local service

```yaml
type: "@mgreten/local-dev-server"
arguments:
  workingDirectory: /home/alice/src/docs
  startCommand: "amp orb service start docs --command 'npm run dev'"
  stopCommand: "amp orb service stop docs"
  statusCommand: "amp orb service status docs"
  healthCheck:
    url: http://127.0.0.1:4321/health
    expectedStatus: 200
  certificate:
    strategy: none
```

```sh
swamp model method run docs start
swamp model method run docs status
swamp model method run docs stop
```

`start` and `stop` fail when their configured command fails. `status` uses the
optional `statusCommand` exit code plus the optional loopback health check. If
no status command is supplied, a healthy health check is the running signal. Use
`certificate.strategy: command` only for a local inspection command that prints
one ISO-8601 timestamp. Health URLs must use HTTP(S), may not contain
credentials, and must resolve syntactically to a loopback hostname. This model's
fixed authority is `local-development`; it has no production or deployment
operation.

Licensed under the MIT License. See [LICENSE](LICENSE).

## Moment Savor compatibility and migration

This package intentionally exports **`@mgreten/local-dev-server`**, not the
existing Moment Savor type **`@mgreten/dev-server`**. The identities and
contracts are not interchangeable. The existing type has Moment Savor-specific
`restart`, `switchBranch`, and `refreshCerts` methods, `appDir`,
`tailscaleHostname`, and `port` globals, status fields (`url`, `branch`, and
`certExpiresAt`), and operation-log files. This package instead has only generic
`start`, `stop`, and `status` methods, command-oriented globals, and one generic
status resource. It preserves no implicit Rails, Docker, git, Puma, or Tailscale
behavior.

The safe integration path is additive: keep both current `@mgreten/dev-server`
model instances unchanged, install this extension as a separate source, and
create a new canary model with a distinct name and port. Configure commands that
delegate to the same supervisor used by the existing service; do not point both
models at lifecycle ownership of one unmanaged process. Validate canary
`status`, idempotent `start`, `stop`, cancellation, and cleanup before moving
any consumer. Existing consumers that call `restart`, `switchBranch`, or
`refreshCerts`, or read `url`/`branch`, require an explicit Moment Savor adapter
and cannot be redirected to this type. No in-place type change or model YAML
edit is safe.
