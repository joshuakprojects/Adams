// Usage: npm run add-user -- email@adamsbros.ca "Full Name" password
const config = require('../src/config');
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');

const [email, name, password] = process.argv.slice(2);
if (!email || !password) {
  console.log('Usage: npm run add-user -- office@adamsbros.ca "Office Name" "a-good-password"');
  process.exit(1);
}
createUser(openDb(config.dbPath), { email, name, password });
console.log(`Login ready for ${email}`);
