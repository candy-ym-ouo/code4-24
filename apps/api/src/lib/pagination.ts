export type PageInput = {
  page?: string | number;
  pageSize?: string | number;
};

function positiveInteger(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const integer = Math.floor(parsed);
  return integer > 0 ? integer : fallback;
}

export function parsePagination(input: PageInput): { page: number; pageSize: number; offset: number } {
  const page = Math.min(1_000_000, positiveInteger(input.page, 1));
  const pageSize = Math.min(100, positiveInteger(input.pageSize, 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pageMeta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
