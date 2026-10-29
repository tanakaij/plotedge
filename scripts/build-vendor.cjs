// Reproducible local runtime dependencies for installed/offline field use.
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "..");
const vendor = path.join(root, "vendor");
fs.mkdirSync(vendor, { recursive: true });
const files = {
  "leaflet/dist/leaflet.js": "leaflet.js",
  "leaflet/dist/leaflet.css": "leaflet.css",
  "leaflet-rotate/dist/leaflet-rotate.js": "leaflet-rotate.js",
  "jszip/dist/jszip.min.js": "jszip.min.js",
  "sql.js/dist/sql-wasm.js": "sql-wasm.js",
  "sql.js/dist/sql-wasm.wasm": "sql-wasm.wasm",
  "proj4/dist/proj4.js": "proj4.js",
  "xlsx/dist/xlsx.full.min.js": "xlsx.full.min.js",
  "jspdf/dist/jspdf.umd.min.js": "jspdf.umd.min.js",
  "jspdf-autotable/dist/jspdf.plugin.autotable.min.js":
    "jspdf.plugin.autotable.min.js",
  "flatgeobuf/dist/flatgeobuf-geojson.min.js": "flatgeobuf-geojson.min.js",
  "georaster/dist/georaster.browser.bundle.min.js":
    "georaster.browser.bundle.min.js",
  "georaster-layer-for-leaflet/dist/georaster-layer-for-leaflet.min.js":
    "georaster-layer-for-leaflet.min.js",
};
for (const [source, dest] of Object.entries(files))
  fs.copyFileSync(
    path.join(root, "node_modules", source),
    path.join(vendor, dest),
  );
fs.cpSync(
  path.join(root, "node_modules/leaflet/dist/images"),
  path.join(vendor, "images"),
  { recursive: true },
);
for (const name of fs.readdirSync(
  path.join(root, "node_modules/georaster/dist"),
)) {
  if (name.endsWith(".worker.js"))
    fs.copyFileSync(
      path.join(root, "node_modules/georaster/dist", name),
      path.join(vendor, name),
    );
}
const packages = new Set(
  Object.keys(files)
    .map((p) => p.split("/")[0])
    .concat(["three", "hyparquet-writer"]),
);
fs.mkdirSync(path.join(vendor, "licenses"), { recursive: true });
for (const pkg of packages) {
  const dir = path.join(root, "node_modules", pkg);
  for (const name of fs
    .readdirSync(dir)
    .filter((n) => /^(license|copying|notice)/i.test(n))) {
    if (fs.statSync(path.join(dir, name)).isFile())
      fs.copyFileSync(
        path.join(dir, name),
        path.join(vendor, "licenses", pkg + "-" + name),
      );
  }
}
esbuild.buildSync({
  entryPoints: [path.join(root, "scanner/viewer.mjs")],
  outfile: path.join(vendor, "scan-viewer.js"),
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: true,
});
esbuild.buildSync({
  entryPoints: [path.join(root, "node_modules/hyparquet-writer/src/index.js")],
  outfile: path.join(vendor, "hyparquet-writer.js"),
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: true,
});
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : [path.relative(root, path.join(dir, e.name)).replaceAll("\\", "/")],
    );
}
const assets = walk(vendor)
  .filter((n) => !n.includes("/licenses/"))
  .concat(["scanner/ply-worker.js", "scanner/ply-parser.mjs"])
  .sort();
const section =
  "// VENDOR_ASSETS_BEGIN\n" +
  assets.map((n) => "  " + JSON.stringify(n) + ",").join("\n") +
  "\n  // VENDOR_ASSETS_END";
const swPath = path.join(root, "plotedge-sw.js");
let sw = fs.readFileSync(swPath, "utf8");
sw = sw.includes("// VENDOR_ASSETS_BEGIN")
  ? sw.replace(
      /\/\/ VENDOR_ASSETS_BEGIN[\s\S]*?\/\/ VENDOR_ASSETS_END/,
      section,
    )
  : sw.replace("const APP_ASSETS = [", "const APP_ASSETS = [\n  " + section);
fs.writeFileSync(swPath, sw);
console.log("Prepared " + assets.length + " local runtime assets.");
