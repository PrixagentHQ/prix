/**
 * True when the site was built, or the dev server started, with PRIX_FIXTURES=1.
 * astro.config.mjs replaces it with a literal, so a production build drops every fixture.
 */
declare const __PRIX_FIXTURES__: boolean;

/** The service binding to the API Worker. A call through it is a subrequest, not a network hop. */
interface ApiBinding {
  fetch(request: Request): Promise<Response>;
}

/** The bindings of the site Worker, as apps/web/wrangler.jsonc declares them. */
interface Env {
  API: ApiBinding;
}

declare module 'cloudflare:workers' {
  export const env: Env;
}

declare namespace App {
  interface Locals {
    /** Answers to API reads made while rendering this request. Only src/lib/api.ts touches it. */
    apiReads?: Map<string, Promise<unknown>>;
  }
}
