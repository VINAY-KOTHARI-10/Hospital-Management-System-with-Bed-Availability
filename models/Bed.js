const mongoose = require('mongoose');

// Individual bed slot (like a movie seat)
const bedSchema = new mongoose.Schema({
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    bedType: { type: String, enum: ['ICU', 'General', 'Emergency', 'Maternity'], required: true },
    bedNumber: { type: String, required: true }, // e.g. "ICU-001"
    floor: { type: String, default: '1' },
    room: { type: String, default: 'A' },
    isHidden: { type: Boolean, default: false }, // reserve/emergency beds
    status: {
        type: String,
        enum: ['available', 'pending', 'occupied', 'unoccupied'], // unoccupied = booked but not admitted (yellow)
        default: 'available'
    },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
    updatedAt: { type: Date, default: Date.now }
});

bedSchema.index({ hospitalId: 1, bedType: 1 });

module.exports = mongoose.model('Bed', bedSchema);
