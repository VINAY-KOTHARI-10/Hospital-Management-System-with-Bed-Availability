const mongoose = require('mongoose');

const bedTypeSchema = new mongoose.Schema({
    total: { type: Number, default: 0 },
    visible: { type: Number, default: 0 },
    hidden: { type: Number, default: 0 },
    available: { type: Number, default: 0 }
}, { _id: false });

const hospitalSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    city: { type: String, required: true },
    address: { type: String, default: '' },
    phone: { type: String, default: '' },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    beds: {
        ICU: { type: bedTypeSchema, default: () => ({}) },
        General: { type: bedTypeSchema, default: () => ({}) },
        Emergency: { type: bedTypeSchema, default: () => ({}) },
        Maternity: { type: bedTypeSchema, default: () => ({}) }
    },
    hiddenBedsVisible: { type: Boolean, default: false }, // admin toggle
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

// Virtual: total available beds (visible only)
hospitalSchema.virtual('totalAvailable').get(function () {
    return Object.values(this.beds).reduce((sum, b) => sum + (b.available || 0), 0);
});

module.exports = mongoose.model('Hospital', hospitalSchema);
