// The JSON the app writes, as the build copied it into /data/. The page's own config (featured
// replay, plates, worked-example scan) is inlined by the build; ids that no longer exist fall back to
// the newest caught run and the newest scan.
const cache = new Map();

const json = (url) => {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return cache.get(url);
};

export function siteConfig() {
  try {
    return JSON.parse(document.getElementById("site-config")?.textContent || "{}");
  } catch {
    return {};
  }
}

export const loadRun = (id) => json(`/data/runs/${encodeURIComponent(id)}.json`);

export async function loadData() {
  const config = siteConfig();
  const [summary, runs, scans] = await Promise.all([json("/data/summary.json"), json("/data/runs.json"), json("/data/scans/index.json")]);
  const list = runs ?? [];
  const has = (id) => list.some((r) => r.id === id);
  const featuredId = has(config.featured) ? config.featured : (list.find((r) => r.label === "caught") ?? list[0])?.id;
  const plateIds = (config.plates ?? []).filter(has);
  if (featuredId && !plateIds.includes(featuredId)) plateIds.unshift(featuredId);
  const scanList = scans ?? [];
  const scanId = scanList.some((s) => s.id === config.scan) ? config.scan : scanList[0]?.id;
  const [featured, scan] = await Promise.all([featuredId ? loadRun(featuredId) : null, scanId ? json(`/data/scans/${encodeURIComponent(scanId)}.json`) : null]);
  return {
    scan,
    summary,
    runs: { featured, plates: plateIds.map((id) => list.find((r) => r.id === id)) },
    config: { ...config, featured: featuredId ?? null, plates: plateIds, scan: scanId ?? null },
  };
}
