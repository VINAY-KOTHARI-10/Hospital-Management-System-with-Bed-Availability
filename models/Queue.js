const mongoose = require('mongoose');

const queueEntrySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, default: '' },
    symptoms: { type: String, default: '' },
    joinedAt: { type: Date, default: Date.now }
}, { _id: false });

const queueSchema = new mongoose.Schema({
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    bedType: {
        type: String,
        enum: ['ICU', 'General', 'Emergency', 'Maternity'],
        required: true
    },
    entries: [queueEntrySchema],
    updatedAt: { type: Date, default: Date.now }
});

queueSchema.index({ hospitalId: 1, bedType: 1 }, { unique: true });

module.exports = mongoose.model('Queue', queueSchema);
