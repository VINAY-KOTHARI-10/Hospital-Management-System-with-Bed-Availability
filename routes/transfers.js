const express = require('express');
const router = express.Router();
const Transfer = require('../models/Transfer');
const Booking = require('../models/Booking');
const Hospital = require('../models/Hospital');
const User = require('../models/User');
const Bed = require('../models/Bed');
const Notification = require('../models/Notification');
const { auth, adminOnly } = require('../middleware/auth');

async function notify(io, userId, message, type) {
    const notif = await Notification.create({ userId, message, type });
    if (io) io.to(String(userId)).emit('notification', notif);
}

// POST /api/transfers/request — Admin A creates request
router.post('/request', auth, adminOnly, async (req, res) => {
    try {
        const { toHospitalId, patientName, patientAge, bedType, reason, bookingId } = req.body;
        if (!toHospitalId || !patientName || !bedType || !reason) {
            return res.status(400).json({ message: 'toHospitalId, patientName, bedType, reason are required' });
        }

        const fromHospital = await Hospital.findOne({ adminId: req.user._id });
        if (!fromHospital) return res.status(400).json({ message: 'No hospital linked to your admin account' });

        const toHospital = await Hospital.findById(toHospitalId);
        if (!toHospital) return res.status(404).json({ message: 'Destination hospital not found' });

        const transfer = await Transfer.create({
            fromHospitalId: fromHospital._id,
            toHospitalId,
            requestedByAdminId: req.user._id,
            patientName,
            patientAge: patientAge || null,
            bedType,
            reason,
            bookingId: bookingId || null
        });

        // Notify admin of destination hospital
        if (toHospital.adminId) {
            await notify(req.app.get('io'), toHospital.adminId,
                `Transfer request from ${fromHospital.name} for patient ${patientName} (${bedType}).`, 'transfer');
        }

        res.status(201).json(transfer);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/transfers/accept/:id — Admin B accepts
router.post('/accept/:id', auth, adminOnly, async (req, res) => {
    try {
        const transfer = await Transfer.findById(req.params.id)
            .populate('fromHospitalId', 'name adminId')
            .populate('toHospitalId');

        if (!transfer) return res.status(404).json({ message: 'Transfer not found' });
        if (transfer.status !== 'pending') return res.status(400).json({ message: 'Transfer already processed' });

        const myHospital = await Hospital.findOne({ adminId: req.user._id });
        if (!myHospital || String(myHospital._id) !== String(transfer.toHospitalId._id)) {
            return res.status(403).json({ message: 'You do not manage the destination hospital' });
        }

        // Check bed availability
        const bedInfo = myHospital.beds[transfer.bedType];
        if (!bedInfo || bedInfo.available <= 0) {
            return res.status(400).json({ message: `No ${transfer.bedType} beds available to accept transfer` });
        }

        // Allocate specific bed slot
        const selectedBed = await Bed.findOne({ hospitalId: myHospital._id, bedType: transfer.bedType, status: 'available' });
        if (!selectedBed) {
            return res.status(400).json({ message: `No specific ${transfer.bedType} bed slot available to finalize transfer` });
        }

        // Update bed slot status
        selectedBed.status = 'occupied';
        await selectedBed.save();

        myHospital.beds[transfer.bedType].available = Math.max(0, myHospital.beds[transfer.bedType].available - 1);
        await myHospital.save();

        // If it's a registered user, create/update an active booking
        let newBooking = null;
        if (transfer.bookingId) {
            const oldBooking = await Booking.findById(transfer.bookingId);
            if (oldBooking && oldBooking.bedSlotId) {
                const oldBed = await Bed.findById(oldBooking.bedSlotId);
                if (oldBed) {
                    oldBed.status = 'available';
                    oldBed.bookingId = null;
                    await oldBed.save();
                    const oldHospital = await Hospital.findById(oldBed.hospitalId);
                    if (oldHospital && oldHospital.beds[oldBed.bedType]) {
                        oldHospital.beds[oldBed.bedType].available += 1;
                        await oldHospital.save();
                        req.app.get('io').emit('bed-update', { hospitalId: oldHospital._id, beds: oldHospital.beds });
                    }
                }
            }

            newBooking = await Booking.findByIdAndUpdate(transfer.bookingId, {
                hospitalId: myHospital._id,
                bedSlotId: selectedBed._id,
                status: 'active',
                isAdmitted: true
            }, { new: true });
        }

        transfer.status = 'accepted';
        transfer.respondedAt = new Date();
        await transfer.save();

        if (newBooking) {
            selectedBed.bookingId = newBooking._id;
            await selectedBed.save();
        }

        const io = req.app.get('io');
        if (io) io.emit('bed-update', { hospitalId: myHospital._id, beds: myHospital.beds });

        // Notify requesting admin
        const reqAdmin = transfer.fromHospitalId.adminId;
        if (reqAdmin) {
            await notify(io, reqAdmin,
                `Transfer of ${transfer.patientName} to ${myHospital.name} has been ACCEPTED.`, 'transfer');
        }

        res.json({ message: 'Transfer accepted', transfer });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/transfers/reject/:id — Admin B rejects
router.post('/reject/:id', auth, adminOnly, async (req, res) => {
    try {
        const transfer = await Transfer.findById(req.params.id).populate('fromHospitalId', 'adminId name');
        if (!transfer) return res.status(404).json({ message: 'Transfer not found' });
        if (transfer.status !== 'pending') return res.status(400).json({ message: 'Transfer already processed' });

        transfer.status = 'rejected';
        transfer.respondedAt = new Date();
        await transfer.save();

        if (transfer.fromHospitalId.adminId) {
            await notify(req.app.get('io'), transfer.fromHospitalId.adminId,
                `Transfer of patient ${transfer.patientName} was REJECTED by destination hospital.`, 'transfer');
        }

        res.json({ message: 'Transfer rejected', transfer });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /api/transfers — admin sees transfers for their hospital
router.get('/', auth, adminOnly, async (req, res) => {
    try {
        const hospital = await Hospital.findOne({ adminId: req.user._id });
        if (!hospital) return res.json([]);

        const transfers = await Transfer.find({
            $or: [{ fromHospitalId: hospital._id }, { toHospitalId: hospital._id }]
        })
            .populate('fromHospitalId', 'name city')
            .populate('toHospitalId', 'name city')
            .sort({ createdAt: -1 });

        res.json(transfers);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
