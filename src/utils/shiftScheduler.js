// ============================================================================
// SHIFT SCHEDULER - Daily time-based activation/deactivation (WAT timezone)
// ============================================================================

const WorkShift = require('../models/WorkShift.js');
const Attendance = require('../models/Attendance.js');
const logger = require('./logger.js');
const { getNowWAT } = require('./helpers.js');
const notify = require('./notify.js');
const { purgeOldReadNotifications } = require('../controllers/notificationController.js');

// Run notification cleanup once per day (at most)
let lastNotifCleanup = null;

// Track which shift-end warnings have been sent this session
// Key: `${shiftId}:${minutes}` → true
const warningSentCache = new Set();

/**
 * Convert "HH:MM" time string on a given "YYYY-MM-DD" date to a UTC Date.
 * Assumes WAT (UTC+1).
 */
function watTimeToDate(dateStr, timeStr) {
  const [yr, mo, dy] = dateStr.split('-').map(Number);
  const [hr, mn] = timeStr.split(':').map(Number);
  return new Date(Date.UTC(yr, mo - 1, dy, hr - 1, mn, 0, 0)); // WAT = UTC+1
}

/**
 * Start the shift scheduler that auto-activates/deactivates shifts
 * based on WAT time. Runs every 30 seconds.
 * @param {Object} io - Socket.io server instance
 */
function startShiftScheduler(io) {
  const CHECK_INTERVAL = 30 * 1000; // 30 seconds

  logger.info('Starting shift scheduler (checking every 30s, WAT timezone)');

  setInterval(async () => {
    try {
      const { dateStr: todayDate, timeStr: currentTime } = getNowWAT();

      // 1. Find all shifts that span today and are not cancelled
      const todaysShifts = await WorkShift.find({
        startDate: { $lte: todayDate },
        endDate: { $gte: todayDate },
        status: { $ne: 'cancelled' },
      }).populate('userId', 'name');

      for (const shift of todaysShifts) {
        const userId = shift.userId?._id || shift.userId;
        const shouldBeActive = currentTime >= shift.startTime && currentTime < shift.endTime;

        // ACTIVATE: should be active but isn't, and not emergency-controlled
        if (shouldBeActive && !shift.isActive && !shift.emergencyActivated) {
          shift.isActive = true;
          shift.status = 'in-progress';
          await shift.save();

          io.to(`user-${userId}`).emit('shift:activated', {
            shiftId: shift._id,
            startTime: shift.startTime,
            endTime: shift.endTime,
          });
          logger.info(`Shift ${shift._id} activated for user ${userId}`);
        }

        // SHIFT-END WARNINGS: 5-min and 2-min before endTime for active shifts
        if (shift.isActive && todayDate === shift.endDate) {
          const shiftEndUTC = watTimeToDate(shift.endDate, shift.endTime);
          const nowUTC = new Date();
          const minsLeft = (shiftEndUTC - nowUTC) / 60000;

          for (const warnMins of [5, 2]) {
            const cacheKey = `${shift._id}:${warnMins}`;
            if (minsLeft > 0 && minsLeft <= warnMins && !warningSentCache.has(cacheKey)) {
              warningSentCache.add(cacheKey);
              await notify(io, {
                type: 'shift_ending_soon',
                title: 'Shift Ending Soon',
                body: `Your shift ends in ${warnMins} minute${warnMins > 1 ? 's' : ''} (at ${shift.endTime} WAT).`,
                userId: String(userId),
                metadata: { shiftId: shift._id, endTime: shift.endTime, minsLeft: warnMins },
              });
              logger.info(`Shift-end ${warnMins}-min warning sent to user ${userId} for shift ${shift._id}`);
            }
          }

          // Clear cache entries for this shift after it ends (prevent memory leak)
          if (minsLeft <= 0) {
            warningSentCache.delete(`${shift._id}:5`);
            warningSentCache.delete(`${shift._id}:2`);
          }
        }

        // DEACTIVATE: should NOT be active but is, and not emergency-controlled
        if (!shouldBeActive && shift.isActive && !shift.emergencyActivated) {
          shift.isActive = false;
          // If past endTime on endDate, complete the shift
          if (todayDate === shift.endDate && currentTime >= shift.endTime) {
            shift.status = 'completed';
          }
          await shift.save();

          // Auto clock-out any open attendance record for this user
          try {
            const openAttendance = await Attendance.findOne({
              userId,
              clockOutAt: null,
            });
            if (openAttendance) {
              // Compute exact shift end as a UTC Date from WAT time (WAT = UTC+1)
              const [endHour, endMin] = shift.endTime.split(':').map(Number);
              const [yr, mo, dy] = shift.endDate.split('-').map(Number);
              const shiftEndUTC = new Date(Date.UTC(yr, mo - 1, dy, endHour - 1, endMin, 0, 0));
              openAttendance.clockOutAt = shiftEndUTC;
              openAttendance.autoClockOut = true;
              await openAttendance.save();
              logger.info(`Auto clocked out user ${userId} at shift end ${shift.endTime} (shift ${shift._id})`);
            }
          } catch (clockOutErr) {
            logger.error(`Auto clock-out failed for user ${userId}:`, clockOutErr.message);
          }

          io.to(`user-${userId}`).emit('shift:deactivated', {
            shiftId: shift._id,
            endTime: shift.endTime,
          });
          io.to(`user-${userId}`).emit(`user:${userId}:force:logout`, {
            reason: 'Shift time ended',
          });
          logger.info(`Shift ${shift._id} deactivated for user ${userId} — force logout emitted`);
        }
      }

      // 2. Auto-complete shifts that ended on a previous date
      await WorkShift.updateMany(
        {
          endDate: { $lt: todayDate },
          status: { $in: ['scheduled', 'in-progress'] },
        },
        {
          $set: { status: 'completed', isActive: false, emergencyActivated: false },
        }
      );

      // 3. Purge old read notifications once per day
      const now = Date.now();
      if (!lastNotifCleanup || now - lastNotifCleanup > 24 * 60 * 60 * 1000) {
        lastNotifCleanup = now;
        try {
          const deleted = await purgeOldReadNotifications();
          if (deleted > 0) logger.info(`[NotifCleanup] Deleted ${deleted} old read notifications`);
        } catch (cleanupErr) {
          logger.error('[NotifCleanup] Failed:', cleanupErr.message);
        }
      }
    } catch (error) {
      logger.error('Shift scheduler error:', error.message);
    }
  }, CHECK_INTERVAL);
}

module.exports = { startShiftScheduler };
