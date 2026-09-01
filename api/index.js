// Single Vercel entrypoint for all /api/* requests. vercel.json forwards the
// original API path through an internal query parameter, then this adapter
// restores it before handing the request to Express.
const app = require('../server/src/app');

module.exports = (req, res) => {
  const parsed = new URL(req.url, 'http://jlt.local');
  const forwardedPath = parsed.searchParams.get('__jlt_path');

  if (forwardedPath !== null) {
    parsed.searchParams.delete('__jlt_path');
    const query = parsed.searchParams.toString();
    const normalizedPath = forwardedPath.replace(/^\/+/, '');
    req.url = `/api${normalizedPath ? `/${normalizedPath}` : ''}${query ? `?${query}` : ''}`;
  }

  return app(req, res);
};
