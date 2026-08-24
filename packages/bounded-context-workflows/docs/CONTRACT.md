# Dependency compatibility contract

The workflows target `@mgreten/context-compiler` version `2026.08.24.1` or a
strictly compatible successor. Compiler instance names remain inputs, while the
method names are fixed to `compileRegistered`, `compileConstitution`, and
`compileOperatingPacket`. This allows Swamp validation and the packaged contract
tests to detect method argument drift instead of accepting an unchecked dynamic
method contract.

The reference workflow additionally accepts a caller-selected metadata-only
registry method. That method takes no arguments and must write the configured
record name with exactly these projected fields:

- `sourceIds`: one to 100 unique bounded source IDs;
- `generatedAt`: an offset-aware date-time no later than evaluation; and
- `provenance`: `collector`, `collectorVersion`, `method`, `collectedAt`, and a
  lowercase `sha256:` content digest.

The workflow passes only those fields to the compiler. Registry implementations
with another resource shape require an adapter model; fields are not guessed or
copied wholesale.
