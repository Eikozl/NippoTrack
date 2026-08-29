class ValidationError extends Error {}

function sendRouteError(res, error, {
  defaultStatus = 500,
  defaultMessage = 'Unable to complete the request.',
  conflictMessage = 'Record already exists.'
} = {}) {
  if (error instanceof ValidationError) {
    return res.status(400).json({ error: error.message });
  }

  if (error?.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: conflictMessage });
  }

  if (error?.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({ error: 'One or more related records do not exist.' });
  }

  if (error?.code === 'ER_ROW_IS_REFERENCED_2') {
    return res.status(409).json({ error: 'Record is still in use.' });
  }

  console.error('API operation failed:', error);
  return res.status(defaultStatus).json({ error: defaultMessage });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  return sendRouteError(res, error, {
    defaultStatus: 500,
    defaultMessage: 'Internal server error.'
  });
}

module.exports = {
  ValidationError,
  sendRouteError,
  errorHandler
};
