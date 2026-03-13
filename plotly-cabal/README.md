# plotly-cabal

Patched Plotly.js build used for brain 3D visualizations in NeuroSim. Vendored in-repo as part of our solution.

## Upstream provenance

- **Source**: [Plotly.js](https://github.com/plotly/plotly.js)
- **Exact upstream version/tag/commit**: To be documented in build metadata. This build was derived from the Plotly.js dist; consult the build process or maintainers for the specific tag/commit used.
- **Upstream URL**: https://github.com/plotly/plotly.js

## Patching

Custom build for NeuroSim brain visualization. Modifications are applied at build time to support our 3D scatter usage. No separate patch files are committed in this repo.

## License and attribution

The vendored files in `build/` and `dist/` are derived from Plotly.js, which is licensed under the MIT License. See [LICENSE](LICENSE) in this directory for the original Plotly.js license and copyright notice.

**Redistribution**: This is a modified build. Upstream Plotly.js attribution and license terms apply. When redistributing, ensure compliance with the MIT License and retain the copyright notices.
