const express = require('express');
const router = express.Router();
const Hospital = require('../models/Hospital');
const Bed = require('../models/Bed');
const User = require('../models/User');
const { auth, adminOnly } = require('../middleware/auth');

// Helper: create individual bed slots when hospital is created/updated
async function createBedSlots(hospitalId, beds, isHiddenToggle = false) {
    const types = ['ICU', 'General', 'Emergency', 'Maternity'];
    for (const type of types) {
        const bedConfig = beds[type];
        if (!bedConfig || !bedConfig.total) continue;

        const existing = await Bed.countDocuments({ hospitalId, bedType: type });
        if (existing >= bedConfig.total) continue;

        const toCreate = bedConfig.total - existing;
        const hiddenCount = bedConfig.hidden || 0;
        const visibleCount = bedConfig.total - hiddenCount;

        for (let i = 0; i < toCreate; i++) {
            const bedNum = existing + i + 1;
            const isHidden = bedNum > visibleCount;
            const floor = Math.ceil(bedNum / 10).toString();
            const room = String.fromCharCode(65 + Math.floor((bedNum - 1) / 5) % 6); // A-F rooms
            await Bed.create({
                hospitalId,
                bedType: type,
                bedNumber: `${type.slice(0, 3)}-${String(bedNum).padStart(3, '0')}`,
                floor,
                room,
                isHidden,
                status: 'available'
            });
        }
    }
}

