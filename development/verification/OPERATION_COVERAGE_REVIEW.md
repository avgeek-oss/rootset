# Operation coverage review

The generated operation catalog is the current REST/client/MCP inventory. Fixed
historical operation counts and the former checklist are not coverage criteria
for the revised V1. Regenerate contracts and review each supported operation's
current role, input/output, side effects and transport behavior.

## What establishes coverage

| Area                    | Required observation                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Discovery and contracts | Current generated schema/tool/client matches the catalog; strict output validation also runs.                             |
| Successful handler      | A real permitted request produces the expected response and native committed/read result.                                 |
| Denial                  | Current wrong role, removed membership, invalid credential/consent or parent mismatch fails without effects/data leakage. |
| Retry and waiting work  | Live authority is rechecked; a replay returns the same permitted outcome without duplicate effects.                       |
| Async work              | Actual job reaches a truthful terminal state, with checkpoint/lease recovery and native comparison.                       |
| Browser parity          | Real rendered flow uses the same role/name/type/revision/error contracts and remains accessible.                          |

Discovery or invalid-credential sweeps cannot prove successful handler behavior.
Synthetic service actors cannot establish password/cookie/PKCE or real MCP-client
interoperability. A received HTTP response cannot alone establish atomic native
history, uniqueness, artifact readback or process recovery.

## Revised authority and naming

Exercise Admin, Member and Viewer across browser, REST and MCP. Admin alone
manages members, databases/schema and recovery. Personal
keys use read-only, edit or administrative permission ceilings capped by the current role. OAuth consent
limits operations and is intersected with live role; its audience `resource` is
the MCP server URL, not a database/table permission chooser.

Test demotion, membership removal, expiry/revocation and consent changes on
existing credentials, waiting jobs and replay. Resolve the real nested parents
before authority checks. Team keys require explicit permission/expiry inputs, admin-only management, creator-independent access and no personal identity. There are no Owner, resource-grant,
organisation-deletion or account-deletion coverage requirements.

Fields expose one `name` of 1–64 ASCII letters/underscores, no digits. Verify
name-keyed row input/output and UI label change together on rename, while internal
IDs, values, query references and historical definitions remain correct. Typed
UTC values, revisions and complete byte-capped continuation need real native
oracles rather than response status alone.

## Record remaining cases

Use `V1-04`–`V1-25` and `V1-31`–`V1-38` in the
[verification requirements](../../tools/verification/requirements.json).
Record exact current test/manual results and the still-unobserved behaviors.
Historical reports remain available; their older catalog/authority/schema cannot
be treated as a current all-operations pass. Acceptance remains false until the
retained functional, recovery and performance checks have real evidence.
