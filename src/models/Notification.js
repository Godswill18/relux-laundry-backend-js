const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    type: {
      type: String,
      enum: [
        'order_created', 'order_status_updated', 'order_cancelled', 'order_due_soon',
        'wallet_credited', 'referral_rewarded', 'points_earned', 'points_converted',
        'shift_ending_soon',
        'site_announcement', 'chat_message',
      ],
      required: true,
    },
    channel: {
      type: String,
      enum: ['in_app', 'sms', 'email', 'whatsapp'],
      default: 'in_app',
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    readAt: { type: Date },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

NotificationSchema.index({ userId: 1 });
NotificationSchema.index({ customerId: 1 });
NotificationSchema.index({ type: 1 });

module.exports = mongoose.model('Notification', NotificationSchema);
