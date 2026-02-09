# Relux Laundry Backend API (JavaScript)

A production-ready backend API for a comprehensive laundry management system built with **Node.js, Express, and MongoDB** using **pure JavaScript** (no TypeScript).

## 🚀 Features

- ✅ **Authentication & Authorization**: JWT-based authentication with OTP support
- ✅ **Role-Based Access Control**: Customer, Staff (Receptionist, Washer, Delivery), Admin, Manager
- ✅ **Order Management**: Complete order lifecycle from creation to delivery
- ✅ **Real-time Updates**: Socket.io integration for live order status updates
- ✅ **Payment Processing**: Multiple payment methods (Cash, POS, Online, Wallet)
- ✅ **Security**: Rate limiting, Helmet, CORS, data sanitization, HPP protection
- ✅ **Load Balancing**: PM2 cluster mode for optimal performance
- ✅ **Logging**: Winston logger with file rotation
- ✅ **API Documentation**: RESTful API with comprehensive endpoints

## 📋 Prerequisites

- Node.js (v16 or higher)
- MongoDB (v5 or higher)
- npm or yarn

## 🛠️ Installation

### 1. Clone or extract the project
```bash
cd relux-laundry-backend-js
```

### 2. Install dependencies
```bash
npm install
```

### 3. Environment Setup
```bash
cp .env.example .env
```

Edit `.env` and configure your settings:
```env
NODE_ENV=development
PORT=5000
MONGODB_URI=mongodb://localhost:27017/relux-laundry
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRE=30d
CLIENT_URL=http://localhost:3000
```

### 4. Make sure MongoDB is running
```bash
# Ubuntu/Linux
sudo systemctl start mongod

# macOS with Homebrew
brew services start mongodb-community

# Or use Docker
docker run -d -p 27017:27017 --name mongodb mongo:latest
```

## 🎯 Running the Application

### Development Mode (with hot reload)
```bash
npm run dev
```

### Production Mode (Single Instance)
```bash
npm start
```

### Production Mode with Load Balancing (PM2 Cluster - RECOMMENDED)
```bash
npm run start:cluster
```

This will:
- Start PM2 in cluster mode
- Use ALL CPU cores for load balancing
- Auto-restart on crashes
- Enable zero-downtime deployments

### PM2 Management Commands
```bash
npm run stop          # Stop the application
npm run restart       # Restart the application
npm run logs          # View application logs
npm run monitor       # Monitor CPU, memory usage
npm run delete        # Remove the PM2 process
```

## 🧪 Seed Database

```bash
# Import sample data (admin, staff, customers, orders)
npm run seed -- -i

# Delete all data
npm run seed -- -d
```

**Sample accounts created:**
- Admin: `08011111111` / `admin123`
- Manager: `08022222222` / `manager123`
- Receptionist: `08033333333` / `staff123`
- Washer: `08044444444` / `staff123`
- Delivery: `08055555555` / `staff123`
- Customer: `08066666666` / `customer123`

## 📡 API Endpoints

### Base URL
```
http://localhost:5000/api/v1
```

### Health Check
```bash
GET /health
```

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login with phone/password
- `POST /api/v1/auth/request-otp` - Request OTP for phone
- `POST /api/v1/auth/verify-otp` - Verify OTP
- `GET /api/v1/auth/me` - Get current user
- `PUT /api/v1/auth/update` - Update user profile
- `PUT /api/v1/auth/updatepassword` - Change password
- `GET /api/v1/auth/logout` - Logout
- `POST /api/v1/auth/addresses` - Add address

### Orders
- `POST /api/v1/orders` - Create new order
- `GET /api/v1/orders` - Get all orders (with filters)
- `GET /api/v1/orders/:id` - Get single order
- `PUT /api/v1/orders/:id/status` - Update order status (Staff/Admin)
- `PUT /api/v1/orders/:id/assign` - Assign staff to order (Admin)
- `PUT /api/v1/orders/:id/payment` - Update payment status (Staff/Admin)
- `PUT /api/v1/orders/:id/cancel` - Cancel order

### User Management (Admin/Manager)
- `GET /api/v1/users` - Get all users
- `GET /api/v1/users/:id` - Get single user
- `POST /api/v1/users/staff` - Create staff account
- `PUT /api/v1/users/:id` - Update user
- `PUT /api/v1/users/:id/deactivate` - Deactivate user
- `DELETE /api/v1/users/:id` - Delete user

### Admin Dashboard (Admin/Manager)
- `GET /api/v1/admin/dashboard` - Get dashboard stats
- `GET /api/v1/admin/reports/revenue` - Get revenue report
- `GET /api/v1/admin/stats/orders` - Get order statistics

