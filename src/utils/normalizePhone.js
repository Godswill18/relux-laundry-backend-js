/**
 * Normalize phone numbers to E.164 format: +234XXXXXXXXXX
 * Handles: 0812..., 234812..., +234812..., 7012345678 (10 digits)
 * Returns null if the number can't be recognized.
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;

  // +234XXXXXXXXXX — already correct (13 digits, country code first)
  if (digits.startsWith('234') && digits.length === 13) return '+' + digits;
  // 0XXXXXXXXXX — Nigerian local format (11 digits)
  if (digits.startsWith('0') && digits.length === 11) return '+234' + digits.slice(1);
  // XXXXXXXXXX — 10 digits, no leading 0 or country code
  if (digits.length === 10) return '+234' + digits;
  // Has leading + and looks like a full international number
  if (phone.trimStart().startsWith('+') && digits.length >= 11) return '+' + digits;

  return null;
}

module.exports = normalizePhone;
