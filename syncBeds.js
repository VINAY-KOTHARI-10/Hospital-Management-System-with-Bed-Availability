require('dotenv').config();
const mongoose = require('mongoose');
const Hospital = require('./models/Hospital');
const Bed = require('./models/Bed');

async function syncAllBeds() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB connected');

        const hospitals = await Hospital.find({});
        for (let h of hospitals) {
            console.log(`Checking Hospital: ${h.name}`);
            const types = ['ICU', 'General', 'Emergency', 'Maternity'];
            for (let type of types) {
                const config = h.beds[type];
                if (!config || !config.total) continue;

                const existingCount = await Bed.countDocuments({ hospitalId: h._id, bedType: type });
                if (existingCount < config.total) {
                    const toCreate = config.total - existingCount;
                    const visibleCount = config.total - (config.hidden || 0);

                    for (let i = 0; i < toCreate; i++) {
                        const bedNum = existingCount + i + 1;
                        const isHidden = bedNum > visibleCount;
                        const floor = Math.ceil(bedNum / 10).toString();
                        const room = String.fromCharCode(65 + Math.floor((bedNum - 1) / 5) % 6);

                        await Bed.create({
                            hospitalId: h._id,
                            bedType: type,
                            bedNumber: `${type.slice(0, 3)}-${String(bedNum).padStart(3, '0')}`,
                            floor,
                            room,
                            isHidden,
                            status: 'available'
                        });
                    }
                    console.log(`--> Created ${toCreate} missing physical beds for ${type}`);
                }

                // Also resync 'available' to match the actual true unbooked beds
                const availableCount = await Bed.countDocuments({ hospitalId: h._id, bedType: type, status: 'available' });
                if (config.available !== availableCount) {
                    config.available = availableCount;
                    h.markModified(`beds.${type}`);
                }
            }
            await h.save();
        }

        console.log('Sync complete');
        process.exit(0);
    } catch (e) {
        console.error('Error during sync:', e);
        process.exit(1);
    }
}

syncAllBeds();
