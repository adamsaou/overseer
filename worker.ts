import { GOALS } from "./lib/goals.ts";
import { MODELS, MODEL_KEYS } from "./lib/models.ts";

// Hosted showcase on Cloudflare's free plan. A live audit makes 50-80 API calls, more than the 50
// subrequests a free Worker gets per request, so this serves the pages, saved replays and study
// results that scripts/build-site.ts puts in dist/. Live audits run from the local server.

type Env = { ASSETS: { fetch: (request: Request | URL) => Promise<Response> } };

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const asset = (path: string) => env.ASSETS.fetch(new URL(path, url));
    if (url.pathname === "/api/config") {
      return Response.json({ models: MODEL_KEYS.map((key) => ({ key, label: MODELS[key].label })), goals: GOALS, apiKey: true, showcase: true });
    }
    if (url.pathname === "/api/runs") return asset("/data/runs.json");
    const run = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
    if (run) return asset(`/data/runs/${run[1]}.json`);
    if (url.pathname === "/api/study") return asset("/data/summary.json");
    if (url.pathname === "/api/audit") {
      return Response.json({ error: "Live audits run from a local copy of Overseer (see the README). Here you can replay saved audits." }, { status: 503 });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
