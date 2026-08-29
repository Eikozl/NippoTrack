const ALLOWED_FIELDS = {
  sessions: [
    'session_date',
    'duration_minutes',
    'category',
    'resource',
    'notes',
    'vocabulary_ids',
    'kanji_ids',
    'grammar_ids'
  ],
  vocabulary: ['word', 'reading', 'meaning', 'jlpt_level', 'status', 'notes'],
  kanji: ['character_kanji', 'meaning', 'onyomi', 'kunyomi', 'jlpt_level', 'status', 'notes'],
  grammar: ['grammar_point', 'meaning', 'structure', 'example', 'jlpt_level', 'status', 'notes']
};

const STUDY_CATEGORIES = [
  'Grammar',
  'Vocabulary',
  'Kanji',
  'Reading',
  'Listening',
  'Speaking',
  'Writing',
  'Mixed'
];
const JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const STATUSES = ['New', 'Learning', 'Familiar', 'Mastered'];

module.exports = {
  ALLOWED_FIELDS,
  STUDY_CATEGORIES,
  JLPT_LEVELS,
  STATUSES
};
