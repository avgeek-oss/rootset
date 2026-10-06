# Towbar and Mill UI adaptation

Copyright 2026 Avgeek, Inc.

Rootset's shell, navigation, account menu, avatar, button and shared styles adapt
the `packages/web-design-system` source in the local Towbar and Mill checkouts.
The checkouts were based on Towbar `e810ef5f91aeed339049bc8be2d646f7067223e7`
and Mill `aab8ef39527921d8834df8631a0ffc89132f4b74`; local working-tree changes
were also present when the source was referenced.

The table filter modal adapts the condition rows and action layout in Towbar's
`packages/towbar-web-ui/src/filter-dialog.tsx`, with Rootset's typed query
validation, UTC inputs and JSON path support.

The Tables overview adapts Mill's `apps/web/src/boards-page.tsx`, using the same
page-heading action placement, responsive card grid and shared widget styling.
Rootset displays table names and row counts and links to each table's own page.

The Preferences form adapts Towbar's
`apps/towbar-web-app/src/components/date-time-preferences.tsx` and
`date-time-preference-fields.tsx`, including the searchable time-zone selector,
UTC offset labels, layout and live preview. Rootset uses its existing preference
values, profile API and spreadsheet formatter.

Sources: [Towbar](https://github.com/avgeek-inc/towbar) and
[Mill](https://github.com/avgeek-inc/mill).
Both distribute the adapted source under the Apache License, Version 2.0,
included in Rootset's [LICENSE](../../LICENSE). Rootset changes the product
identity, routes, settings scopes, role display, theme persistence, mobile
navigation and spreadsheet layout. Adapted source files identify the changes.

The relevant Mill design-system notice is retained here:

> Mill's shared buttons, fields, password input, typography, Avatars, table-cell text, tooltips, tabs, widgets, list views, empty states, skeletons, primitive re-exports, and global styles are adapted from Towbar, Copyright Avgeek, Inc., under Apache License 2.0. https://github.com/avgeek-inc/towbar

Hugeicons free icons and React Aria Components retain their supplied license
files in the generated dependency notices. Inter font software is Copyright
2016 The Inter Project Authors and licensed under the SIL Open Font License.
The production build copies installed dependency licenses and this adaptation
notice into its notices directory.

## Published shared UI

Rootset imports `@avgeek-oss/design-system@1.1.0` from GitHub Packages through its
public exports. The shared package supplies primitives, typography, widgets,
query feedback, theme providers and styles under Apache-2.0, Copyright Avgeek,
Inc. Its packaged LICENSE and NOTICE remain part of the distribution.

Rootset's account adapters own endpoints, role mappings, UTC/date policy and
bound authentication approvals. Remaining app-local account workflows are being
migrated to the shared patterns; copied primitives have been removed.

The OpenAI, Cursor, and Anthropic SVG paths in `src/components/settings/account/mcp-client-logo.tsx` are from [LobeHub Icons](https://github.com/lobehub/lobe-icons). Brand names and logos belong to their respective owners.

The VS Code logo silhouette in the same component is adapted from [Microsoft's VS Code logo asset](https://github.com/MicrosoftDocs/visualstudio-docs/blob/main/docs/media/vs-code-logo.svg) for a monochrome client selector. The source is provided under [CC BY 4.0](https://github.com/MicrosoftDocs/visualstudio-docs/blob/main/LICENSE).

MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
