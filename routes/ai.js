const express = require('express');
const router = express.Router();
const Groq = require('groq-sdk');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { auth, adminOnly } = require('../middleware/auth');

let groq;
try {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
} catch (e) {
    console.warn('Groq client init failed — AI features will use fallback responses');
}

async function callGroq(prompt) {
    if (!groq || !process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_api_key_here') {
        return 'GROQ_API_KEY not configured. Using mock response.';
    }
    const chat = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.1-8b-instant',
        temperature: 0.3,
        max_tokens: 300
    });
    return chat.choices[0]?.message?.content || '';
}

// POST /api/ai/severity — analyze symptoms and suggest severity + bed type
router.post('/severity', auth, async (req, res) => {
    try {
        const { symptoms, reason } = req.body;
        if (!symptoms && !reason) return res.status(400).json({ message: 'symptoms or reason required' });

        const prompt = `You are a medical triage AI assistant for a hospital management system. Based on the patient information below, determine the severity and the most appropriate hospital bed type.

RULES:
- "Emergency" reason or trauma/accident/chest pain/stroke/heart attack/bleeding/burns/fracture/breathing difficulty → severity Critical, bed ICU or Emergency
- "Surgery" reason → severity Moderate, bed General or ICU depending on complexity
- "Maternity" reason or pregnancy-related symptoms → severity Moderate, bed Maternity
- "General illness" or minor symptoms (cold, fever, headache, flu) → severity Low, bed General
- "Accident" reason → severity Critical, bed Emergency
- If symptoms mention ICU-level keywords (ventilator, unconscious, critical, cardiac arrest) → bed ICU
- If symptoms are vague or mild → severity Low, bed General

Patient reason for visit: ${reason || 'Not specified'}
Patient symptoms: ${symptoms || 'Not specified'}

Respond ONLY in this exact JSON format (no extra text, no markdown):
{
  "severity": "Critical" | "Moderate" | "Low",
  "suggestedBedType": "ICU" | "Emergency" | "General" | "Maternity",
  "reason": "Brief explanation in one sentence"
}`;

        const raw = await callGroq(prompt);

        // Try to parse JSON from response
        let parsed = { severity: 'Moderate', suggestedBedType: 'General', reason: 'Default assessment.' };
        try {
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) parsed = JSON.parse(match[0]);
        } catch (_) {
            // Enhanced fallback heuristic when API is not available
            const sym = (symptoms || '').toLowerCase();
            const r = (reason || '').toLowerCase();
            const emergencyKeywords = ['chest pain', 'heart attack', 'stroke', 'unconscious', 'breathing difficulty',
                'severe bleeding', 'cardiac', 'seizure', 'trauma', 'burns', 'fracture', 'accident'];
            const isEmergency = r.includes('emergency') || r.includes('accident') || emergencyKeywords.some(k => sym.includes(k));
            const isMaternity = r.includes('maternity') || sym.includes('pregnancy') || sym.includes('labor') || sym.includes('contractions');
            const isSurgery = r.includes('surgery') || sym.includes('surgery') || sym.includes('operation');
            const isICU = sym.includes('ventilator') || sym.includes('critical') || sym.includes('icu') || sym.includes('cardiac arrest');

            if (isICU) {
                parsed = { severity: 'Critical', suggestedBedType: 'ICU', reason: 'Symptoms indicate critical care - ICU required.' };
            } else if (isEmergency) {
                parsed = { severity: 'Critical', suggestedBedType: 'Emergency', reason: 'Emergency situation requiring immediate attention.' };
            } else if (isMaternity) {
                parsed = { severity: 'Moderate', suggestedBedType: 'Maternity', reason: 'Maternity care required.' };
            } else if (isSurgery) {
                parsed = { severity: 'Moderate', suggestedBedType: 'General', reason: 'Surgical care - general ward recommended.' };
            } else {
                parsed = { severity: 'Low', suggestedBedType: 'General', reason: 'Standard care recommended based on reported symptoms.' };
            }
        }

        res.json(parsed);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/ai/fraud — detect suspicious booking patterns (CANCELLATION-focused)
router.post('/fraud', auth, adminOnly, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ message: 'userId required' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const bookings = await Booking.find({ userId })
            .populate('hospitalId', 'name')
            .sort({ createdAt: -1 })
            .limit(20);

        const summary = bookings.map(b =>
            `- ${b.status} booking at ${b.hospitalId?.name || 'Unknown'} for ${b.bedType} (${b.reason}) on ${b.createdAt.toISOString().split('T')[0]}`
        ).join('\n');

        const totalBookings = bookings.length;
        const cancelled = bookings.filter(b => b.status === 'cancelled').length;
        const cancelRate = totalBookings > 0 ? ((cancelled / totalBookings) * 100).toFixed(1) : 0;
        const rapid = totalBookings >= 3 &&
            (new Date(bookings[0].createdAt) - new Date(bookings[2].createdAt)) < 10 * 60 * 1000;

        const prompt = `You are a hospital fraud detection AI. Analyze this user's booking pattern for suspicious CANCELLATION behavior.

IMPORTANT RULES:
- Multiple bookings alone is NOT suspicious. People can book beds multiple times legitimately.
- Suspicious = HIGH cancellation rate (many cancelled bookings compared to total) or rapid book-cancel cycles.
- A user who booked 2 beds and completed both is NOT suspicious at all.
- Focus on: cancellation count, cancellation percentage, and whether the user has a pattern of booking and quickly cancelling.

User: ${user.name} (${user.email})
Total bookings: ${totalBookings}
Cancelled bookings: ${cancelled} (${cancelRate}% cancellation rate)
Rapid bookings (3+ in 10 min): ${rapid ? 'Yes' : 'No'}
Booking details:
${summary}

Is this user's CANCELLATION pattern suspicious? Respond ONLY in JSON:
{
  "suspicious": true | false,
  "reason": "One sentence explanation focusing on cancellations",
  "riskLevel": "High" | "Medium" | "Low"
}`;

        const raw = await callGroq(prompt);

        let parsed = { suspicious: false, reason: 'No suspicious cancellation pattern detected.', riskLevel: 'Low' };
        try {
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) parsed = JSON.parse(match[0]);
        } catch (_) {
            // Fallback heuristic — ONLY flag based on cancellations, NOT total bookings
            if (cancelled >= 3 && parseFloat(cancelRate) >= 50) {
                parsed = { suspicious: true, reason: `User cancelled ${cancelled} out of ${totalBookings} bookings (${cancelRate}% cancellation rate).`, riskLevel: 'High' };
            } else if (cancelled >= 3) {
                parsed = { suspicious: true, reason: `User has ${cancelled} cancellations which is above normal.`, riskLevel: 'Medium' };
            } else if (rapid && cancelled >= 2) {
                parsed = { suspicious: true, reason: `Rapid booking pattern with ${cancelled} cancellations in a short period.`, riskLevel: 'Medium' };
            } else {
                parsed = { suspicious: false, reason: `Normal booking pattern. ${cancelled} cancellation(s) out of ${totalBookings} booking(s).`, riskLevel: 'Low' };
            }
        }

        // Flag user ONLY if suspicious
        if (parsed.suspicious) {
            await User.findByIdAndUpdate(userId, { flaggedForFraud: true });
            const notif = await Notification.create({ userId, message: 'Your account has been flagged for suspicious cancellation activity.', type: 'fraud' });
            const io = req.app.get('io');
            if (io) io.to(String(userId)).emit('notification', notif);
        } else {
            // Unflag user if previously flagged but now clean
            await User.findByIdAndUpdate(userId, { flaggedForFraud: false });
        }

        res.json({ ...parsed, userId, userName: user.name, totalBookings, cancelled, cancelRate: `${cancelRate}%` });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

const Hospital = require('../models/Hospital');
const Queue = require('../models/Queue');
const Transfer = require('../models/Transfer');

// POST /api/ai/chat — context-aware chatbot for patients and admins
router.post('/chat', auth, async (req, res) => {
    try {
        const { message, conversationHistory } = req.body;
        if (!message) return res.status(400).json({ message: 'message required' });

        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        let contextData = '';

        if (user.role === 'admin') {
            // ── Admin context: their hospital's full status ──
            const hospital = user.hospitalId ? await Hospital.findById(user.hospitalId) : null;
            if (hospital) {
                const beds = hospital.beds || {};
                const bedSummary = Object.entries(beds).map(([type, info]) =>
                    `  ${type}: ${info.available || 0} available / ${info.total || 0} total (${info.hidden || 0} hidden)`
                ).join('\n');

                const bookings = await Booking.find({ hospitalId: hospital._id })
                    .populate('userId', 'name email patientId')
                    .sort({ createdAt: -1 }).limit(15);
                const bookingSummary = bookings.map(b =>
                    `  - ${b.userId?.name || 'Unknown'} (${b.userId?.patientId || '?'}) — ${b.bedType} — Status: ${b.status} — Reason: ${b.reason} — Date: ${b.createdAt.toISOString().split('T')[0]}`
                ).join('\n');

                const queues = await Queue.find({ hospitalId: hospital._id })
                    .populate('entries.userId', 'name email patientId');
                const queueSummary = queues.map(q =>
                    `  ${q.bedType}: ${q.entries.length} waiting — ${q.entries.map(e => e.userId?.name || '?').join(', ')}`
                ).join('\n');

                const transfers = await Transfer.find({
                    $or: [{ fromHospitalId: hospital._id }, { toHospitalId: hospital._id }]
                }).populate('fromHospitalId toHospitalId', 'name').sort({ createdAt: -1 }).limit(10);
                const transferSummary = transfers.map(t =>
                    `  - ${t.patientName} from ${t.fromHospitalId?.name} to ${t.toHospitalId?.name} — ${t.bedType} — Status: ${t.status}`
                ).join('\n');

                contextData = `
HOSPITAL ADMIN CONTEXT:
Hospital Name: ${hospital.name}
City: ${hospital.city}
Address: ${hospital.address || 'N/A'}
Phone: ${hospital.phone || 'N/A'}

BED STATUS:
${bedSummary || '  No bed data'}

RECENT BOOKINGS (last 15):
${bookingSummary || '  No bookings'}

QUEUE STATUS:
${queueSummary || '  No patients in queue'}

TRANSFERS:
${transferSummary || '  No transfers'}
`;
            } else {
                contextData = 'Admin has no hospital assigned yet.';
            }
        } else {
            // ── Patient context: their bookings, queue, notifications ──
            const bookings = await Booking.find({ userId: user._id })
                .populate('hospitalId', 'name city')
                .sort({ createdAt: -1 }).limit(10);
            const bookingSummary = bookings.map(b =>
                `  - Hospital: ${b.hospitalId?.name || 'Unknown'} — Bed: ${b.bedType} (${b.bedSlotLabel || '?'}) — Status: ${b.status} — Reason: ${b.reason} — Date: ${b.createdAt.toISOString().split('T')[0]}${b.appointmentDate ? ' — Appt: ' + new Date(b.appointmentDate).toLocaleDateString() : ''}`
            ).join('\n');

            const activeBooking = bookings.find(b => ['pending', 'confirmed', 'admitted'].includes(b.status));

            const queues = await Queue.find({ 'entries.userId': user._id })
                .populate('hospitalId', 'name');
            const queueSummary = queues.map(q => {
                const pos = q.entries.findIndex(e => String(e.userId) === String(user._id));
                return `  - ${q.hospitalId?.name || '?'} — ${q.bedType} queue — Position: ${pos + 1} of ${q.entries.length}`;
            }).join('\n');

            const notifications = await Notification.find({ userId: user._id }).sort({ createdAt: -1 }).limit(5);
            const notifSummary = notifications.map(n =>
                `  - [${n.read ? 'Read' : 'Unread'}] ${n.message} (${n.createdAt.toISOString().split('T')[0]})`
            ).join('\n');

            contextData = `
PATIENT CONTEXT:
Name: ${user.name}
Email: ${user.email}
Patient ID: ${user.patientId || 'N/A'}
Reliability Score: ${user.score ?? 'N/A'}

CURRENT ACTIVE BOOKING: ${activeBooking ? `${activeBooking.bedType} at ${activeBooking.hospitalId?.name} — Status: ${activeBooking.status}` : 'None'}

BOOKING HISTORY (last 10):
${bookingSummary || '  No bookings yet'}

QUEUE STATUS:
${queueSummary || '  Not in any queue'}

RECENT NOTIFICATIONS:
${notifSummary || '  No notifications'}
`;
        }

        // Build conversation with system prompt
        const systemPrompt = `You are MediBot, a helpful AI assistant for MediTrack Hospital Management System. You have access to the user's current data shown below. Answer questions about their specific data, hospital status, bookings, beds, queues, etc. Be concise, friendly, and specific when referencing their data. If asked about something outside the data provided, say you can only help with hospital/booking information.

${contextData}

Current date: ${new Date().toLocaleDateString()}
User role: ${user.role === 'admin' ? 'Hospital Administrator' : 'Patient'}`;

        // Build messages array with conversation history
        const messages = [{ role: 'system', content: systemPrompt }];
        if (conversationHistory && Array.isArray(conversationHistory)) {
            conversationHistory.slice(-6).forEach(msg => {
                messages.push({ role: msg.role, content: msg.content });
            });
        }
        messages.push({ role: 'user', content: message });

        let reply = 'I apologize, but the AI service is currently unavailable. Please try again later.';
        if (groq && process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here') {
            const chat = await groq.chat.completions.create({
                messages,
                model: 'llama-3.1-8b-instant',
                temperature: 0.4,
                max_tokens: 500
            });
            reply = chat.choices[0]?.message?.content || reply;
        }

        res.json({ reply });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;


