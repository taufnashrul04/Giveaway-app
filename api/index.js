// Vercel serverless entry — imports the express app from src/server.js
// and exports it as the handler. Static files (public/) are served by the
// express.static middleware inside the app.
const app = require('../src/server');

module.exports = app;
