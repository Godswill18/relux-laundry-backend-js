// ============================================================================
// SHIFT SCHEDULER - Daily time-based activation/deactivation (WAT timezone)
// ============================================================================

const WorkShift = require('../models/WorkShift.js');
const Attendance = require('../models/Attendance.js');
const logger = require('./logger.js');
const { getNowWAT } = require('./helpers.js');

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
    } catch (error) {
      logger.error('Shift scheduler error:', error.message);
    }
  }, CHECK_INTERVAL);
}

module.exports = { startShiftScheduler };
