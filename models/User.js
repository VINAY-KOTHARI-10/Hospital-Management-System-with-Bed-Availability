const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

function genPatientId() {
  return 'P-' + Math.random().toString(36).toUpperCase().slice(2, 10);
}

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  patientId: { type: String, unique: true, sparse: true }, // P-XXXXXXXX for users
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },
  activeBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
  bookingHistory: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Booking' }],
  // Scoring
  totalBookings: { type: Number, default: 0 },
  totalCancellations: { type: Number, default: 0 },
  noShows: { type: Number, default: 0 }, // booked but not admitted within timer
  flaggedForFraud: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Auto-generate patient ID for users
userSchema.pre('save', function (next) {
  if (this.role === 'user' && !this.patientId) {
    this.patientId = genPatientId();
  }
  next();
});

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// Reliability score: percentage based on successful vs uncompleted bookings
userSchema.virtual('reliabilityScore').get(function () {
  const total = this.totalBookings || 0;
  const cancels = this.totalCancellations || 0;
  const noshows = this.noShows || 0;

  if (total === 0) return 100;

  // Standard weighted completion rate
  const score = ((total - cancels - (2 * noshows)) / total) * 100;
  return Math.round(Math.max(0, Math.min(100, score)));
});

module.exports = mongoose.model('User', userSchema);
