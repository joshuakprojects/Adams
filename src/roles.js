// Who can do what.
//   office      – work orders (no texting drivers, no driver assignments), customers, prices, questions
//   dispatcher  – everything office can, plus assigning and texting drivers, the Texts inbox and Records
//   admin       – everything, including Setup and editing prices / questions
//   snow        – overnight snow dispatcher: only the Snow call tab (nothing else in the app)
// The owner (OWNER_EMAIL, josh@adamsbros.ca) is the only one who can add, change or remove logins.
const config = require('./config');

const ROLES = ['office', 'dispatcher', 'admin', 'snow'];
const RANK = { snow: 0, office: 1, dispatcher: 2, admin: 3 };
const ROLE_NAMES = { office: 'Office', dispatcher: 'Dispatcher', admin: 'Admin', snow: 'Overnight snow dispatcher' };

const isOwner = (user) => Boolean(user && config.ownerEmail && String(user.email).toLowerCase() === config.ownerEmail);
const can = (user, role) => Boolean(user && (RANK[user.role] || 0) >= RANK[role]);

/** Snow call-outs: the overnight snow dispatcher, dispatchers and admins. */
const canSnow = (user) => Boolean(user && (user.role === 'snow' || can(user, 'dispatcher')));
function needSnow(req, res, next) {
  if (canSnow(req.user)) return next();
  res.status(403).json({ error: 'Only dispatch or the overnight snow dispatcher can do that' });
}

/** Express middleware: at least this role. */
function need(role) {
  return (req, res, next) => {
    if (can(req.user, role)) return next();
    res.status(403).json({ error: `Only ${role === 'admin' ? 'an admin' : 'dispatch'} can do that` });
  };
}

function needOwner(req, res, next) {
  if (isOwner(req.user)) return next();
  res.status(403).json({ error: `Only ${config.ownerEmail} can manage logins` });
}

/** What the dashboard shows for this login. */
function permissions(user) {
  return {
    role: user.role,
    role_name: ROLE_NAMES[user.role] || user.role,
    owner: isOwner(user),
    dispatch: can(user, 'dispatcher'), // assign + text drivers, Texts, Records
    admin: can(user, 'admin'), // Setup, edit prices and questions
    notes: Boolean(user.boss_notes), // posts "Notes from the boss" to reception
    snow: canSnow(user), // the Snow call tab
    snow_only: user.role === 'snow', // sees nothing but the Snow call tab
  };
}

module.exports = { ROLES, ROLE_NAMES, need, needOwner, needSnow, canSnow, can, isOwner, permissions };
