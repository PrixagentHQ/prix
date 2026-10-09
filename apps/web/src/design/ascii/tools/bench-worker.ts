// Measures the avatars in workerd, the runtime of the site. A Worker cannot time itself (its
// clock stands still while it computes), so the timing is done from outside, by the requests.
// Bundle it and serve it with workerd itself (not `wrangler dev`, whose proxy adds noise), on a
// port of your own; tools/bench-client.mjs does the rest:
//
//   esbuild apps/web/src/design/ascii/tools/bench-worker.ts --bundle --format=esm --outfile=<dir>/worker.js
//   workerd serve <dir>/config.capnp        (one worker, `worker.js` as an ES module, one socket)
//   node apps/web/src/design/ascii/tools/bench-client.mjs http://127.0.0.1:<port>
//
//   /noop               nothing: the cost of a request
//   /load               loads avatar.ts, as a page of the site does on its first request (Astro
//                       imports a page's modules on first use): the plates are decoded then
//   /board?n=&s=        n avatars of ids never drawn before (s makes them new)
//   /parts?n=&s=&part=  the same, stopping after `character`, `stack` or `bytes` (no string)
//   /exact?n=&s=        n animals drawn from their shapes, as before the plates
// Nothing on the site imports this file.
type AvatarModule = typeof import('../avatar.ts');
type AnimalModule = typeof import('../animal.ts');

let avatar: AvatarModule | undefined;
let animal: AnimalModule | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const n = Number(url.searchParams.get('n') ?? '100');
    const s = url.searchParams.get('s') ?? '0';
    if (url.pathname === '/noop') return new Response('0');
    if (url.pathname === '/load') {
      const fresh = avatar === undefined;
      avatar = await import('../avatar.ts');
      return new Response(fresh ? 'loaded' : 'already');
    }
    if (url.pathname === '/board') {
      avatar ??= await import('../avatar.ts');
      let length = 0;
      for (let index = 0; index < n; index += 1) length += avatar.agentAvatar(`${s}x${index}`).html.length;
      return new Response(String(length));
    }
    if (url.pathname === '/parts') {
      avatar ??= await import('../avatar.ts');
      animal ??= await import('../animal.ts');
      const part = url.searchParams.get('part');
      let length = 0;
      for (let index = 0; index < n; index += 1) {
        const who = animal.character(`${s}y${index}`);
        if (part === 'character') continue;
        const stacked = avatar.stackCharacter(who);
        if (part === 'stack') continue;
        length += part === 'bytes' ? avatar.markBytes(stacked) : avatar.markMarkup(stacked).length;
      }
      return new Response(String(length));
    }
    if (url.pathname === '/exact') {
      animal ??= await import('../animal.ts');
      let length = 0;
      for (let index = 0; index < n; index += 1) length += animal.asciiAnimal(`e${s}x${index}`, 'small').lines.length;
      return new Response(String(length));
    }
    return new Response('not found', { status: 404 });
  },
};
