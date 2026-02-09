require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User.js');
const Order = require('../models/Order.js');
const logger = require('./logger.js');

// Connect to database
const connectDB = async () => {
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
