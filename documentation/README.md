# otoroshi-api-management documentation

The user documentation of otoroshi-api-management, built with [Docusaurus](https://docusaurus.io/) like the other Cloud APIM extensions.

```sh
npm install
npm start          # dev server on http://localhost:3000/otoroshi-api-management/
npm run build      # static site in build/
```

The `documentation` workflow (`../.github/workflows/documentation.yaml`) builds the site and publishes it to GitHub Pages on every push to `main` that touches `documentation/`; pull requests only build it. The build output is never committed.
