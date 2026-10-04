const ALLOWED_FIELDS = {
  sessions: [
    'session_date',
    'duration_minutes',
    'category',
    'resource',
    'notes',
    'vocabulary_ids',
    'kanji_ids',
    'grammar_ids',
    'writing_title',
    'writing_content',
    'writing_notes'
  ],
  vocabulary: ['word', 'reading', 'meaning', 'jlpt_level', 'status', 'notes', 'example_sentence', 'example_translation', 'example_notes'],
  kanji: ['character_kanji', 'meaning', 'onyomi', 'kunyomi', 'jlpt_level', 'status', 'notes'],
  grammar: ['grammar_point', 'meaning', 'structure', 'example', 'jlpt_level', 'status', 'notes', 'reference_id'],
  goals: ['title', 'goal_type', 'target_value', 'period_type', 'target_jlpt_level', 'target_status', 'start_date', 'due_date', 'is_active'],
  content: ['title', 'content_type', 'content_date', 'perceived_difficulty', 'comprehension_percent', 'new_words_count', 'notes', 'source_text', 'source_url'],
  notes: ['title', 'body', 'category'],
  tags: ['name']
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
const GOAL_TYPES = ['study_minutes', 'vocabulary_count', 'kanji_count', 'grammar_count'];
const GOAL_PERIODS = ['weekly', 'cumulative', 'by_deadline'];
const CONTENT_TYPES = ['Anime', 'Manga', 'Book', 'Article', 'YouTube', 'Podcast', 'Game', 'Conversation'];
const NOTE_CATEGORIES = ['Grammar', 'Vocabulary', 'JapaneseQuestion', 'Correction', 'Resource', 'General'];

module.exports = {
  ALLOWED_FIELDS,
  STUDY_CATEGORIES,
  JLPT_LEVELS,
  STATUSES,
  GOAL_TYPES,
  GOAL_PERIODS,
  CONTENT_TYPES,
  NOTE_CATEGORIES
};
