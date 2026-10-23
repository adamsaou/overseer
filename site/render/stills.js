import { createHash } from "node:crypto";

// Build-time only. What the stills in site/img/ were rendered from: scripts/render-stills.mjs records
// it in anchors.json, and scripts/build-site.ts compares it with the data it has, so a still drawn
// from another scan or featured run never stands in for the page's figures.
export function stillsSource(scan, run) {
  return {
    scan: `${scan.id}:${scan.clusters.map((c) => `${c.target}/${c.reference}`).join(",")}`,
    featured: `${run.id}:${createHash("sha1").update(JSON.stringify(run.events)).digest("hex").slice(0, 16)}`,
  };
}
