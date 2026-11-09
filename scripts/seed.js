// Adds sample trucks, drivers and one job of each work order type for today, so you can try the board.
const config = require('../src/config');
const { openDb } = require('../src/db');
const { createDispatch } = require('../src/dispatch');
const { seedDemo } = require('../src/demo');

const d = createDispatch(openDb(config.dbPath));
if (seedDemo(d)) console.log('Seeded 6 trucks, 6 drivers and 6 jobs (one of each form type) starting', d.today());
else console.log('Database already has drivers — not seeding.');
