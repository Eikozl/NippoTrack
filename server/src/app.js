const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('./middleware/cors');
const { errorHandler } = require('./errors/http');
const { getHealth } = require('./controllers/healthController');
const dashboardRoutes = require('./routes/dashboard');
const sessionsRoutes = require('./routes/sessions');
const vocabularyRoutes = require('./routes/vocabulary');
const kanjiRoutes = require('./routes/kanji');
const grammarRoutes = require('./routes/grammar');
const exportRoutes = require('./routes/export');
const v2Routes = require('./routes/v2');
const reviewRoutes = require('./routes/review');
const analyzeRoutes = require('./routes/analyze');
const immersionRoutes = require('./routes/immersion');
const levelRoutes = require('./routes/level');
const firstExperienceRoutes = require('./routes/firstExperience');
const profileRoutes = require('./routes/profile');
const gradedReaderRoutes = require('./routes/gradedReader');
const smartGoalsRoutes = require('./routes/smartGoals');
const insightsRoutes = require('./routes/insights');
const shareRoutes = require('./routes/share');
const decksRoutes = require('./routes/decks');
const usersRoutes = require('./routes/users');
const storiesRoutes = require('./routes/stories');
const collectionsRoutes = require('./routes/collections');
const authRoutes = require('./routes/auth');
const { requireAuthentication } = require('./middleware/authentication');
const { createRateLimiter } = require('./middleware/rateLimit');

const app = express();

app.set('trust proxy', 1);
// Story embeds: the default helmet CSP blocks all frames, which would kill
// YouTube previews. youtube-nocookie is the only third-party frame host;
// everything else stays at helmet defaults (script-src untouched).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'frame-src': ["'self'", 'https://www.youtube-nocookie.com']
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cors);

const apiRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 300, message: 'Too many requests. Please try again later.' });

app.get('/api/health', getHealth);
app.use('/api/auth', authRoutes);
app.use('/api', apiRateLimit, requireAuthentication);

app.get('/api', (req, res) => {
  res.json({
    name: 'NippoTrack API',
    version: '2.0.0',
    endpoints: [
      'GET /api/health',
      'GET /api/dashboard',
      'GET /api/sessions',
      'POST /api/sessions',
      'GET /api/vocabulary',
      'POST /api/vocabulary',
      'GET /api/kanji',
      'POST /api/kanji',
      'GET /api/grammar',
      'POST /api/grammar',
      'GET /api/export',
      'GET /api/goals',
      'GET /api/content',
      'GET /api/notes',
      'GET /api/tags'
      ,      'GET /api/review',
      'GET /api/review/difficult',
      'GET /api/review/sessions',
      'DELETE /api/review/sessions',
      'GET /api/review/sessions/:id',
      'DELETE /api/review/sessions/:id',
      'GET /api/review/sessions/:id/items',
      'GET /api/review/due',
      'GET /api/review/types',
      'GET /api/review/patterns',
      'PUT /api/review/preferences',
      'GET /api/goals/smart',
      'PUT /api/goals/smart/preferences',
      'POST /api/goals/smart/adjust',
      'GET /api/insights/weekly',
      'GET /api/insights/history',
      'POST /api/insights/generate',
      'POST /api/share/deck',
      'POST /api/share/deck/preview',
      'POST /api/share/deck/import',
      'GET /api/users/:username/public',
      'GET /api/users/:username/decks',
      'GET /api/users/me',
      'PUT /api/users/me',
      'POST /api/decks',
      'GET /api/decks',
      'GET /api/decks/:id',
      'DELETE /api/decks/:id',
      'GET /api/decks/:id/analytics',
      'POST /api/decks/:id/follow',
      'DELETE /api/decks/:id/follow',
      'POST /api/decks/:id/suggest',
      'GET /api/decks/:id/suggestions',
      'POST /api/decks/suggestions/:id/decision',
      'POST /api/collections',
      'GET /api/collections',
      'POST /api/collections/import',
      'GET /api/collections/:id',
      'DELETE /api/collections/:id',
      'POST /api/collections/:id/decks',
      'DELETE /api/collections/:id/decks/:deckId',
      'PUT /api/collections/:id/decks',
      'POST /api/collections/:id/share',
      'POST /api/stories/extract-preview',
      'POST /api/stories',
      'POST /api/stories/:id/extract',
      'POST /api/stories/:id/enroll-srs',
      'GET /api/stories/:id/embed',
      'GET /api/share/deck/:code',
      'POST /api/share/deck/:code/import',
      'POST /api/analyze/text',
      'POST /api/immersion/analyze',
      'POST /api/immersion/create-session',
      'GET /api/immersion/history',
      'GET /api/reading/library',
      'GET /api/reading/progress',
      'GET /api/reading/text/:id',
      'DELETE /api/reading/text/:id',
      'POST /api/reading/analyze',
      'POST /api/reading/user-text',
      'PUT /api/reading/text/:id/progress',
      'POST /api/reading/text/:id/enroll',
      'POST /api/reading/import',
      'POST /api/reading/import/url',
      'GET /api/reading/import/preview',
      'GET /api/level/estimate',
      'GET /api/level/progress',
      'GET /api/level/target',
      'PUT /api/level/target',
      'GET /api/first-experience',
      'PUT /api/first-experience/onboarding',
      'GET /api/first-experience/placement/questions',
      'POST /api/first-experience/placement/submit',
      'POST /api/first-experience/placement/skip',
      'GET /api/profile',
      'PUT /api/profile'
    ]
  });
});

app.use('/api/dashboard', dashboardRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/study-sessions', sessionsRoutes);
app.use('/api/vocabulary', vocabularyRoutes);
app.use('/api/kanji', kanjiRoutes);
app.use('/api/grammar', grammarRoutes);
app.use('/api/export', exportRoutes);
app.use('/api', v2Routes);
app.use('/api/review', reviewRoutes);
app.use('/api/analyze', analyzeRoutes);
app.use('/api/immersion', immersionRoutes);
app.use('/api/reading', gradedReaderRoutes);
app.use('/api/goals', smartGoalsRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/decks', decksRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/stories', storiesRoutes);
app.use('/api/collections', collectionsRoutes);
app.use('/api/level', levelRoutes);
app.use('/api/first-experience', firstExperienceRoutes);
app.use('/api/profile', profileRoutes);

app.use(express.static(path.join(__dirname, '../../client/dist')));
app.use(errorHandler);
app.use((req, res) => res.status(404).json({ error: 'endpoint not found' }));

module.exports = app;
