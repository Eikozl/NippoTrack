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
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value.trim())) return false;
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
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

function normalizeText(value, maxLength = null, fieldName = 'field') {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string.`);
  }

  const text = value.trim();

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

  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a string.`);
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
  if (!partial && body.session_date === undefined) {
    throw new ValidationError('session_date is required and must use YYYY-MM-DD format.');
  }

  if (body.session_date !== undefined) {
    const sessionDate = normalizeText(body.session_date, 10, 'session_date');
    if (!sessionDate || !isValidDateString(sessionDate)) {
      throw new ValidationError('session_date is required and must use YYYY-MM-DD format.');
    }
  }

  if (!partial && body.duration_minutes === undefined) {
    throw new ValidationError('duration_minutes must be a positive integer.');
  }

  if (body.duration_minutes !== undefined && !isPositiveInteger(body.duration_minutes)) {
    throw new ValidationError('duration_minutes must be a positive integer.');
  }

  if (!partial && body.category === undefined) {
    throw new ValidationError('category is required.');
  }

  if (body.category !== undefined) {
    const category = normalizeText(body.category, 20, 'category');
    if (!category) throw new ValidationError('category is required.');
    validateAllowedValues(category, STUDY_CATEGORIES, 'category');
  }

  if (body.resource !== undefined) normalizeText(body.resource, 255, 'resource');
  if (body.notes !== undefined) normalizeText(body.notes, 1500, 'notes');

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
  if (requiredWord || body.word !== undefined) {
    const word = normalizeText(body.word, null, 'word');
    if (requiredWord && !word) throw new ValidationError('word is required.');
  }

  if (requiredGrammar || body.grammar_point !== undefined) {
    const grammarPoint = normalizeText(body.grammar_point, null, 'grammar_point');
    if (requiredGrammar && !grammarPoint) throw new ValidationError('grammar_point is required.');
  }

  if (requiredMeaning || body.meaning !== undefined) {
    const meaning = normalizeText(body.meaning, null, 'meaning');
    if (requiredMeaning && !meaning) throw new ValidationError('meaning is required.');
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
