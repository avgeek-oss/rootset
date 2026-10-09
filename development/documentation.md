# Documentation and image releases

The Mintlify content directory is `docs`, including its `docs.json`. Internal
plans and verification reports live under `development` and `rc-plan`.

Rootset uses `@avgeek-oss/docs` for the homepage, screenshots, native action
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
   intended stable release and let the `verify` and `docs` checks pass on main.
2. Create and push a matching `vMAJOR.MINOR.PATCH` tag on that exact main commit.
3. Run **Publish release images** on main with that tag. It rejects mismatched
   versions, commits, incomplete checks and an already published release.
4. On first publication, make both GHCR packages public. Anonymous image pulls
   must succeed before the workflow can attach the installation files; rerun
   the failed manifest job after correcting visibility.
5. Review the draft release and `rootset-images.json`. The manifest verifies
   anonymous access, Linux AMD64/ARM64 coverage, image content digests and matching
   source/version labels. It attaches `compose.images.yaml` and `rootset.env.example`.
6. Publish the reviewed draft separately. Publishing the documentation through
   Mintlify and deploying an application installation are separate actions.

The workflow does not deploy Rootset or publish its draft release automatically.
