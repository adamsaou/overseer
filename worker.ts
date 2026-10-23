// The site on Cloudflare's free plan: static files that scripts/build-site.ts puts in dist/, served by
// Workers static assets. This code runs only for /app and /app/* (see run_worker_first in wrangler.jsonc),
// where the retired web app used to be, so that links to it still land: /app/?replay=<id> on that audit in
// the site's own replay, anything else under /app/ on the replays.

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const id = url.searchParams.get("replay");
    const to = new URL(id ? `/?replay=${encodeURIComponent(id)}#replay` : "/#replay", url);
    return Response.redirect(to.href, 301);
  },
};
