// Password hashing with bcrypt and a random salt per password.
//
// Older accounts were hashed with one fixed salt for everybody. bcrypt stores
// the salt inside the hash, so bcrypt.compare() still verifies those old
// hashes; on a successful login we quietly re-hash them with a fresh salt.

const bcrypt = require('bcryptjs');

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
// bcrypt keeps only part of the last salt character, so match the first 21.
const LEGACY_PREFIX = '$2b$10$abcdefghijklmnopqrstu';

const hash = (plain) => bcrypt.hash(plain, ROUNDS);

const verify = async (plain, stored) => {
  if (!plain || !stored) return false;
  return bcrypt.compare(plain, stored);
};

const isLegacy = (stored) => typeof stored === 'string' && stored.startsWith(LEGACY_PREFIX);

module.exports = { hash, verify, isLegacy };
