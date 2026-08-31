const AppError = require('./appError.js');

// ============================================================================
// ROLE HIERARCHY
// ============================================================================
// Several endpoints accept a role straight from the request body. Without a rank
// check a manager could mint — or promote themselves to — `developer`, which
// bypasses every authorize() gate in the system and is excluded from the staff
// listing.
//
// The rule is: you may assign any role at or **below** your own rank, never above,
// and `developer` may only ever be assigned by a developer. Lateral assignment is
// deliberately allowed so an admin can onboard a second admin — that is a real
// need for the shop owner and is not an escalation, since the caller already
// holds that level. The escalation paths stay closed because assigning *above*
// your rank is refused, and checkTargetModifiable stops you editing anyone at or
// above your own level.
const ROLE_RANK = {
  customer: 0,
  delivery: 1,
  staff: 1,
  receptionist: 2,
  manager: 3,
  admin: 4,
  developer: 5,
};

const rankOf = (role) => ROLE_RANK[String(role || '').toLowerCase()] ?? -1;

/**
 * Assert that `actor` may assign `targetRole`.
 * @returns {AppError|null} an error to hand to next(), or null when allowed.
 */
function checkRoleAssignment(actor, targetRole) {
  if (targetRole === undefined || targetRole === null) return null; // role unchanged

  const requested = String(targetRole).toLowerCase();
  if (!(requested in ROLE_RANK)) {
    return new AppError(`Unknown role '${targetRole}'`, 400);
  }
  if (requested === 'customer') {
    return new AppError('Customer accounts cannot be created through the staff endpoints', 400);
  }
  if (requested === 'developer' && actor.role !== 'developer') {
    return new AppError('Only a developer may assign the developer role', 403);
  }
  if (actor.role !== 'developer' && rankOf(requested) > rankOf(actor.role)) {
    return new AppError(`Your role ('${actor.role}') cannot assign the role '${requested}'`, 403);
  }
  return null;
}

/**
 * Assert that `actor` may modify the existing user `target` at all — this is what
 * stops a manager editing, deactivating or deleting an admin.
 * @returns {AppError|null}
 */
function checkTargetModifiable(actor, target) {
  if (actor.role === 'developer') return null;
  if (target._id.toString() === actor.id) return null; // editing yourself is fine
  if (rankOf(target.role) >= rankOf(actor.role)) {
    return new AppError(
      `Your role ('${actor.role}') cannot modify a user with the role '${target.role}'`,
      403
    );
  }
  return null;
}

module.exports = { ROLE_RANK, rankOf, checkRoleAssignment, checkTargetModifiable };
