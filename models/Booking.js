const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    bedSlotId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bed', default: null }, // specific bed
    bedType: { type: String, enum: ['ICU', 'General', 'Emergency', 'Maternity'], required: true },
    reason: {
        type: String,
        required: true
    },
    symptoms: { type: String, default: '' },
    aiSeverity: {
        level: { type: String, enum: ['Critical', 'Moderate', 'Low', ''], default: '' },
        suggestedBedType: { type: String, default: '' },
        reason: { type: String, default: '' }
    },
    // Appointment slot
    appointmentSlot: { type: Date, default: null }, // null = immediate/walk-in
    isImmediate: { type: Boolean, default: true },
    // Status flow: pending → confirmed/rejected → active (admitted) → completed/cancelled
    status: {
        type: String,
        enum: ['pending', 'confirmed', 'rejected', 'active', 'cancelled', 'completed', 'discharged'],
        default: 'pending'
    },
    isAdmitted: { type: Boolean, default: false }, // false = unoccupied (yellow), true = admitted (occupied)
    adminNote: { type: String, default: '' },
    usedHiddenBed: { type: Boolean, default: false },
    // Timer: if not admitted within 3 mins of confirmed, flag as low priority
    lowPriority: { type: Boolean, default: false },
    timerStartedAt: { type: Date, default: null },
    // Discharge
    dischargedAt: { type: Date, default: null },
    dischargeNote: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date, default: null }
});

module.exports = mongoose.model('Booking', bookingSchema);
