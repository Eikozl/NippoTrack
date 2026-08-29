const { paginationPayload } = require('../pagination');

async function executePaginatedList(pool, {
  table,
  columns,
  whereSql,
  params,
  orderBy,
  orderParams = [],
  page,
  limit,
  offset
}) {
  const [countResult, itemsResult] = await Promise.all([
    pool.execute(`SELECT COUNT(*) AS total FROM ${table}${whereSql}`, params),
    pool.execute(
      `SELECT ${columns} FROM ${table}${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, ...orderParams, limit, offset]
    )
  ]);
  const total = Number(countResult[0][0]?.total || 0);
  return paginationPayload(itemsResult[0], total, page, limit);
}

module.exports = { executePaginatedList };