## 🔐 Authentication

All protected routes require a JWT token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

## 👥 User Roles

- **customer**: Can create orders, view own orders, manage profile
- **staff**: Can view and update orders, manage order status
  - **receptionist**: Front desk staff
  - **washer**: Laundry operators
  - **delivery**: Delivery personnel
- **admin/manager**: Full access to all endpoints

## 🔄 Order Status Flow

```
pending → confirmed → picked-up → washing → ironing → 
ready → out-for-delivery → delivered → completed
```

Status can also be set to `cancelled` at any point before `completed`.

## 🌐 Real-time Updates (Socket.io)

Connect to Socket.io server for real-time order updates:

```javascript
const io = require('socket.io-client');
const socket = io('http://localhost:5000');

// Join order room to receive updates
socket.emit('join-order', orderId);

// Listen for order updates
socket.on('order-status-updated', (data) => {
  console.log('Order status updated:', data);
});
```

## 🛡️ Security Features

- **Helmet**: Security headers
- **CORS**: Cross-Origin Resource Sharing
- **Rate Limiting**: Prevents brute force attacks
  - General API: 100 requests / 15 minutes
  - Auth endpoints: 5 attempts / 15 minutes
  - Order creation: 10 orders / hour
- **Data Sanitization**: Prevents NoSQL injection
- **HPP**: HTTP Parameter Pollution protection
- **XSS Protection**: Cross-site scripting prevention
- **Password Hashing**: bcryptjs
- **JWT Authentication**: Secure token-based auth

## 📊 Load Balancing

The application uses PM2 cluster mode to run multiple instances across all CPU cores for optimal performance and zero-downtime deployments.

PM2 features:
- Automatic load balancing
- Auto-restart on crashes
- Memory management
- Log management
- Production-ready process manager

## 📝 Logging

Winston logger with:
- File rotation
- Different log levels (error, warn, info, debug)
- Separate error logs
- Console logging in development

Logs are stored in `src/logs/`:
- `error.log` - Error logs only
- `combined.log` - All logs
- `pm2-*.log` - PM2 process logs

## 📁 Project Structure

```
relux-laundry-backend-js/
├── src/
│   ├── config/
│   │   └── database.js           # MongoDB connection
│   ├── models/
│   │   ├── User.js               # User schema
│   │   └── Order.js              # Order schema
│   ├── controllers/
│   │   ├── authController.js     # Authentication logic
│   │   ├── orderController.js    # Order management
│   │   ├── userController.js     # User management
│   │   └── adminController.js    # Admin functions
│   ├── routes/
│   │   ├── authRoutes.js
│   │   ├── orderRoutes.js
│   │   ├── userRoutes.js
│   │   └── adminRoutes.js
│   ├── middleware/
│   │   ├── auth.js               # JWT authentication
│   │   ├── rateLimiter.js        # Rate limiting
│   │   └── errorHandler.js       # Error handling
│   ├── utils/
│   │   ├── logger.js             # Winston logger
│   │   ├── helpers.js            # Helper functions
│   │   ├── appError.js           # Custom error class
│   │   ├── asyncHandler.js       # Async wrapper
│   │   └── seeder.js             # Database seeder
│   ├── app.js                    # Express app setup
│   └── server.js                 # Server startup with Socket.io
├── .env                          # Environment variables
├── .env.example                  # Environment template
├── ecosystem.config.js           # PM2 configuration
├── package.json                  # Dependencies
├── README.md                     # This file
└── API_DOCS.md                   # API documentation
```

## 🚀 Deployment

See the full README for detailed deployment instructions including:
- VPS setup
- MongoDB configuration
- Nginx reverse proxy
- SSL certificate setup
- PM2 process management

## 📚 Next Steps

1. **Payment Integration**: Add Paystack/Flutterwave when ready
2. **SMS/OTP**: Integrate Twilio/Termii for OTP functionality
3. **Email Notifications**: Configure Nodemailer
4. **Push Notifications**: Add Firebase Cloud Messaging
5. **File Uploads**: Integrate Cloudinary for receipts/images

## 🆘 Troubleshooting

### MongoDB Connection Error
```bash
sudo systemctl status mongod
sudo systemctl restart mongod
```

### Port Already in Use
```bash
lsof -i :5000
kill -9 <PID>
```

### PM2 Not Starting
```bash
pm2 delete relux-laundry-api
npm run start:cluster
```

## 📄 License

ISC

## 👨‍💻 Author

Godswill - Full Stack Developer

---

**Note**: Remember to change all default secrets and passwords in production!
#   r e l u x - l a u n d r y - b a c k e n d - j s  
 