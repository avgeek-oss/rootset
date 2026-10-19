# Release planning

Rootset follows the published-image release flow used by Towbar and Mill. A
reviewed version bump and stable tag are the inputs; a public GitHub release with
matching container images and installation files is the output. The release
workflow never deploys an application instance.

## Versioning

Use semantic versions, starting with `0.1.0` for the initial release. Update the
root `package.json` version through a reviewed PR. Pin the API, worker, web and
migration image tags in `compose.images.yaml` to the same version and run
`pnpm docs:sync` so its public download copy matches. The environment template
contains installation settings; it does not select an image version. The public installation guide downloads both files from the latest release;
keep those asset names stable.

After merging, wait for `verify` and `docs` to pass on the exact main commit.
Create a matching `vMAJOR.MINOR.PATCH` tag on that commit, then run **Publish
release images** on main with that tag. An inconsistent version, tag or commit,
failed/incomplete CI, private repository or already published release stops the
workflow before building.

## Images and gates

| Stage        | Result                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare      | Validate the stable version, main commit, tag and successful CI.                                                                                                                                     |
| Build        | Build API, worker and UI on native AMD64 and ARM64 runners, with SBOM, provenance and source/version labels.                                                                                         |
| Manifest     | Assemble multi-platform images, verify public access and content digests, then retain `rootset-images.json`.                                                                                         |
| Installation | Pull the immutable images on both native architectures; verify setup, email verification, migrations, health, non-root execution, permissions, preserved restart and upgrades from released schemas. |
| Publish      | Attach the image manifest and installation files, then publish the GitHub release only after both installation checks pass.                                                                          |

All three images use one version:

```text
ghcr.io/avgeek-oss/rootset-api:0.1.0
ghcr.io/avgeek-oss/rootset-worker:0.1.0
ghcr.io/avgeek-oss/rootset-web:0.1.0
```

The worker image runs background jobs independently. Migrations reuse the API image. The same images are
tagged with `v0.1.0` and the full source commit, following Mill's release tags.
The release manifest records immutable `@sha256` references. The UI talks to the
independent public API origin at runtime.

The installation gate uses the existing isolated verification Compose fixture
for PostgreSQL, S3 and SMTP. It runs the actual pulled API/worker/UI images with
`--no-build`; it does not require a package-registry credential. Its fixture
containers and volumes are removed afterward. Reports are retained for each
architecture. Public installation uses `compose.images.yaml` with external
services or the optional bundled PostgreSQL profile.

Released SQL migrations are immutable. Add a new migration for schema changes;
do not append to the baseline. The v0.1.4 baseline change has one explicit
compatibility bridge in `packages/database/upgrades/v0.1.4.sql`. It accepts only
known released hashes, preserves the original ledger and applies the additive
comments schema in a transaction. The migration runner includes this bridge
starting with v0.1.5. Do not broaden its accepted hashes to bypass migration drift.

Integration tests compare every existing table before and after upgrading,
exercise comment permissions and deletion, reject unknown ledgers, and inject
failure after DDL to verify rollback. The image installation gate also creates a
nonempty database from the exact v0.1.2/v0.1.3 migration SQL and runs the actual
API and worker image migrators repeatedly. This runs on both release architectures.

## First publication and retries

On first publication, make `rootset-api`, `rootset-worker` and `rootset-web` public in GHCR. Both
anonymous manifest requests and anonymous Docker pulls must work. If package
visibility blocks the manifest job, correct it and rerun that failed job and its
dependent jobs. Do not bypass the access or installation gates.

The final stage creates a draft internally, uploads the image manifest and
installation files, and then publishes it. A failure before that final step
leaves the release unpublished. Retries can reuse an existing draft; an already
published release is rejected. A failed release may leave unpromoted image tags
in GHCR, but they are not evidence of a successful release.

Publishing the Mintlify site and deploying Rootset remain separate operations.
Do not advertise the initial release as installable until this workflow has
completed successfully on both architectures.
