// ============================================================================
// ROLE PERMISSIONS - Permission Mapping for User Roles
// ============================================================================

// Default permissions per role, using the same string values as the frontend
// Permission enum so they can be stored in MongoDB Role documents without any
// translation layer.  Roles use lowercase names to match User.role field values.
const DEFAULT_ROLE_PERMISSIONS = {
  admin: [
    // Order
    'VIEW_ORDERS', 'CREATE_ORDER', 'EDIT_ORDER', 'DELETE_ORDER',
    'ASSIGN_STAFF', 'UPDATE_ORDER_STATUS',
    // Customer
    'VIEW_CUSTOMERS', 'CREATE_CUSTOMER', 'EDIT_CUSTOMER', 'DELETE_CUSTOMER',
    'MANAGE_WALLET', 'MANAGE_LOYALTY',
    // Services
    'VIEW_SERVICES', 'MANAGE_SERVICES', 'MANAGE_PRICING',
    // Payments
    'VIEW_PAYMENTS', 'CONFIRM_PAYMENT', 'PROCESS_REFUND', 'MANAGE_PAYMENT_SETTINGS',
    // Staff
    'VIEW_STAFF', 'CREATE_STAFF', 'EDIT_STAFF', 'DELETE_STAFF',
    'MANAGE_ROLES', 'MANAGE_PERMISSIONS',
    // Shifts & Attendance
    'VIEW_SHIFTS', 'MANAGE_SHIFTS', 'VIEW_ATTENDANCE', 'MANAGE_ATTENDANCE', 'CLOCK_IN_OUT',
    // Payroll
    'VIEW_PAYROLL', 'MANAGE_PAYROLL', 'GENERATE_PAYSLIPS', 'VIEW_OWN_PAYSLIP',
    // Chat
    'VIEW_CHAT', 'RESPOND_CHAT', 'ASSIGN_CHAT', 'CLOSE_CHAT',
    // Reports
    'VIEW_REPORTS', 'EXPORT_REPORTS', 'VIEW_AUDIT_LOGS',
    // System
    'MANAGE_SETTINGS', 'MANAGE_PROMO_CODES', 'MANAGE_SUBSCRIPTIONS',
    'MANAGE_LOYALTY_PROGRAM', 'MANAGE_REFERRAL_PROGRAM', 'SEND_NOTIFICATIONS',
  ],

  manager: [
    'VIEW_ORDERS', 'CREATE_ORDER', 'EDIT_ORDER', 'ASSIGN_STAFF', 'UPDATE_ORDER_STATUS',
    'VIEW_CUSTOMERS', 'CREATE_CUSTOMER', 'EDIT_CUSTOMER', 'MANAGE_WALLET', 'MANAGE_LOYALTY',
    'VIEW_SERVICES',
    'VIEW_PAYMENTS', 'CONFIRM_PAYMENT',
    'VIEW_STAFF', 'VIEW_SHIFTS', 'VIEW_ATTENDANCE',
    'VIEW_REPORTS', 'EXPORT_REPORTS',
    'VIEW_CHAT', 'RESPOND_CHAT', 'ASSIGN_CHAT', 'CLOSE_CHAT',
    'SEND_NOTIFICATIONS', 'VIEW_PAYROLL',
  ],

  receptionist: [
    'VIEW_ORDERS', 'CREATE_ORDER', 'UPDATE_ORDER_STATUS',
    'VIEW_CUSTOMERS', 'CREATE_CUSTOMER', 'EDIT_CUSTOMER',
    'VIEW_PAYMENTS', 'CONFIRM_PAYMENT',
    'VIEW_SERVICES',
    'VIEW_CHAT', 'RESPOND_CHAT',
  ],

  staff: [
    'VIEW_ORDERS', 'UPDATE_ORDER_STATUS',
    'VIEW_CUSTOMERS',
    'CLOCK_IN_OUT', 'VIEW_SHIFTS',
    'VIEW_OWN_PAYSLIP',
    'VIEW_CHAT', 'RESPOND_CHAT',
  ],
};

/**
 * Get permissions for a given role (sync, uses hardcoded defaults).
 * Kept for backward compatibility with existing middleware callers.
 * @param {string} role - User role
 * @returns {string[]} Array of permissions
 */
const getRolePermissions = (role) => {
  if (!role) return [];
  return DEFAULT_ROLE_PERMISSIONS[role.toLowerCase()] || [];
};

/**
 * Get permissions for a given role, checking the DB first then falling back
 * to the hardcoded defaults.  Use this in sendTokenResponse so JWTs always
 * carry the live DB permissions.
 * @param {string} role - User role
 * @returns {Promise<string[]>} Array of permissions
 */
const getRolePermissionsFromDB = async (role) => {
  const Role = require('../models/Role.js');
  const normalized = (role || '').toLowerCase();
  try {
    const doc = await Role.findOne({ name: normalized });
    if (doc && doc.permissions.length > 0) return doc.permissions;
  } catch (_) {}
  return DEFAULT_ROLE_PERMISSIONS[normalized] || [];
};

/**
 * Check if a role has a specific permission
 * @param {string} role - User role
 * @param {string} permission - Permission to check
 * @returns {boolean} True if role has permission
 */
const hasPermission = (role, permission) => {
  const permissions = getRolePermissions(role);
  return permissions.includes(permission);
};

/**
 * Check if a role has any of the specified permissions
 * @param {string} role - User role
 * @param {string[]} permissions - Array of permissions to check
 * @returns {boolean} True if role has any of the permissions
 */
const hasAnyPermission = (role, permissions) => {
  const rolePerms = getRolePermissions(role);
  return permissions.some(perm => rolePerms.includes(perm));
};

/**
 * Check if a role has all of the specified permissions
 * @param {string} role - User role
 * @param {string[]} permissions - Array of permissions to check
 * @returns {boolean} True if role has all of the permissions
 */
const hasAllPermissions = (role, permissions) => {
  const rolePerms = getRolePermissions(role);
  return permissions.every(perm => rolePerms.includes(perm));
};

module.exports = {
  DEFAULT_ROLE_PERMISSIONS,
  rolePermissions: DEFAULT_ROLE_PERMISSIONS, // backward-compat alias
  getRolePermissions,
  getRolePermissionsFromDB,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
};
