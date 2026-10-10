'use strict';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Parses page/page_size query params into a Supabase-ready offset/limit. */
function parsePageParams(query) {
  let page = parseInt(query && query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;

  let pageSize = parseInt(query && query.page_size, 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = DEFAULT_PAGE_SIZE;
  pageSize = Math.min(pageSize, MAX_PAGE_SIZE);

  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * Fetches one page via `fetchFn(limit, offset)`, asking for one extra row to
 * cheaply determine has_more without a separate COUNT query. `fetchFn` must
 * return an array of rows ordered newest-first (or whatever order the caller
 * wants) - this helper trims it back down to the requested page size.
 */
async function fetchPage(query, fetchFn) {
  const { page, pageSize, offset } = parsePageParams(query);
  const rows = await fetchFn(pageSize + 1, offset);
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  return {
    rows: pageRows,
    pagination: { page, page_size: pageSize, has_more: hasMore },
  };
}

module.exports = { parsePageParams, fetchPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };
