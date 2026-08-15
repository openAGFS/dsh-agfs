# Vendored browser runtime

Offline-friendly copies of the frontend's boot dependencies, shipped inside the
package so the file browser opens without fetching React or Babel from a CDN.

| File | Source | License |
|---|---|---|
| `react.production.min.js` | `react@18.3.1` UMD build (copied from the workspace `node_modules`) | MIT |
| `react-dom.production.min.js` | `react-dom@18.3.1` UMD build (copied from the workspace `node_modules`) | MIT |
| `app.js` | esbuild JSX transform of `../app.jsx` (classic runtime) — rebuild with `pnpm run build:frontend` | MIT |

`app.jsx` remains the editable frontend source; `app.js` is its generated
compiled form and must be regenerated when `app.jsx` changes.
