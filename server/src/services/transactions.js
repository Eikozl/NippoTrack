// Minimal transaction scope for multi-write services. When the executor is
// the shared pool (it exposes getConnection), the work runs inside
// BEGIN/COMMIT with rollback on failure. When the caller already holds a
// connection/transaction, the work reuses it untouched (no nested BEGIN).
async function withTransaction(executor, work) {
  if (!executor || typeof executor.getConnection !== 'function') return work(executor);
  const connection = await executor.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { withTransaction };