// GET /api/hospitals — public (only visible beds, no hidden counts)
router.get('/', async (req, res) => {
    try {
        const { availableOnly } = req.query;
        const hospitals = await Hospital.find({ isActive: true });

        let result = hospitals.map(h => {
            const data = h.toObject();
            ['ICU', 'General', 'Emergency', 'Maternity'].forEach(t => {
                if (data.beds[t]) {
                    delete data.beds[t].hidden; // never expose hidden count to public
                }
            });
            return data;
        });

        if (availableOnly === 'true') {
            result = result.filter(h =>
                ['ICU', 'General', 'Emergency', 'Maternity'].some(t => (h.beds[t]?.available || 0) > 0)
            );
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /api/hospitals/:id — auth users can see full bed info (admin sees hidden too)
router.get('/:id', auth, async (req, res) => {
    try {
        const hospital = await Hospital.findById(req.params.id);
        if (!hospital) return res.status(404).json({ message: 'Hospital not found' });

        const isOwnerAdmin = req.user.role === 'admin' && String(req.user.hospitalId) === String(hospital._id);
        if (!isOwnerAdmin) {
            const data = hospital.toObject();
            ['ICU', 'General', 'Emergency', 'Maternity'].forEach(t => { if (data.beds[t]) delete data.beds[t].hidden; });
            return res.json(data);
        }
        res.json(hospital);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/hospitals/:id/beds — visual bed grid for admin/booking
router.get('/:id/beds', auth, async (req, res) => {
    try {
        const { bedType, showHidden } = req.query;
        const hospital = await Hospital.findById(req.params.id);
        if (!hospital) return res.status(404).json({ message: 'Not found' });

        const filter = { hospitalId: req.params.id };
        if (bedType && bedType !== 'All') filter.bedType = bedType;

        const isOwnerAdmin = req.user.role === 'admin' && String(req.user.hospitalId) === String(hospital._id);
        // Allow seeing hidden beds if requested (emergency UI logic or admin)
        if (showHidden !== 'true') {
            filter.isHidden = false;
        }

        const beds = await Bed.find(filter)
            .populate('bookingId', 'userId status isAdmitted lowPriority')
            .sort({ bedType: 1, bedNumber: 1 });

        res.json(beds);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/hospitals — admin creates hospital
router.post('/', auth, adminOnly, async (req, res) => {
    try {
        const { name, city, address, phone, beds } = req.body;
        if (!name || !city) return res.status(400).json({ message: 'Name and city required' });
        const hospital = await Hospital.create({ name, city, address, phone, beds, adminId: req.user._id });
        await User.findByIdAndUpdate(req.user._id, { hospitalId: hospital._id });
        await createBedSlots(hospital._id, beds);
        res.status(201).json(hospital);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH /api/hospitals/:id/beds — update aggregate bed counts + create new slots if needed
router.patch('/:id/beds', auth, adminOnly, async (req, res) => {
    try {
        const hospital = await Hospital.findById(req.params.id);
        if (!hospital) return res.status(404).json({ message: 'Not found' });
        if (String(hospital.adminId) !== String(req.user._id)) return res.status(403).json({ message: 'Not your hospital' });

        const { bedType, field, value } = req.body;
        if (!['ICU', 'General', 'Emergency', 'Maternity'].includes(bedType)) return res.status(400).json({ message: 'Invalid bed type' });
        if (!['total', 'hidden'].includes(field)) return res.status(400).json({ message: 'Invalid field' });

        hospital.beds[bedType][field] = Math.max(0, Number(value));

        // Recalculate visible based on total and hidden
        hospital.beds[bedType].visible = Math.max(0, hospital.beds[bedType].total - (hospital.beds[bedType].hidden || 0));

        await hospital.save();

        // Create new bed slots if total increased
        await createBedSlots(hospital._id, hospital.beds);

        // Retroactively update the isHidden flag on existing beds
        const existingBeds = await Bed.find({ hospitalId: hospital._id, bedType: bedType }).sort({ bedNumber: 1 });
        const visibleCount = Math.max(0, hospital.beds[bedType].total - (hospital.beds[bedType].hidden || 0));

        for (let i = 0; i < existingBeds.length; i++) {
            const shouldBeHidden = i >= visibleCount;
            if (existingBeds[i].isHidden !== shouldBeHidden) {
                existingBeds[i].isHidden = shouldBeHidden;
                await existingBeds[i].save();
            }
        }

        // Recalculate available from actual DB physical available beds to prevent drift
        const availableCount = await Bed.countDocuments({ hospitalId: hospital._id, bedType: bedType, status: 'available' });

        hospital.beds[bedType].available = availableCount;
        await hospital.save();

        const io = req.app.get('io');
        if (io) io.emit('bed-update', { hospitalId: hospital._id, beds: hospital.beds });
        res.json(hospital);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// PATCH /api/hospitals/:id/toggle-hidden
router.patch('/:id/toggle-hidden', auth, adminOnly, async (req, res) => {
    try {
        const hospital = await Hospital.findById(req.params.id);
        if (!hospital) return res.status(404).json({ message: 'Not found' });
        if (String(hospital.adminId) !== String(req.user._id)) return res.status(403).json({ message: 'Access denied' });
        hospital.hiddenBedsVisible = !hospital.hiddenBedsVisible;
        await hospital.save();
        res.json({ hiddenBedsVisible: hospital.hiddenBedsVisible });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// POST /api/hospitals/:id/transfer-bed — admin internal bed transfer (drag-drop within hospital)
router.post('/:id/transfer-bed', auth, adminOnly, async (req, res) => {
    try {
        const { fromBedId, toBedId } = req.body;
        const hospital = await Hospital.findById(req.params.id);
        if (!hospital || String(hospital.adminId) !== String(req.user._id)) return res.status(403).json({ message: 'Not your hospital' });

        const fromBed = await Bed.findById(fromBedId);
        const toBed = await Bed.findById(toBedId);
        if (!fromBed || !toBed) return res.status(404).json({ message: 'Bed not found' });
        if (!fromBed.bookingId) return res.status(400).json({ message: 'Source bed is empty' });
        if (toBed.status !== 'available') return res.status(409).json({ message: 'Target bed is not available' });

        // Swap
        const bookingId = fromBed.bookingId;
        const bookingStatus = fromBed.status;
        toBed.bookingId = bookingId;
        toBed.status = bookingStatus;
        fromBed.bookingId = null;
        fromBed.status = 'available';
        await Promise.all([fromBed.save(), toBed.save()]);

        // Update booking's bedSlotId
        if (bookingId) {
            const Booking = require('../models/Booking');
            await Booking.findByIdAndUpdate(bookingId, { bedSlotId: toBed._id });
        }

        res.json({ message: 'Patient transferred to new bed', fromBed, toBed });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
