# Rootset brand assets

`Rootset.sketch` is the original design document copied from the Desktop. It
contains the logo, favicon and Open Graph composition. Keep it as the source
when changing the artwork.

`rootset-logo.png` is the transparent 1024 × 1024 export of
`rootset_light_transparent_edge`. The light and dark variants currently export
the same artwork, so the application uses one image in both themes.

The web app serves a 128 × 128 PNG at `public/brand/rootset-logo.png` for its
32-pixel brand lockups and email headers. This provides up to 4× pixel density
without sending the large master image for every small logo. Next.js serves
the 64-pixel favicon and 180-pixel Apple touch icon from `src/app/icon.png` and
`src/app/apple-icon.png`.

Export from Sketch using these layers and scales:

| Asset              | Layer ID                               | Scale  |
| ------------------ | -------------------------------------- | ------ |
| Master logo        | `04636875-A2D2-4024-A964-2D5CC35D4242` | `2.56` |
| App and email logo | `04636875-A2D2-4024-A964-2D5CC35D4242` | `0.32` |
| Favicon            | `0E57921F-4D51-421D-829B-0966928463BA` | `0.16` |
| Apple touch icon   | `0E57921F-4D51-421D-829B-0966928463BA` | `0.45` |

For example, on macOS with Sketch installed:

```sh
/Applications/Sketch.app/Contents/Resources/sketchtool/bin/sketchtool export layers \
  design/brand/Rootset.sketch \
  --item=04636875-A2D2-4024-A964-2D5CC35D4242 \
  --formats=png --scales=0.32 --output=/tmp/rootset-brand \
  --save-for-web=YES --overwriting=YES --without-activating=YES
```

Copy the resulting PNG to its corresponding path above. These exports preserve
the original raster artwork; wrapping them in SVG would not make them vector
assets.
