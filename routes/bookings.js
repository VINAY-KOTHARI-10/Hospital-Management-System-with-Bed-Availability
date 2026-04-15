const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const Bed = require('../models/Bed');
const Hospital = require('../models/Hospital');
const User = require('../models/User');
const Queue = require('../models/Queue');
const Notification = require('../models/Notification');
const { auth, adminOnly } = require('../middleware/auth');

async function notify(io, userId, message, type) {
    const notif = await Notification.create({ userId, message, type });
    if (io) io.to(String(userId)).emit('notification', notif);
}

async function freeBedSlot(bedSlotId, io, hospitalId, bedType) {
    if (bedSlotId) {
        await Bed.findByIdAndUpdate(bedSlotId, { status: 'available', bookingId: null });
    }
    // increment available count on hospital
    const hospital = await Hospital.findById(hospitalId);
    if (hospital && hospital.beds[bedType]) {
        hospital.beds[bedType].available = Math.min(
            hospital.beds[bedType].visible,
            (hospital.beds[bedType].available || 0) + 1
        );
        await hospital.save();
        if (io) io.emit('bed-update', { hospitalId, beds: hospital.beds });
    }
}

// POST /api/bookings/book — user selects a specific bed slot
router.post('/book', auth, async (req, res) => {
    try {
        const { hospitalId, bedType, bedSlotId, reason, symptoms, appointmentSlot, isImmediate, confirmCancel } = req.body;
        if (!hospitalId || !bedType || !reason) {
            return res.status(400).json({ message: 'hospitalId, bedType and reason are required' });
        }

        const io = req.app.get('io');
        const hospital = await Hospital.findById(hospitalId);
        if (!hospital) return res.status(404).json({ message: 'Hospital not found' });

        // Single booking rule
        if (req.user.activeBookingId) {
            if (!confirmCancel) {
                return res.status(409).json({ message: 'You already have an active booking.', hasActiveBooking: true });
            }
            const oldBooking = await Booking.findById(req.user.activeBookingId);
            if (oldBooking && ['pending', 'confirmed', 'active'].includes(oldBooking.status)) {
                oldBooking.status = 'cancelled';
                oldBooking.cancelledAt = new Date();
                await oldBooking.save();
                await freeBedSlot(oldBooking.bedSlotId, io, oldBooking.hospitalId, oldBooking.bedType);
                await User.findByIdAndUpdate(req.user._id, { activeBookingId: null, $inc: { totalCancellations: 1 } });
                await notify(io, req.user._id, 'Your previous booking was auto-cancelled.', 'cancellation');
            }
        }

        // Validate the specific bed slot
        let selectedBed = null;
        if (bedSlotId) {
            selectedBed = await Bed.findById(bedSlotId);
            if (!selectedBed || selectedBed.hospitalId.toString() !== hospitalId) {
                return res.status(400).json({ message: 'Invalid bed slot selected' });
            }
            if (selectedBed.status !== 'available') {
                return res.status(409).json({ message: 'This bed has just been taken. Please select another.' });
            }
        } else {
            // Auto-assign first available non-hidden bed
            selectedBed = await Bed.findOne({ hospitalId, bedType, status: 'available', isHidden: false });
            if (!selectedBed) {
                return res.status(400).json({ message: 'No beds available. Please join the queue.', noBedsAvailable: true });
            }
        }

        // Reserve the bed slot immediately (pending = seat held)
        selectedBed.status = 'pending';
        await selectedBed.save();

        // Decrement available count
        if (hospital.beds[bedType]) {
            hospital.beds[bedType].available = Math.max(0, (hospital.beds[bedType].available || 0) - 1);
            await hospital.save();
        }
        if (io) io.emit('bed-update', { hospitalId: hospital._id, beds: hospital.beds });

        // Create booking in pending status
        const booking = await Booking.create({
            userId: req.user._id,
            hospitalId,
            bedSlotId: selectedBed._id,
            bedType,
            reason,
            symptoms: symptoms || '',
            appointmentSlot: appointmentSlot || null,
            isImmediate: isImmediate !== false,
            status: 'pending'
        });

        selectedBed.bookingId = booking._id;
        await selectedBed.save();

        await User.findByIdAndUpdate(req.user._id, {
            activeBookingId: booking._id,
            $push: { bookingHistory: booking._id },
            $inc: { totalBookings: 1 }
        });

        // Notify admin of hospital
        if (hospital.adminId) {
            await notify(io, hospital.adminId, `New booking request: ${req.user.name} needs a ${bedType} bed. Reason: ${reason}`, 'booking');
        }
        await notify(io, req.user._id, `Booking request submitted for a ${bedType} bed at ${hospital.name}. Awaiting admin confirmation.`, 'booking');

        res.status(201).json({ ...booking.toObject(), bedSlot: selectedBed });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/bookings/admin-respond/:id — admin accepts or rejects
router.post('/admin-respond/:id', auth, adminOnly, async (req, res) => {
    try {
        const { action, note } = req.body; // action: 'confirm' | 'reject'
        const booking = await Booking.findById(req.params.id).populate('userId', 'name email').populate('hospitalId', 'name adminId');
        if (!booking) return res.status(404).json({ message: 'Booking not found' });
        if (String(booking.hospitalId.adminId) !== String(req.user._id)) {
            return res.status(403).json({ message: 'Not your hospital' });
        }
        if (booking.status !== 'pending') return res.status(400).json({ message: 'Booking is not pending' });

        const io = req.app.get('io');
        if (action === 'confirm') {
            booking.status = 'confirmed';
            booking.adminNote = note || '';
            booking.timerStartedAt = new Date(); // start 3-min admission timer
            await booking.save();

            // Update bed slot to unoccupied (yellow — confirmed but not yet admitted)
            if (booking.bedSlotId) {
                await Bed.findByIdAndUpdate(booking.bedSlotId, { status: 'unoccupied' });
            }

            await notify(io, booking.userId._id,
                `✅ Your ${booking.bedType} bed booking at ${booking.hospitalId.name} has been CONFIRMED. Please arrive within 3 minutes to admit.`,
                'booking');

            // Set 3-min timeout to auto-cancel
            setTimeout(async () => {
                const fresh = await Booking.findById(booking._id);
                if (fresh && fresh.status === 'confirmed' && !fresh.isAdmitted) {
                    fresh.status = 'cancelled';
                    fresh.cancelledAt = new Date();
                    await fresh.save();

                    if (fresh.bedSlotId) {
                        await Bed.findByIdAndUpdate(fresh.bedSlotId, { status: 'available', bookingId: null });
                    }
                    const hosp = await Hospital.findById(fresh.hospitalId);
                    if (hosp && hosp.beds[fresh.bedType]) {
                        hosp.beds[fresh.bedType].available = Math.min(
                            hosp.beds[fresh.bedType].visible,
                            (hosp.beds[fresh.bedType].available || 0) + 1
                        );
                        await hosp.save();
                        if (io) io.emit('bed-update', { hospitalId: hosp._id, beds: hosp.beds });
                    }

                    await User.findByIdAndUpdate(fresh.userId, { activeBookingId: null, $inc: { noShows: 1 } });

                    if (io) io.to(String(fresh.userId)).emit('notification', {
                        message: '❌ Your booking was automatically cancelled because you were not admitted within 3 minutes.',
                        type: 'cancellation'
                    });
                }
            }, 3 * 60 * 1000); // 3 minutes

        } else if (action === 'reject') {
            booking.status = 'rejected';
            booking.adminNote = note || '';
            await booking.save();

            // Free the bed slot back
            if (booking.bedSlotId) {
                await Bed.findByIdAndUpdate(booking.bedSlotId, { status: 'available', bookingId: null });
            }
            const hospital = await Hospital.findById(booking.hospitalId._id);
            if (hospital && hospital.beds[booking.bedType]) {
                hospital.beds[booking.bedType].available = Math.min(
                    hospital.beds[booking.bedType].visible,
                    (hospital.beds[booking.bedType].available || 0) + 1
                );
                await hospital.save();
                if (io) io.emit('bed-update', { hospitalId: hospital._id, beds: hospital.beds });
            }
            await User.findByIdAndUpdate(booking.userId._id, { activeBookingId: null });
            await notify(io, booking.userId._id,
                `❌ Your ${booking.bedType} bed booking at ${booking.hospitalId.name} was rejected. ${note ? 'Reason: ' + note : ''}`,
                'cancellation');
        }

        res.json({ message: `Booking ${action}d`, booking });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/bookings/admit/:id — admin marks patient as admitted
router.post('/admit/:id', auth, adminOnly, async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id).populate('hospitalId', 'adminId name');
        if (!booking) return res.status(404).json({ message: 'Not found' });
        if (String(booking.hospitalId.adminId) !== String(req.user._id)) return res.status(403).json({ message: 'Not your hospital' });

        booking.isAdmitted = true;
        booking.status = 'active';
        booking.lowPriority = false;
        await booking.save();
        if (booking.bedSlotId) await Bed.findByIdAndUpdate(booking.bedSlotId, { status: 'occupied' });

        const io = req.app.get('io');
        await notify(io, booking.userId, `You have been admitted to ${booking.hospitalId.name}. Welcome!`, 'booking');
        res.json(booking);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/bookings/discharge/:id — admin discharges patient
router.post('/discharge/:id', auth, adminOnly, async (req, res) => {
    try {
        const { note } = req.body;
        const booking = await Booking.findById(req.params.id)
            .populate('hospitalId', 'name adminId')
            .populate('userId', 'name email patientId')
            .populate('bedSlotId', 'bedNumber bedType floor room');
        if (!booking) return res.status(404).json({ message: 'Not found' });
        if (String(booking.hospitalId.adminId) !== String(req.user._id)) return res.status(403).json({ message: 'Not your hospital' });

        booking.status = 'discharged';
        booking.dischargedAt = new Date();
        booking.dischargeNote = note || '';
        await booking.save();

        // Free bed slot
        if (booking.bedSlotId) await Bed.findByIdAndUpdate(booking.bedSlotId._id, { status: 'available', bookingId: null });
        const hospital = await Hospital.findById(booking.hospitalId._id);
        if (hospital && hospital.beds[booking.bedType]) {
            hospital.beds[booking.bedType].available = Math.min(
                hospital.beds[booking.bedType].visible,
                (hospital.beds[booking.bedType].available || 0) + 1
            );
            await hospital.save();
        }
        await User.findByIdAndUpdate(booking.userId._id, { activeBookingId: null });

        const io = req.app.get('io');
        if (io) io.emit('bed-update', { hospitalId: booking.hospitalId._id, beds: hospital?.beds });
        await notify(io, booking.userId._id, `You have been discharged from ${booking.hospitalId.name}. Download your discharge receipt.`, 'general');

        res.json(booking);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE /api/bookings/cancel/:id
router.delete('/cancel/:id', auth, async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ message: 'Not found' });
        if (String(booking.userId) !== String(req.user._id) && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Unauthorized' });
        }
        if (!['pending', 'confirmed', 'active'].includes(booking.status)) {
            return res.status(400).json({ message: 'Cannot cancel this booking' });
        }

        booking.status = 'cancelled';
        booking.cancelledAt = new Date();
        await booking.save();

        const io = req.app.get('io');
        await freeBedSlot(booking.bedSlotId, io, booking.hospitalId, booking.bedType);
        await User.findByIdAndUpdate(booking.userId, { activeBookingId: null, $inc: { totalCancellations: 1 } });

        await notify(io, booking.userId, `Your ${booking.bedType} bed booking was cancelled.`, 'cancellation');
        res.json({ message: 'Booking cancelled' });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/bookings/my
router.get('/my', auth, async (req, res) => {
    try {
        const bookings = await Booking.find({ userId: req.user._id })
            .populate('hospitalId', 'name city')
            .populate('bedSlotId', 'bedNumber floor room')
            .sort({ createdAt: -1 });
        res.json(bookings);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/bookings/all — admin sees only their hospital's bookings
router.get('/all', auth, adminOnly, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user._id);
        const filter = adminUser.hospitalId ? { hospitalId: adminUser.hospitalId } : {};

        const bookings = await Booking.find(filter)
            .populate('userId', 'name email patientId flaggedForFraud totalCancellations totalBookings')
            .populate('hospitalId', 'name city')
            .populate('bedSlotId', 'bedNumber floor room')
            .sort({ createdAt: -1 });
        res.json(bookings);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/bookings/score — user's own reliability score
router.get('/score', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        const total = user.totalBookings || 0;
        const cancels = user.totalCancellations || 0;
        const noshows = user.noShows || 0;

        let score = 100;
        if (total > 0) {
            score = Math.round(Math.max(0, Math.min(100, ((total - cancels - (2 * noshows)) / total) * 100)));
        }
        const bookings = await Booking.find({ userId: req.user._id })
            .populate('hospitalId', 'name city')
            .sort({ createdAt: -1 });
        res.json({
            patientId: user.patientId,
            name: user.name,
            email: user.email,
            totalBookings: user.totalBookings,
            totalCancellations: user.totalCancellations,
            noShows: user.noShows,
            score,
            bookings
        });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/bookings/:id
router.get('/:id', auth, async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id)
            .populate('userId', 'name email patientId flaggedForFraud')
            .populate('hospitalId', 'name city')
            .populate('bedSlotId', 'bedNumber floor room');
        if (!booking) return res.status(404).json({ message: 'Booking not found' });
        // Optional auth check: ensure user owns booking or is admin of that hospital
        res.json(booking);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/bookings/manual-admit
router.post('/manual-admit', auth, adminOnly, async (req, res) => {
    try {
        const { bedSlotId, bedType: reqBedType, patientName, patientAge, reason, note, isHiddenBed, adminPassword } = req.body;
        if (!patientName) return res.status(400).json({ message: 'Patient name is required' });
        if (!bedSlotId && !reqBedType) return res.status(400).json({ message: 'Either bedSlotId or bedType is required' });

        if (isHiddenBed) {
            if (!adminPassword) return res.status(400).json({ message: 'Admin password is required for hidden beds' });
            const adminUser = await User.findById(req.user._id);
            const isMatch = await adminUser.comparePassword(adminPassword);
            if (!isMatch) return res.status(401).json({ message: 'Invalid admin password' });
        }

        let selectedBed;
        if (bedSlotId) {
            // Specific bed slot provided
            selectedBed = await Bed.findById(bedSlotId);
        } else {
            // Auto-find first available bed of the requested type in admin's hospital
            const query = {
                hospitalId: req.user.hospitalId,
                bedType: reqBedType,
                status: 'available'
            };
            if (!isHiddenBed) query.isHidden = { $ne: true };
            selectedBed = await Bed.findOne(query);
            if (!selectedBed && isHiddenBed) {
                // fallback: try any hidden bed of that type
                selectedBed = await Bed.findOne({ hospitalId: req.user.hospitalId, bedType: reqBedType, status: 'available', isHidden: true });
            }
        }

        if (!selectedBed || selectedBed.status !== 'available') {
            return res.status(400).json({ message: `No available ${reqBedType || ''} beds found. Try a different category.` });
        }
        if (String(selectedBed.hospitalId) !== String(req.user.hospitalId)) {
            return res.status(403).json({ message: 'Not your hospital' });
        }

        const hospital = await Hospital.findById(req.user.hospitalId);

        // Create unlinked walk-in user account silently
        const dummyEmail = `walkin_${Date.now()}@meditrack.local`;
        const dummyPass = Math.random().toString(36).slice(-8);
        const user = await User.create({ name: patientName, email: dummyEmail, password: dummyPass, role: 'user' });

        // Update bed available counts
        if (hospital && hospital.beds[selectedBed.bedType]) {
            hospital.beds[selectedBed.bedType].available = Math.max(0, (hospital.beds[selectedBed.bedType].available || 0) - 1);
            await hospital.save();
        }

        const booking = await Booking.create({
            userId: user._id,
            hospitalId: req.user.hospitalId,
            bedSlotId: selectedBed._id,
            bedType: selectedBed.bedType,
            reason: reason || 'Queue promotion',
            isImmediate: true,
            status: 'active',
            isAdmitted: true,
            adminNote: note ? `Manual Admittance (Age ${patientAge || '?'}): ${note}` : `Manual Admittance (Age ${patientAge || '?'})`
        });

        selectedBed.bookingId = booking._id;
        selectedBed.status = 'occupied';
        await selectedBed.save();

        const io = req.app.get('io');
        if (io) io.emit('bed-update', { hospitalId: req.user.hospitalId, beds: hospital.beds });

        res.status(201).json({ message: 'Manual admittance successful', booking, bedType: selectedBed.bedType, bedNumber: selectedBed.bedNumber });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/bookings/my-bookings — authenticated patient's own full history
router.get('/my-bookings', auth, async (req, res) => {
    try {
        const bookings = await Booking.find({ userId: req.user._id })
            .populate('hospitalId', 'name city')
            .populate('bedSlotId', 'bedNumber room floor')
            .sort({ createdAt: -1 });
        res.json(bookings);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
