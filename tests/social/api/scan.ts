/** The dotted paths of every object key named `prompt` in a JSON value. Array indexes are left out. */
export function promptKeys(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => promptKeys(item, path));
  if (value === null || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, inner] of Object.entries(value)) {
    if (key.toLowerCase().includes('prompt') && key !== 'promptVersion') found.push([...path, key].join('.'));
    found.push(...promptKeys(inner, [...path, key]));
  }
  return found;
}
