const express = require('express');
const router = express.Router();
const Queue = require('../models/Queue');
const Hospital = require('../models/Hospital');
const User = require('../models/User');
const { auth, adminOnly } = require('../middleware/auth');

// POST /api/queue/join — only if no beds available
router.post('/join', auth, async (req, res) => {
    try {
        const { hospitalId, bedType, reason, symptoms } = req.body;
        if (!hospitalId || !bedType) return res.status(400).json({ message: 'hospitalId and bedType required' });

        const hospital = await Hospital.findById(hospitalId);
        if (!hospital) return res.status(404).json({ message: 'Hospital not found' });

        // Enforce: can only join queue if beds are actually full
        if ((hospital.beds[bedType]?.available || 0) > 0) {
            return res.status(400).json({ message: 'Beds are available — please book directly instead of joining queue.', bedsAvailable: true });
        }

        let queue = await Queue.findOne({ hospitalId, bedType });
        if (!queue) queue = await Queue.create({ hospitalId, bedType, entries: [] });

        const alreadyIn = queue.entries.some(e => String(e.userId) === String(req.user._id));
        if (alreadyIn) {
            const pos = queue.entries.findIndex(e => String(e.userId) === String(req.user._id));
            return res.json({ message: 'Already in queue', position: pos + 1, total: queue.entries.length });
        }

        queue.entries.push({ userId: req.user._id, reason: reason || '', symptoms: symptoms || '' });
        queue.updatedAt = new Date();
        await queue.save();

        res.status(201).json({ message: 'Joined queue', position: queue.entries.length, total: queue.entries.length });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/queue/status/:hospitalId/:bedType — user checks own position
router.get('/status/:hospitalId/:bedType', auth, async (req, res) => {
    try {
        const { hospitalId, bedType } = req.params;
        const queue = await Queue.findOne({ hospitalId, bedType });
        if (!queue || queue.entries.length === 0) {
            return res.json({ inQueue: false, position: null, total: 0, estimatedWaitMinutes: 0 });
        }
        const pos = queue.entries.findIndex(e => String(e.userId) === String(req.user._id));
        if (pos === -1) return res.json({ inQueue: false, total: queue.entries.length });
        res.json({ inQueue: true, position: pos + 1, total: queue.entries.length, estimatedWaitMinutes: pos * 30 });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// GET /api/queue/all — admin sees ONLY their hospital's queues
router.get('/all', auth, adminOnly, async (req, res) => {
    try {
        const adminUser = await User.findById(req.user._id);
        if (!adminUser.hospitalId) return res.json([]);

        const queues = await Queue.find({ hospitalId: adminUser.hospitalId })
            .populate('entries.userId', 'name email patientId')
            .populate('hospitalId', 'name');
        res.json(queues);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// DELETE /api/queue/remove/:queueId/:userId — admin removes user from queue after admit
router.delete('/remove/:queueId/:userId', auth, adminOnly, async (req, res) => {
    try {
        const { queueId, userId } = req.params;
        const queue = await Queue.findById(queueId);
        if (!queue) return res.status(404).json({ message: 'Queue not found' });
        queue.entries = queue.entries.filter(e => String(e.userId) !== String(userId));
        queue.updatedAt = new Date();
        await queue.save();
        res.json({ message: 'Removed from queue', remaining: queue.entries.length });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
