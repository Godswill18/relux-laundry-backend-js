// ─── Loyalty rate resolution — the single source of truth ────────────────────
//
// Before this module there were two independent implementations of one business
// rule, and they used *inverted units*:
//
//   convertPointsToWallet():  points / walletConversionRate     (divisor, pts per ₦1)
//   resolvePointsRedemption(): points * pointsRedemptionValue   (multiplier, ₦ per pt)
//
// Both schema fields defaulted to a value of 5, so an admin who configured
// "5 points = ₦1" got ₦0.20/point on the wallet page and ₦5.00/point at checkout
// — a 25× overvaluation — because `pointsRedemptionValue` was never exposed in
// the admin dashboard and sat at its default forever.
//
// Every rate in this module is expressed in ONE unit: **points per ₦1**, matching
// the admin dashboard's existing label and the customer-facing "5 points = ₦1"
// wording. Nothing outside this module may compute a loyalty rate.

const LoyaltySetting = require('../models/LoyaltySetting.js');

// Falling back to a bare literal is what let the broken rate survive a cleared
// field. The only literal here is the schema's own wallet default.
const DEFAULT_POINTS_PER_NAIRA = 100;

function positiveRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Load the one settings document, creating it on first use.
async function loadLoyaltySettings() {
  let settings = await LoyaltySetting.findOne().lean();
  if (!settings) {
    const created = await LoyaltySetting.create({});
    settings = created.toObject();
  }
  return settings;
}

// Points required for ₦1 of WALLET credit.
function walletPointsPerNaira(settings) {
  return positiveRate(settings?.walletConversionRate) || DEFAULT_POINTS_PER_NAIRA;
}

// Points required for ₦1 of ORDER DISCOUNT.
//
// `redemptionPointsPerCurrency` was already declared on the schema in exactly
// this unit and read by nothing — it is the field this belongs in, so no new
// name is introduced. When it is unset the wallet rate is used rather than a
// literal, so a half-configured install stays internally consistent instead of
// silently reviving the old 25× rate.
function redemptionPointsPerNaira(settings) {
  return positiveRate(settings?.redemptionPointsPerCurrency) || walletPointsPerNaira(settings);
}

// ₦ value of a single point when redeemed against an order.
function nairaPerRedeemedPoint(settings) {
  return 1 / redemptionPointsPerNaira(settings);
}

// Wallet credit for a number of points. Floored — never credit a fraction of ₦1.
function walletCreditForPoints(points, settings) {
  const pts = parseInt(points, 10);
  if (!Number.isFinite(pts) || pts <= 0) return 0;
  return Math.floor(pts / walletPointsPerNaira(settings));
}

// Order discount for a number of points. Floored for the same reason.
function discountForPoints(points, settings) {
  const pts = parseInt(points, 10);
  if (!Number.isFinite(pts) || pts <= 0) return 0;
  return Math.floor(pts / redemptionPointsPerNaira(settings));
}

// Channel availability. The master `enabled` switch gates both channels — it was
// never surfaced to the customer app, so the UI kept offering a conversion and a
// checkout discount that the server then refused or silently zeroed.
function conversionAvailable(settings) {
  return settings?.enabled !== false && settings?.walletConversionEnabled !== false;
}

function redemptionAvailable(settings) {
  return settings?.enabled !== false && settings?.redemptionEnabled !== false;
}

// The exact terms the customer app renders, so no screen derives a rate itself.
function publicLoyaltyTerms(settings) {
  return {
    programEnabled:  settings?.enabled !== false,

    conversionEnabled:    conversionAvailable(settings),
    walletConversionRate: walletPointsPerNaira(settings),   // pts per ₦1
    minConvertPoints:     settings?.minConvertPoints || 0,

    redemptionEnabled:          redemptionAvailable(settings),
    redemptionPointsPerNaira:   redemptionPointsPerNaira(settings), // pts per ₦1
    // Derived for display only — the server is still the one that prices a
    // redemption. Sent so the checkout slider cannot invent its own conversion.
    nairaPerPoint:              nairaPerRedeemedPoint(settings),
    minRedeemPoints:            settings?.minRedeemPoints || 0,
    maxRedeemPercent:           positiveRate(settings?.maxRedeemPercent) || 100,
    maxRedeemPointsPerOrder:    settings?.maxRedeemPointsPerOrder || 0,

    pointsPerCurrency: settings?.pointsPerCurrency || 1,
  };
}

module.exports = {
  DEFAULT_POINTS_PER_NAIRA,
  loadLoyaltySettings,
  walletPointsPerNaira,
  redemptionPointsPerNaira,
  nairaPerRedeemedPoint,
  walletCreditForPoints,
  discountForPoints,
  conversionAvailable,
  redemptionAvailable,
  publicLoyaltyTerms,
};
