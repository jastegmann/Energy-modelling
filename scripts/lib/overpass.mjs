// Queries to the public Overpass API (OpenStreetMap data), with retries that
// rotate between public instances when one is busy.

export const OVERPASS = 'https://overpass-api.de/api/interpreter';
/** Public Overpass instances, tried in turn when one is busy. */
export const OVERPASS_MIRRORS = [OVERPASS, 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/**
 * Run an Overpass QL query and return the JSON result. `endpoint` is one URL or
 * a list; on a busy server or an error the next one is tried. `label` names the
 * query in log messages.
 */
export async function overpassJson(query, { endpoint = OVERPASS_MIRRORS, log = console.log, attempts = 8, label = '' } = {}) {
  const endpoints = [endpoint].flat();
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = endpoints[attempt % endpoints.length];
    const host = new URL(url).host;
    // Move on to the next server quickly; back off once every server has been tried.
    const last = attempt === attempts - 1;
    const wait = last ? 0 : (attempt + 1) % endpoints.length ? 5 : Math.min(120, 30 * 2 ** Math.floor(attempt / endpoints.length));
    const next = last ? 'giving up' : `next try in ${wait} s`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'solar-yield-map (screening layers)' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(420000),
      });
      if (r.ok) {
        const json = await r.json();
        // Overpass reports a query timeout or memory limit as a remark with HTTP 200.
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark.slice(0, 200));
        return json;
      }
      lastError = new Error(`HTTP ${r.status}: ${(await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
      if (!(r.status === 429 || r.status >= 500)) throw lastError;
      log(`  Overpass ${host} busy (HTTP ${r.status}) for ${label}; ${next}`);
    } catch (e) {
      if (e === lastError) throw e;
      lastError = e;
      log(`  Overpass ${host} error for ${label} (${e.message}); ${next}`);
    }
    if (wait) await new Promise((res) => setTimeout(res, wait * 1000));
  }
  throw lastError;
}
