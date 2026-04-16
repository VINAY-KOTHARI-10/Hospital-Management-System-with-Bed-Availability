require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Hospital = require('./models/Hospital');

// This seed only creates demo USER accounts.
// Hospitals are created when Admin users register through the UI.
// To add a hospital, register as Hospital Admin on the login page.

async function seed() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB');

        // Clear only users (not hospitals — those come from admin registration)
        await User.deleteMany({});
        console.log('🗑️  Cleared users');

        // Create demo user accounts only
        const users = [
            { name: 'Vinay Kumar', email: 'user@demo.com', password: 'demo123', role: 'user' },
            { name: 'Priya Singh', email: 'priya@demo.com', password: 'demo123', role: 'user' },
        ];
        for (const u of users) {
            await User.create(u);
        }
        console.log(`👤 Created ${users.length} demo user accounts`);

        console.log('\n──────────────────────────────────────────────────');
        console.log('✅ SEED COMPLETE');
        console.log('──────────────────────────────────────────────────');
        console.log('Demo User Login:  user@demo.com  / demo123');
        console.log('Demo User Login:  priya@demo.com / demo123');
        console.log('');
        console.log('To add hospitals → Register as "Hospital Admin" on the login page.');
        console.log('  Each admin registration creates a new hospital with your bed data.');
        console.log('──────────────────────────────────────────────────\n');

        process.exit(0);
    } catch (err) {
        console.error('❌ Seed failed:', err.message);
        process.exit(1);
    }
}

seed();
