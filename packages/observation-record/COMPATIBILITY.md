# Compatibility

This package is an intentional generic successor to
`@mgreten/founder-marketing-observation`; it is **not wire-compatible**. Consumers must
explicitly migrate their inputs and resource readers.

| Source contract                             | Observation-record contract             | Reason                                                                  |
| ------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `@mgreten/founder-marketing-observation`    | `@mgreten/observation-record`           | Removes role- and domain-specific public type language.                 |
| `attestedAt`                                | `observedAt`                            | Describes the evidence event without assigning a role.                  |
| `quote`                                     | `evidence` plus required `evidenceKind` | Supports quotes, summaries, and events while preserving source content. |
| `founderNote`                               | `sourceNote`                            | Removes role-specific authorship.                                       |
| `founderDisposition`                        | `recommendationDisposition`             | Keeps recommendation-only semantics without a role or policy audience.  |
| `founder`, `founder_household` source kinds | `direct_observer`, `affected_person`    | Removes role-specific source categories.                                |
| Domain signal types                         | no replacement                          | Consumers own any domain-specific classification.                       |
| Domain authority flags                      | neutral authority flags                 | Preserves the no-claim/no-authority boundary using neutral terms.       |

Unchanged invariants: source evidence is retained; the record is one unvalidated
qualitative signal (`sampleSize: 1`); identity is not stored; and retention is the only
model effect.
