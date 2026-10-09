# Current V1 gaps

The revised scope is defined by the [plan](../../rc-plan/README.md) and
[40-item checklist](../../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md).
The [current local results](CURRENT_RESULTS.md) record passing workspace and native
checks and a rendered browser smoke check. Grouped checklist items remain open
until every behavior is reviewed. Acceptance remains false.

| Area                  | Required current result                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation          | One fresh baseline, SQL-enforced singleton, safe concurrent startup/digest checking and incompatible-ledger refusal.                                                      |
| Accounts and keys     | Three roles including Admin installation management; authentication/factors; live personal-key authority; PKCE/operation consent without resource selection.              |
| Fields and contracts  | One letters/underscore-only name, stable internal ID on rename, strict generated REST/client/MCP parity.                                                                  |
| Storage and jobs      | Genuine typed boundary/uniqueness/concurrency/history checks and interrupted schema/lease/cancellation recovery.                                                          |
| Installation recovery | PostgreSQL/provider recovery preserves database ownership, objects and the installation encryption key on a separate target. App-managed backup and restore are excluded. |
| Browser               | Actual responsive, light/dark, keyboard/touch/screen-reader, typed editing, conflict/history and settings flows.                                                          |
| Performance           | Full five-million-row/200-field/ten-million-history fixtures under core 8 GiB caps, cold/warm percentiles, contention, viewport/scroll/cache and memory.                  |
| Candidate             | Ordinary verification, exact current images/configuration, truthful remaining checks and separate publication/deployment decisions.                                       |

The JSON audit/evidence plans now use `V1-01`–`V1-40`. Earlier candidate records are
historical. Removed
organisation/Owner/grant/team-key/lifecycle/upgrade requirements must not block
this V1, and their prior passes must not substitute for retained requirements.
Use ordinary logs,
manual/native comparisons and browser/benchmark reports to complete the current
checklist, keeping missing prerequisites and failures visible.
