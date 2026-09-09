class ValidationError extends Error {}

// One-time Quick Placement guard: a second submit (or re-serving questions)
// after completion is a 409, never a 400 or 500. Follows the ValidationError
// pattern (dedicated class + semantic code); the code travels in the JSON
// body so clients can branch without parsing messages.
class PlacementAlreadyCompletedError extends Error {
  constructor(message = 'Quick placement has already been completed.') {
    super(message);
    this.name = 'PlacementAlreadyCompletedError';
    this.code = 'PLACEMENT_ALREADY_COMPLETED';
  }
}

function sendRouteError(res, error, {
  defaultStatus = 500,
  defaultMessage = 'Unable to complete the request.',
  conflictMessage = 'Record already exists.'
} = {}) {
  if (error instanceof ValidationError) {
    return res.status(400).json({ error: error.message });
  }

  if (error instanceof PlacementAlreadyCompletedError || error?.code === 'PLACEMENT_ALREADY_COMPLETED') {
    return res.status(409).json({
      error: error.message || 'Quick placement has already been completed.',
      code: 'PLACEMENT_ALREADY_COMPLETED'
    });
  }

  if (error?.code === 'ER_DUP_ENTRY' || error?.code === '23505') {
    return res.status(409).json({ error: conflictMessage });
  }

  if (error?.code === 'ER_NO_REFERENCED_ROW_2' || error?.code === '23503') {
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
  PlacementAlreadyCompletedError,
  ValidationError,
  sendRouteError,
  errorHandler
};
