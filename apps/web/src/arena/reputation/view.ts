export function readPage(url: URL): number {
  const page = Number(url.searchParams.get('page') ?? '1');
  return Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
}
