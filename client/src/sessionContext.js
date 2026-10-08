export function applySessionContext(queueItems, session) {
  const byKey = new Map((Array.isArray(session?.items) ? session.items : []).map((entry) => [`${entry.entityType}:${entry.entityId}`, entry.context]));
  for (const item of queueItems) {
    const context = byKey.get(`${item.entityType}:${item.entityId}`);
    if (context) item.context = context;
  }
  return queueItems;
}
