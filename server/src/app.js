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

const app = express();

app.use(helmet({ contentSecurityPolicy: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cors);

app.get('/api', (req, res) => {
  res.json({
    name: 'Japanese Learning Tracker API',
    version: '1.0.0',
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
      'GET /api/export'
    ]
  });
});

app.get('/api/health', getHealth);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/study-sessions', sessionsRoutes);
app.use('/api/vocabulary', vocabularyRoutes);
app.use('/api/kanji', kanjiRoutes);
app.use('/api/grammar', grammarRoutes);
app.use('/api/export', exportRoutes);

app.use(express.static(path.join(__dirname, '../../client/dist')));
app.use(errorHandler);
app.use((req, res) => res.status(404).json({ error: 'endpoint not found' }));

module.exports = app;
