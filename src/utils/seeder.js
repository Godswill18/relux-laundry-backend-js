require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User.js');
const Order = require('../models/Order.js');
const logger = require('./logger.js');

// ─── Production guard ────────────────────────────────────────────────────────
// Both modes of this script are destructive: -i and -d each run
// User.deleteMany() and Order.deleteMany() with no filter, wiping every
// customer, staff account and order. The backend's .env holds the live
// MONGODB_URI, so a stray `npm run seed` from that folder would erase production.
//
// NODE_ENV alone is not enough: the .env this runs against has had
// NODE_ENV=development while pointing at the live remote cluster. So the check
// is on where the database actually is.
//
//   • NODE_ENV=production        → always refused, no override.
//   • local database             → allowed (localhost / 127.0.0.1 / ::1).
//   • any remote database        → refused unless SEED_CONFIRM_DB is set to the
//                                   exact database name, as a deliberate
//                                   typed-out confirmation.
//
// Runs before mongoose.connect, so a refusal never opens a connection.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

function describeTarget(uri) {
  // Parse only what is needed; the URI itself (with credentials) is never logged.
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const withoutCreds  = withoutScheme.replace(/^[^@/]*@/, '');
  const [hostPart, rest = ''] = withoutCreds.split(/\/(.*)/s);
  const hosts  = hostPart.split(',').map((h) => h.replace(/:\d+$/, '').toLowerCase());
  const dbName = decodeURIComponent(rest.split('?')[0] || '');
  const isLocal = !uri.startsWith('mongodb+srv') && hosts.length > 0 && hosts.every((h) => LOCAL_HOSTS.includes(h));
  return { isLocal, dbName };
}

function assertSafeToSeed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Refusing to run: MONGODB_URI is not set.');
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production') {
    console.error(
      'Refusing to run: NODE_ENV is "production".\n' +
      'This script deletes every user and every order. It is never run in production.'
    );
    process.exit(1);
  }

  const { isLocal, dbName } = describeTarget(uri);
  if (isLocal) return;

  const confirmed = dbName && process.env.SEED_CONFIRM_DB === dbName;
  if (!confirmed) {
    console.error(
      'Refusing to run: MONGODB_URI points at a REMOTE database' +
      (dbName ? ` ("${dbName}")` : '') + '.\n' +
      'This script deletes every user and every order before inserting sample data.\n\n' +
      'If this really is a disposable database, confirm it by typing its name:\n' +
      // Deliberately a placeholder, never the detected name: printing the real
      // name here would hand over a ready-to-paste command for wiping it.
      '  SEED_CONFIRM_DB=<database-name> npm run seed -- -i\n\n' +
      'Never do this against the live Relux database.'
    );
    process.exit(1);
  }

  console.warn(`WARNING: seeding remote database "${dbName}" — confirmed via SEED_CONFIRM_DB.`);
}

// Connect to database
const connectDB = async () => {
  assertSafeToSeed();
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info('MongoDB Connected');
  } catch (error) {
    logger.error(`MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

// Sample data
const users = [
  {
    name: 'Admin User',
    email: 'admin@reluxlaundry.com',
    phone: '08011111111',
    password: 'admin123',
    role: 'admin',
  },
  {
    name: 'John Manager',
    email: 'manager@reluxlaundry.com',
    phone: '08022222222',
    password: 'manager123',
    role: 'manager',
  },
  {
    name: 'Jane Receptionist',
    email: 'receptionist@reluxlaundry.com',
    phone: '08033333333',
    password: 'staff123',
    role: 'staff',
    staffRole: 'receptionist',
  },
  {
    name: 'Mike Washer',
    email: 'washer@reluxlaundry.com',
    phone: '08044444444',
    password: 'staff123',
    role: 'staff',
    staffRole: 'washer',
  },
  {
    name: 'Sarah Delivery',
    email: 'delivery@reluxlaundry.com',
    phone: '08055555555',
    password: 'staff123',
    role: 'staff',
    staffRole: 'delivery',
  },
  {
    name: 'Test Customer',
    email: 'customer@test.com',
    phone: '08066666666',
    password: 'customer123',
    role: 'customer',
    addresses: [
      {
        street: '123 Main Street',
        landmark: 'Near City Mall',
        city: 'Lagos',
        state: 'Lagos',
        isDefault: true,
      },
    ],
  },
];

// Import data into DB
const importData = async () => {
  try {
    await connectDB();

    // Clear existing data
    await User.deleteMany();
    await Order.deleteMany();

    // Insert users
    const createdUsers = await User.create(users);
    logger.info(`${createdUsers.length} users created`);

    // Create sample order
    const customer = createdUsers.find((u) => u.role === 'customer');
    if (customer) {
      const order = await Order.create({
        customer: customer._id,
        serviceType: 'wash-iron',
        orderType: 'pickup-delivery',
        items: [
          { itemType: 'shirt', quantity: 5, description: 'White shirts' },
          { itemType: 'trouser', quantity: 3, description: 'Black trousers' },
        ],
        pickupAddress: {
          street: '123 Main Street',
          city: 'Lagos',
          state: 'Lagos',
        },
        deliveryAddress: {
          street: '123 Main Street',
          city: 'Lagos',
          state: 'Lagos',
        },
        pickupDate: new Date(),
        scheduledPickupTime: '10:00 AM',
        specialInstructions: 'Handle with care',
        pricing: {
          subtotal: 5000,
          pickupFee: 500,
          deliveryFee: 500,
          discount: 0,
          tax: 450,
          total: 6450,
        },
        payment: {
          method: 'cash',
          status: 'pending',
          amount: 6450,
        },
      });

      logger.info(`Sample order created: ${order.orderNumber}`);
    }

    logger.info('Data imported successfully');
    process.exit(0);
  } catch (error) {
    logger.error(`Error importing data: ${error.message}`);
    process.exit(1);
  }
};

// Delete data from DB
const deleteData = async () => {
  try {
    await connectDB();

    await User.deleteMany();
    await Order.deleteMany();

    logger.info('Data deleted successfully');
    process.exit(0);
  } catch (error) {
    logger.error(`Error deleting data: ${error.message}`);
    process.exit(1);
  }
};

// Run seeder
if (process.argv[2] === '-i') {
  importData();
} else if (process.argv[2] === '-d') {
  deleteData();
} else {
  console.log('Usage:');
  console.log('  npm run seed -- -i    Import data');
  console.log('  npm run seed -- -d    Delete data');
  process.exit(0);
}
