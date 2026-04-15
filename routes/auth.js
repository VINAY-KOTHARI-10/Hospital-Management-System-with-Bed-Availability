const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const Hospital = require('../models/Hospital');
const Bed = require('../models/Bed');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper to create bed slots (mirrors logic in hospitals router)
async function createBedSlots(hospitalId, beds) {
    const types = ['ICU', 'General', 'Emergency', 'Maternity'];
    for (const type of types) {
        const bedConfig = beds[type];
        if (!bedConfig || !bedConfig.total) continue;
        const total = Number(bedConfig.total);
        const hidden = Number(bedConfig.hidden || 0);
        const visible = total - hidden;
        for (let i = 1; i <= total; i++) {
            const isHidden = i > visible;
            const floor = Math.ceil(i / 10).toString();
            const room = String.fromCharCode(65 + Math.floor((i - 1) / 5) % 6);
            await Bed.create({
                hospitalId,
                bedType: type,
                bedNumber: `${type.slice(0, 3)}-${String(i).padStart(3, '0')}`,
                floor,
                room,
                isHidden,
                status: 'available'
            });
        }
    }
}

const signToken = (id) =>
    jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '7d' });

// POST /api/auth/register
router.post('/register', async (req, res) => {
    try {
        const { name, email, password, role, hospital } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ message: 'Name, email and password are required' });
        }
        const exists = await User.findOne({ email });
        if (exists) return res.status(400).json({ message: 'Email already registered' });

        // Validate admin hospital fields
        if (role === 'admin') {
            if (!hospital || !hospital.name || !hospital.city) {
                return res.status(400).json({ message: 'Hospital name and city are required for admin registration' });
            }
        }

        // Create user first
        const user = await User.create({ name, email, password, role: role || 'user' });

        // If admin — create new hospital and link
        if (role === 'admin' && hospital) {
            const beds = {
                ICU: { total: Number(hospital.ICU || 0), visible: Number(hospital.ICU_visible || hospital.ICU || 0), hidden: Number(hospital.ICU_hidden || 0), available: Number(hospital.ICU || 0) },
                General: { total: Number(hospital.General || 0), visible: Number(hospital.General_visible || hospital.General || 0), hidden: Number(hospital.General_hidden || 0), available: Number(hospital.General || 0) },
                Emergency: { total: Number(hospital.Emergency || 0), visible: Number(hospital.Emergency_visible || hospital.Emergency || 0), hidden: Number(hospital.Emergency_hidden || 0), available: Number(hospital.Emergency || 0) },
                Maternity: { total: Number(hospital.Maternity || 0), visible: Number(hospital.Maternity_visible || hospital.Maternity || 0), hidden: Number(hospital.Maternity_hidden || 0), available: Number(hospital.Maternity || 0) }
            };
            const newHospital = await Hospital.create({
                name: hospital.name,
                city: hospital.city,
                address: hospital.address || '',
                phone: hospital.phone || '',
                adminId: user._id,
                beds
            });
            await createBedSlots(newHospital._id, beds);
            await User.findByIdAndUpdate(user._id, { hospitalId: newHospital._id });
            user.hospitalId = newHospital._id;
        }

        const token = signToken(user._id);
        res.status(201).json({
            token,
            user: {
                _id: user._id, name: user.name, email: user.email, role: user.role,
                hospitalId: user.hospitalId, patientId: user.patientId
            }
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

        const user = await User.findOne({ email });
        if (!user || !(await user.comparePassword(password))) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (user.role === 'user' && !user.patientId) {
            user.patientId = 'P-' + Math.random().toString(36).toUpperCase().slice(2, 10);
            await user.save();
        }

        const token = signToken(user._id);
        res.json({
            token,
            user: {
                _id: user._id, name: user.name, email: user.email, role: user.role,
                hospitalId: user.hospitalId, patientId: user.patientId
            }
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/auth/google
router.post('/google', async (req, res) => {
    try {
        const { idToken, role } = req.body;
        if (!idToken) return res.status(400).json({ message: 'Google ID token required' });

        // If no client ID configured on server, you'd mock this or throw.
        // We'll verify it if possible, otherwise we decode it manually for dev mock.
        let payload;
        if (process.env.GOOGLE_CLIENT_ID) {
            const ticket = await googleClient.verifyIdToken({
                idToken,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
            payload = ticket.getPayload();
        } else {
            // Fallback: manually decode payload for local testing if env is missing
            payload = jwt.decode(idToken);
            if (!payload || !payload.email) return res.status(400).json({ message: 'Invalid token structure' });
        }

        const { email, name, sub } = payload;
        let user = await User.findOne({ email });

        if (!user) {
            // Auto-register user from Google if not found
            user = await User.create({
                name,
                email,
                password: sub || Math.random().toString(36), // Dummy password since they use Google
                role: role || 'user'
            });
        }

        if (user.role === 'user' && !user.patientId) {
            user.patientId = 'P-' + Math.random().toString(36).toUpperCase().slice(2, 10);
            await user.save();
        }

        const token = signToken(user._id);
        res.json({
            token,
            user: {
                _id: user._id, name: user.name, email: user.email, role: user.role,
                hospitalId: user.hospitalId, patientId: user.patientId
            }
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth').auth, async (req, res) => {
    const userObj = req.user.toObject({ virtuals: true });
    if (userObj.reliabilityScore === undefined) {
        userObj.reliabilityScore = req.user.reliabilityScore;
    }
    res.json(userObj);
});

module.exports = router;
