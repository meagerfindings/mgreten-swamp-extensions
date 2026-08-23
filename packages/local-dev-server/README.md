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
directory with configurable `commandTimeoutMs` and `commandOutputMaxBytes`
bounds, terminates timed-out children, and records only the returned server
status, not command stdout or stderr. Failure errors include a short,
credential-pattern-redacted excerpt for diagnosis. An optional health check is restricted to `localhost`, `127.0.0.1`, or
`::1`. Certificate inspection is optional and read-only: a command may emit an
ISO-8601 expiry timestamp, but this extension does not create, renew, or
distribute certificates.

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
one ISO-8601 timestamp.

Licensed under the MIT License. See [LICENSE](LICENSE).
