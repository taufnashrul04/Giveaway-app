'use strict';
// init-db — create/verify schema, print status
const db = require('../src/db');
console.log('DB file: ' + require('path').join(__dirname, '..', 'db', 'giveaway.db'));
console.log('Tables: ' + db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name).join(', '));
