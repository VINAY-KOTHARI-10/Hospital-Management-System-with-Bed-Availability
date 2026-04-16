require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Make io available to routes
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/hospitals', require('./routes/hospitals'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/transfers', require('./routes/transfers'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/notifications', require('./routes/notifications'));

// Serve frontend for all other routes (SPA-style)
// Serve HTML files specifically if they exist in public
app.get('/:page.html', (req, res, next) => {
    const filePath = path.join(__dirname, 'public', `${req.params.page}.html`);
    res.sendFile(filePath, err => {
        if (err) next(); // if file doesn't exist, continue
    });
});

// Default to index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve frontend for all other unknown routes (fallback)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io — join personal room for targeted notifications
io.on('connection', (socket) => {
    socket.on('join-room', (userId) => {
        if (userId) socket.join(String(userId));
    });
    socket.on('disconnect', () => { });
});

// Connect to MongoDB and start server
const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('✅ MongoDB connected');
        server.listen(PORT, () => console.log(`🏥 Hospital Management System running on http://localhost:${PORT}`));
    })
    .catch(err => {
        console.error('❌ MongoDB connection failed:', err.message);
        process.exit(1);
    });
