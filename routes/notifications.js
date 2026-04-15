const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const { auth } = require('../middleware/auth');

// GET /api/notifications — user's own notifications
router.get('/', auth, async (req, res) => {
    try {
        const notifs = await Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50);
        res.json(notifs);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// PATCH /api/notifications/read/:id
router.patch('/read/:id', auth, async (req, res) => {
    try {
        const notif = await Notification.findOneAndUpdate(
            { _id: req.params.id, userId: req.user._id },
            { read: true },
            { new: true }
        );
        if (!notif) return res.status(404).json({ message: 'Notification not found' });
        res.json(notif);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', auth, async (req, res) => {
    try {
        await Notification.updateMany({ userId: req.user._id, read: false }, { read: true });
        res.json({ message: 'All notifications marked as read' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
