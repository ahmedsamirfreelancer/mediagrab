# Build Resources

This directory holds icons + installer artwork used by electron-builder.

## Icon

`icon.svg` is the source artwork. **electron-builder needs `icon.ico` for Windows**, not SVG.

Convert it once:

1. Open `icon.svg` in any vector editor (Figma, Inkscape) or use an online converter.
2. Export to PNG at 256×256.
3. Convert PNG → ICO at https://convertio.co/png-ico/ (or `magick icon.png icon.ico` if you have ImageMagick).
4. Save as `build/icon.ico`.

Without `icon.ico`, electron-builder uses the default Electron icon — not branded but still functional.

## Optional artwork

- `installerSidebar.bmp` — 164×314 BMP shown on the NSIS installer welcome page.
- `installerHeader.bmp` — 150×57 BMP shown at the top of installer pages.

Both optional. Without them, electron-builder uses defaults.
