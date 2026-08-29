const {
  STUDY_CATEGORIES,
  JLPT_LEVELS,
  STATUSES
} = require('../constants');
const { ValidationError } = require('../errors/http');

function validateWriteFields(body, allowedFields) {
  const unauthorized = Object.keys(body).filter((key) => !allowedFields.includes(key));

  if (unauthorized.length > 0) {
    throw new ValidationError(`Unauthorized fields: ${unauthorized.join(', ')}`);
  }
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);

  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function normalizeRelationshipIds(body, fieldName) {
  if (body[fieldName] === undefined) {
    return undefined;
  }

  if (!Array.isArray(body[fieldName])) {
    throw new ValidationError(`${fieldName} must be an array of positive integer IDs.`);
  }

  if (!body[fieldName].every((id) => Number.isInteger(id) && id > 0)) {
    throw new ValidationError(`${fieldName} must contain only positive integer IDs.`);
  }

  return [...new Set(body[fieldName])];
}

function normalizeText(value, maxLength = null) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();

  if (!text) {
    return null;
  }

  if (maxLength && text.length > maxLength) {
    throw new ValidationError(`Field exceeds maximum length of ${maxLength} characters`);
  }

  return text;
}

function validateAllowedValues(value, allowedValues, fieldName) {
  if (value === undefined || value === null || value === '') {
    return;
  }

  if (!allowedValues.includes(value)) {
    throw new ValidationError(`${fieldName} must be one of: ${allowedValues.join(', ')}`);
  }
}

function parseIdParam(req, entityName) {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError(`${entityName} id must be a positive integer`);
  }

  return id;
}

function validateStudySessionPayload(body, { partial = false } = {}) {
  if (!partial && !isValidDateString(body.session_date)) {
    throw new ValidationError('session_date is required and must use YYYY-MM-DD format.');
  }

  if (body.session_date !== undefined
      && body.session_date !== null
      && body.session_date !== ''
      && !isValidDateString(body.session_date)) {
    throw new ValidationError('session_date must use YYYY-MM-DD format.');
  }

  if (!partial && !isPositiveInteger(body.duration_minutes)) {
    throw new ValidationError('duration_minutes must be a positive integer.');
  }

  if (body.duration_minutes !== undefined
      && body.duration_minutes !== null
      && body.duration_minutes !== ''
      && !isPositiveInteger(body.duration_minutes)) {
    throw new ValidationError('duration_minutes must be a positive integer.');
  }

  if (!partial && !body.category) {
    throw new ValidationError('category is required.');
  }

  validateAllowedValues(body.category, STUDY_CATEGORIES, 'category');

  return {
    vocabularyIds: normalizeRelationshipIds(body, 'vocabulary_ids'),
    kanjiIds: normalizeRelationshipIds(body, 'kanji_ids'),
    grammarIds: normalizeRelationshipIds(body, 'grammar_ids')
  };
}

function validateStandardRecordPayload(body, {
  requiredMeaning = true,
  requiredWord = true,
  requiredGrammar = false
} = {}) {
  if (requiredWord && (!body.word || !String(body.word).trim())) {
    throw new ValidationError('word is required.');
  }

  if (requiredGrammar && (!body.grammar_point || !String(body.grammar_point).trim())) {
    throw new ValidationError('grammar_point is required.');
  }

  if (requiredMeaning && (!body.meaning || !String(body.meaning).trim())) {
    throw new ValidationError('meaning is required.');
  }

  validateAllowedValues(body.jlpt_level, JLPT_LEVELS, 'jlpt_level');
  validateAllowedValues(body.status, STATUSES, 'status');
}

module.exports = {
  isValidDateString,
  normalizeText,
  parseIdParam,
  validateAllowedValues,
  validateStandardRecordPayload,
  validateStudySessionPayload,
  validateWriteFields
};
