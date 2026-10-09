// A Worker that does one thing: run the statements it is sent on its D1 binding and send back
// what D1 answered, with D1's own `meta` (rows read, rows written, database size).
//
// tools/perf/local-d1.mjs starts it on this machine with Wrangler. It is never deployed: it has
// no route, and its database id in wrangler.jsonc names no real database.

export default {
  async fetch(request, env) {
    try {
      const { statements, batch } = await request.json();
      const prepared = statements.map(({ sql, params }) => env.DB.prepare(sql).bind(...params));
      const results = batch ? await env.DB.batch(prepared) : [await prepared[0].all()];
      return Response.json({
        ok: true,
        results: results.map((result) => ({ results: result.results, meta: result.meta })),
      });
    } catch (error) {
      return Response.json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  },
};
