# Deploy the PWA

Serve over HTTPS. Upload index.html, plotedge-sw.js, plotedge.manifest.json and complete css, js, resources, vendor and scanner folders. Keep relative paths intact; subdirectory deployment is supported. Keep .nojekyll for GitHub Pages.

Run npm ci, npm run build and npm test before deployment. The build reproduces dependency bundles and their service-worker asset list. Optional Chromium acceptance tests run with npm run test:browser.

Deploy the files together and bump SW_VERSION for shell updates. The worker caches runtime assets and opportunistically caches viewed map tiles. Unvisited areas and external services still need connectivity. An update does not reload an open capture automatically; save and reopen when the update notice appears.

Storage belongs to the browser profile and origin. Keep the same URL when upgrading. Export Project Bundles before moving, clearing site data, or replacing an installation. Device storage is not a separate backup.

For local development use python3 -m http.server 8080 and open http://localhost:8080 on that computer. Direct file opening does not support the complete app. The signing folder is an Android build input, not a PWA runtime asset.
