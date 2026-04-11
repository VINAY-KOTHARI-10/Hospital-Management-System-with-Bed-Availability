const mongoose = require('mongoose');

const transferSchema = new mongoose.Schema({
    fromHospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    toHospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    requestedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    patientName: { type: String, required: true },
    patientAge: { type: Number, default: null },
    bedType: { type: String, enum: ['ICU', 'General', 'Emergency', 'Maternity'], required: true },
    reason: { type: String, required: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
    newBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null }, // created on accept
    respondedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transfer', transferSchema);
