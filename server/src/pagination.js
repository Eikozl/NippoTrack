const { ValidationError } = require('./errors/http');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const DEFAULT_OPTION_LIMIT = 20;
const MAX_LIMIT = 100;

function parsePositiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new ValidationError(`${name} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ValidationError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parsePagination(query) {
  const page = parsePositiveInteger(query.page, 'page', DEFAULT_PAGE);
  const limit = parsePositiveInteger(query.limit, 'limit', DEFAULT_LIMIT);

  if (limit > MAX_LIMIT) {
    throw new ValidationError(`limit must not exceed ${MAX_LIMIT}.`);
  }

  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset)) {
    throw new ValidationError('page is too large.');
  }
  return { page, limit, offset };
}

function parseOptionLimit(value) {
  const limit = parsePositiveInteger(value, 'limit', DEFAULT_OPTION_LIMIT);
  if (limit > MAX_LIMIT) {
    throw new ValidationError(`limit must not exceed ${MAX_LIMIT}.`);
  }
  return limit;
}

function paginationPayload(items, total, page, limit) {
  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit)
    }
  };
}

module.exports = {
  MAX_LIMIT,
  paginationPayload,
  parseOptionLimit,
  parsePagination
};
