const { paginationPayload } = require('../pagination');

async function executePaginatedList(pool, {
  table,
  columns,
  whereSql,
  params,
  orderBy,
  orderParams = [],
  userId,
  page,
  limit,
  offset
}) {
  if (!userId) throw new Error('A verified user is required for a user-owned list.');
  const scopedWhere = `${whereSql} AND user_id = ?`;
  const scopedParams = [...params, userId];
  const [countResult, itemsResult] = await Promise.all([
    pool.execute(`SELECT COUNT(*) AS total FROM ${table}${scopedWhere}`, scopedParams),
    pool.execute(
      `SELECT ${columns} FROM ${table}${scopedWhere} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...scopedParams, ...orderParams, limit, offset]
    )
  ]);
  const total = Number(countResult[0][0]?.total || 0);
  return paginationPayload(itemsResult[0], total, page, limit);
}

module.exports = { executePaginatedList };
