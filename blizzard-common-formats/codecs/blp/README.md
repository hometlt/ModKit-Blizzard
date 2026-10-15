# Blizzard BLP codec

The runtime implementation remains in `src/blp` while this module owns its generated contribution
and stable package subpath. The canonical declaration is `src/define.ts`; `codec.json` is generated.
It validates BLP1/BLP2 headers and exposes top-mip RGBA regions for palettised alpha depths 0/1/4/8,
BLP2 DXT1/DXT3/DXT5 and BGRA, and baseline sequential JPEG BLP1 through codec-kit's JPEG decoder.
BLP1 joins its shared JPEG header with the mip payload and maps the B/G/R/alpha planes to RGBA;
alpha depth zero is opaque. Decoded reads reject malformed/progressive JPEG, size mismatches,
out-of-bounds regions and budget overflow. BLP2 JPEG remains metadata-only; writing is unsupported.

The JPEG acceptance fixture is the unchanged `SmileyGW.blp` from the local mdx-m3-viewer reference:
256×256, four-component baseline JPEG, tested through the public Host raster source with full/crop
agreement, colour and opacity checks. This does not establish installed WoW FileDataID acceptance
or all JPEG profiles. Only mip/layer/face/slice/frame zero is decoded.
