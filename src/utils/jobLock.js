const os = require('os');
const JobLock = require('../models/JobLock.js');
const logger = require('./logger.js');

// Identifies this process across workers and hosts
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;

/**
 * Try to take (or renew) the lease on a named job.
 *
 * The filter matches when either we already hold the lock — so the holder keeps
 * renewing and does not hand it off mid-run — or the existing lease has expired.
 * If another process holds a live lease, the filter misses, the upsert attempts
 * an insert, and the duplicate _id makes it fail cleanly. That single round trip
 * is what makes this safe against concurrent workers.
 *
 * @param {string} name    job name, e.g. 'shiftScheduler'
 * @param {number} ttlMs   how long the lease is valid — use a few multiples of
 *                         the tick interval so a slow tick doesn't lose the lock
 * @returns {Promise<boolean>} true when this process may run the job
 */
async function acquireJobLock(name, ttlMs) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    await JobLock.findOneAndUpdate(
      {
        _id: name,
        $or: [{ owner: INSTANCE_ID }, { expiresAt: { $lte: now } }],
      },
      { $set: { owner: INSTANCE_ID, expiresAt }, $setOnInsert: { acquiredAt: now } },
      { upsert: true, new: true }
    );
    return true;
  } catch (err) {
    // 11000 = another process holds a live lease. Expected and not an error.
    if (err.code === 11000) return false;
    // Anything else (e.g. DB unavailable): don't run, and say why.
    logger.error(`[jobLock] Could not acquire '${name}': ${err.message}`);
    return false;
  }
}

/**
 * Release a lease early, so a restarting process hands over without waiting for
 * the TTL. Only releases a lock this process actually holds.
 */
async function releaseJobLock(name) {
  try {
    await JobLock.deleteOne({ _id: name, owner: INSTANCE_ID });
  } catch (err) {
    logger.error(`[jobLock] Could not release '${name}': ${err.message}`);
  }
}

/**
 * Run `fn` only if this process can take the lock. Returns true when it ran.
 */
async function withJobLock(name, ttlMs, fn) {
  if (!(await acquireJobLock(name, ttlMs))) return false;
  await fn();
  return true;
}

module.exports = { INSTANCE_ID, acquireJobLock, releaseJobLock, withJobLock };
