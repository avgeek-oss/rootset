# Launch documentation verification

Verified locally on 10 October 2026 for the consolidated Rootset v1 PR.

- Public Mintlify content lives directly in `docs`, using the pinned
  `@avgeek-oss/docs` 0.1.5 shared package. Internal operation and verification
  records are preserved under `development`.
- Documentation checks cover 94 navigable pages, all 72 public OpenAPI endpoints,
  71 MCP tools, local links, shared generated assets, installation-file copies
  and screenshot dimensions. Mintlify build validation passes.
- The approved localhost fixture capture produces 28 lossless PNGs: 14 product
  views in light and dark mode at 3840 × 2160, with 2× device scale. Captures use
  disposable synthetic data and show no API key secrets. Metadata is beside the
  images. The reviewed source revision is recorded there.
- The actual Mintlify homepage, footer, installation guide, code-group tabs and
  API reference were reviewed in the browser. Desktop and 390 px mobile layouts
  fit without horizontal overflow. The footer has a 72 px gap after the final
  homepage actions. Hero screenshots load at their original 3840 px width.
- Both external-database and bundled-PostgreSQL Compose configurations validate.
  A fresh disposable PostgreSQL container verifies the bundled bootstrap: the
  ordinary `rootset` role owns its database, has neither superuser nor RLS-bypass
  privileges, and can create `pgcrypto`. The test container, network and volume
  were removed after verification.
- Frozen dependency installation, full workspace lint, all 15 strict typechecks,
  formatting and Git whitespace checks pass. Four release-check tests cover
  required CI checks, anonymous image access, platform coverage, matching source
  revision/version labels and immutable content digests. Actionlint accepts both
  new workflows.

The complete runtime and browser test evidence from the preceding implementation
is recorded in the other reports here. This documentation pass did not repeat
the entire runtime integration suite. Fresh PR CI is a separate gate.

The release workflow has not been dispatched. These checks do not establish
publication of Rootset images, a GitHub release, a deployed Mintlify site or a
production Rootset installation. The image installer becomes usable once the
first reviewed version has been published.
