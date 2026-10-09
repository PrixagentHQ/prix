import { buildSchemaDocument, DATA_ENDPOINTS, DATA_ERROR_STATUS } from '@prix/contracts';

/**
 * The data the reference page prints, read from `buildSchemaDocument()` and `DATA_ENDPOINTS` of the
 * contract package. This module runs on the server, once per build of a prerendered page: apps/web
 * does not depend on zod and never converts a schema itself.
 */

type Json = Record<string, unknown>;

export interface ReferenceParam {
  name: string;
  where: 'path' | 'query';
  type: string;
  required: boolean;
  notes: string;
}

export interface ReferenceEndpoint {
  id: string;
  path: string;
  summary: string;
  mcpTool: string;
  metered: boolean;
  cacheSeconds: number;
  params: ReferenceParam[];
  fields: string[];
  /** The path with each parameter replaced by its upper-case name. */
  examplePath: string;
  /**
   * The endpoint names a season in its path, its summary, a parameter or a field. The league has
   * one season that never ends (D-109), and the page says so wherever the API names one.
   */
  namesSeason: boolean;
}

const SEASON = /season/i;

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function typeOf(schema: Json): string {
  if (Array.isArray(schema.enum)) return 'string';
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) return schema.type.join(' or ');
  for (const key of ['anyOf', 'oneOf']) {
    const options = schema[key];
    if (Array.isArray(options)) {
      return options
        .filter(isJson)
        .map(typeOf)
        .filter((item, index, all) => all.indexOf(item) === index)
        .join(' or ');
    }
  }
  return 'any';
}

function notesOf(schema: Json): string {
  const notes: string[] = [];
  if (Array.isArray(schema.enum)) notes.push(schema.enum.join(', '));
  if (typeof schema.minimum === 'number') notes.push(`min ${schema.minimum}`);
  if (typeof schema.maximum === 'number') notes.push(`max ${schema.maximum}`);
  if (schema.default !== undefined) notes.push(`default ${JSON.stringify(schema.default)}`);
  if (typeof schema.description === 'string') notes.push(schema.description);
  return notes.join('; ');
}

export interface Reference {
  endpoints: ReferenceEndpoint[];
  errors: { code: string; status: number }[];
}

let memo: Reference | undefined;

/** Converted once per isolate: the schema conversion is the costly part and the registry never changes at run time. */
export function buildReference(): Reference {
  memo ??= convert();
  return memo;
}

function convert(): Reference {
  const document = buildSchemaDocument();
  const endpoints = document.endpoints.map((endpoint): ReferenceEndpoint => {
    const properties = isJson(endpoint.input.properties) ? endpoint.input.properties : {};
    const required = Array.isArray(endpoint.input.required) ? endpoint.input.required : [];
    const params = Object.entries(properties).map(([name, schema]): ReferenceParam => {
      const body = isJson(schema) ? schema : {};
      return {
        name,
        where: endpoint.path.includes(`:${name}`) ? 'path' : 'query',
        type: typeOf(body),
        required: required.includes(name),
        notes: notesOf(body),
      };
    });
    const dataProps = isJson(endpoint.data.properties) ? Object.keys(endpoint.data.properties) : [];
    const examplePath = endpoint.path.replace(/:(\w+)/g, (_match, name: string) => name.toUpperCase());
    return {
      id: endpoint.id,
      path: endpoint.path,
      // The league summary in the contract says "returns" for a figure of the simulation. A page of
      // this site never uses that word (copy never promises returns), so it is printed as "results".
      // Remove this when the contract's summary changes.
      summary: endpoint.summary.replace(/\breturns\b/g, 'results'),
      mcpTool: endpoint.mcpTool,
      metered: endpoint.metered,
      cacheSeconds: endpoint.cacheSeconds,
      params,
      fields: dataProps,
      examplePath,
      namesSeason: [
        endpoint.path,
        endpoint.summary,
        ...params.map((param) => `${param.name} ${param.notes}`),
        ...dataProps,
      ].some((part) => SEASON.test(part)),
    };
  });
  const errors = document.errors.map((entry) => ({ code: entry.code, status: DATA_ERROR_STATUS[entry.code] }));
  // The registry is the single source: a mismatch would be a build-time bug, not a runtime state.
  if (endpoints.length !== DATA_ENDPOINTS.length)
    throw new Error('reference: endpoint count differs from the registry');
  return { endpoints, errors };
}
