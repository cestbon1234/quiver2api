require('./env').loadEnv();

const express = require('express');
const cors = require('cors');
const path = require('path');
const routes = require('./routes');
const { router: v1Routes } = require('./v1');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '24mb' }));
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    res.status(400).json({
      error: {
        message: 'Invalid JSON request body',
        type: 'invalid_request_error',
        code: 'invalid_json'
      }
    });
    return;
  }
  next(error);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', routes);
app.use('/v1', v1Routes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get(['/admin', '/admin/'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/health')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    return;
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Quiver2API listening on http://localhost:${PORT}`);
});

module.exports = app;
