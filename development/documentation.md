# Documentation and image releases

The Mintlify content directory is `docs`, including its `docs.json`. Internal
plans and verification reports live under `development` and `rc-plan`.

Rootset uses `@avgeek-oss/mintlify-docs` for the homepage, screenshots, native action
links, navigation and footer. Edit `docs/site.json` and product MDX pages;
do not edit generated shared snippets or assets.

```sh
pnpm docs:sync
pnpm docs:check
pnpm docs:dev
```

The preview listens on port 4178. Synchronization copies the contract-generated
OpenAPI schema, creates reference pages for every public endpoint, lists MCP tools
and copies the image installation files. Run it after contract, Compose,
environment-template or shared package changes. CI checks drift and validates MDX.

## Capture screenshots

Use the existing localhost API and UI with an isolated fixture account. The
credential file must contain `ROOTSET_TEST_OWNER_EMAIL` and
`ROOTSET_TEST_OWNER_PASSWORD` and remain outside Git.

```sh
ROOTSET_DOCS_CREDENTIALS_FILE=/absolute/path/to/browser-credentials.private.env pnpm docs:screenshots
```

The script rejects remote targets. It creates or reuses a synthetic Product
catalog database, switches the app theme explicitly, and writes lossless
3840 × 2160 PNGs at 2× device scale. Capture metadata is stored beside the
images. Inspect the captures and the rendered desktop/mobile guides before
committing them. Never capture real customer records or visible API key secrets.

## Publish release images

1. Review and merge the consolidated PR. Set the root package version to the
   intended stable release, keep the API/worker/web package versions and Compose
   image pins aligned, and run `pnpm release:check`. Let `verify`, `docs` and
   `security` pass on the exact main commit.
2. Create and push a matching `vMAJOR.MINOR.PATCH` tag on that exact main commit.
3. Run **Publish release images** on main with that tag. It rejects mismatched
   versions, commits, incomplete checks and an already published release. The CI
   gate reads paginated check results and waits briefly for in-flight runs; only
   the latest successful results for that exact commit qualify.
   Each native platform image must pass a High/Critical vulnerability scan
   before its digest can be promoted into a release manifest.
4. On first publication, make all three GHCR packages public. Anonymous image pulls
   must succeed before the workflow can attach the installation files; rerun
   the failed manifest job after correcting visibility.
5. Both native Linux runners pull the immutable API, worker and UI images anonymously,
   verify their architecture and source/version labels, then run the existing
   disposable installation and preserved-restart gate. They do not rebuild the
   application. Reports are retained as workflow artifacts.
6. Once both installation gates pass, the workflow attaches `rootset-images.json`,
   `compose.images.yaml` and `rootset.env.example` to the release and publishes it.
   A failed gate prevents publication.

The workflow starts only when manually dispatched for a reviewed tag. It follows
the Towbar and Mill prepare, build, manifest, installation-check and publish
sequence. It publishes the validated release automatically but does not deploy
Rootset. See [Release planning](release.md) for versioning and release gates.
