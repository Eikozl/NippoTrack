function postgresSslConfig(mode, certificateAuthority, certificateVariable = 'POSTGRES_RUNTIME_SSL_CA') {
  const normalizedMode = (mode || 'disable').trim().toLowerCase();
  if (normalizedMode === 'disable') return undefined;
  if (!['require', 'verify-full'].includes(normalizedMode)) {
    throw new Error('Invalid PostgreSQL SSL mode. Use disable, require, or verify-full.');
  }

  const ca = certificateAuthority?.replace(/\\n/g, '\n');
  if (normalizedMode === 'verify-full' && !ca?.trim()) {
    throw new Error(`${certificateVariable} is required when PostgreSQL SSL mode is verify-full.`);
  }
  return { rejectUnauthorized: true, ...(ca?.trim() ? { ca } : {}) };
}

module.exports = { postgresSslConfig };
