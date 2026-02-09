<!-- # Relux Laundry API Documentation

Complete API reference for the Relux Laundry Backend API.

## Base URL
```
Development: http://localhost:5000/api/v1
Production: https://api.reluxlaundry.com/api/v1
```

## Authentication
All protected endpoints require a Bearer token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

---

## 📱 Authentication Endpoints

### 1. Register User
**POST** `/auth/register`

Create a new user account.

**Request Body:**
```json
{
  "name": "John Doe",
  "phone": "08012345678",
  "email": "john@example.com",
  "password": "password123",
  "role": "customer"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGc...",
    "user": {
      "_id": "64f123...",
      "name": "John Doe",
      "phone": "08012345678",
      "email": "john@example.com",
      "role": "customer",
      "isActive": true,
      "isPhoneVerified": false
    }
  }
}
```

### 2. Login
**POST** `/auth/login`

Login with phone number and password.

**Request Body:**
```json
{
  "phone": "08012345678",
  "password": "password123"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGc...",
    "user": { ... }
  }
}
```

### 3. Request OTP
**POST** `/auth/request-otp`

Request OTP for phone verification or passwordless login.

**Request Body:**
```json
{
  "phone": "08012345678"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "otp": "123456"
}
```

### 4. Verify OTP
**POST** `/auth/verify-otp`

Verify OTP and complete authentication.

**Request Body:**
```json
{
  "phone": "08012345678",
  "otp": "123456"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGc...",
    "user": { ... }
  }
}
```

### 5. Get Current User
**GET** `/auth/me`  
🔒 Protected

Get current user profile.

**Response (200):**
```json
{
  "success": true,
  "message": "User profile fetched successfully",
  "data": {
    "user": {
      "_id": "64f123...",
      "name": "John Doe",
      "phone": "08012345678",
      "email": "john@example.com",
      "role": "customer",
      "addresses": [],
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  }
}
```

### 6. Update Profile
**PUT** `/auth/update`  
🔒 Protected

**Request Body:**
```json
{
  "name": "John Updated",
  "email": "john.updated@example.com",
  "preferredPickupTime": "09:00-12:00"
}
```

### 7. Update Password
**PUT** `/auth/updatepassword`  
🔒 Protected

**Request Body:**
```json
{
  "currentPassword": "password123",
  "newPassword": "newpassword456"
}
```

### 8. Add Address
**POST** `/auth/addresses`  
🔒 Protected

**Request Body:**
```json
{
  "street": "123 Main Street",
  "landmark": "Near City Mall",
  "city": "Lagos",
  "state": "Lagos",
  "isDefault": true
}
```

---

## 🧺 Order Endpoints

### 1. Create Order
**POST** `/orders`  
🔒 Protected

Create a new laundry order.

**Request Body:**
```json
{
  "serviceType": "wash-iron",
  "orderType": "pickup-delivery",
  "items": [
    {
      "itemType": "shirt",
      "quantity": 5,
      "description": "White shirts"
    },
    {
      "itemType": "trouser",
      "quantity": 3,
      "description": "Black trousers"
    }
  ],
  "pickupAddress": {
    "street": "123 Main St",
    "city": "Lagos",
    "state": "Lagos"
  },
  "deliveryAddress": {
    "street": "123 Main St",
    "city": "Lagos",
    "state": "Lagos"
  },
  "pickupDate": "2024-02-05T10:00:00Z",
  "scheduledPickupTime": "10:00 AM",
  "specialInstructions": "Handle with care",
  "pricing": {
    "subtotal": 5000,
    "pickupFee": 500,
    "deliveryFee": 500,
    "discount": 0,
    "tax": 450,
    "total": 6450
  },
  "paymentMethod": "cash"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Order created successfully",
  "data": {
    "order": {
      "_id": "64f456...",
      "orderNumber": "RLX17065432100001",
      "customer": "64f123...",
      "serviceType": "wash-iron",
      "status": "pending",
      "items": [ ... ],
      "pricing": { ... },
      "payment": {
        "method": "cash",
        "status": "pending",
        "amount": 6450
      },
      "qrCode": "RELUX-RLX17065432100001-1706543210"
    }
  }
}
```

### 2. Get All Orders
**GET** `/orders`  
🔒 Protected

Get orders with filters and pagination.

**Query Parameters:**
- `page` (number): Page number (default: 1)
- `limit` (number): Items per page (default: 10)
- `status` (string): Filter by status
- `serviceType` (string): Filter by service type
- `customer` (string): Filter by customer ID (Admin/Staff only)

**Example:**
```
GET /orders?page=1&limit=10&status=pending
```

**Response (200):**
```json
{
  "success": true,
  "message": "Orders fetched successfully",
  "data": {
    "orders": [ ... ]
  },
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 45,
    "pages": 5
  }
}
```

### 3. Get Single Order
**GET** `/orders/:id`  
🔒 Protected

**Response (200):**
```json
{
  "success": true,
  "message": "Order fetched successfully",
  "data": {
    "order": {
      "_id": "64f456...",
      "orderNumber": "RLX17065432100001",
      "customer": {
        "_id": "64f123...",
        "name": "John Doe",
        "phone": "08012345678"
      },
      "status": "washing",
      "statusHistory": [
        {
          "status": "pending",
          "timestamp": "2024-01-01T10:00:00Z",
          "updatedBy": { ... }
        }
      ],
      ...
    }
  }
}
```

### 4. Update Order Status
**PUT** `/orders/:id/status`  
🔒 Protected (Staff/Admin)

**Request Body:**
```json
{
  "status": "washing",
  "notes": "Items in washing machine"
}
```

### 5. Assign Staff to Order
**PUT** `/orders/:id/assign`  
🔒 Protected (Admin)

**Request Body:**
```json
{
  "staffId": "64f789..."
}
```

### 6. Update Payment Status
**PUT** `/orders/:id/payment`  
🔒 Protected (Staff/Admin)

**Request Body:**
```json
{
  "status": "paid",
  "method": "pos",
  "transactionId": "TXN123456"
}
```

### 7. Cancel Order
**PUT** `/orders/:id/cancel`  
🔒 Protected

**Request Body:**
```json
{
  "reason": "Customer requested cancellation"
}
```

---

## 👨‍💼 User Management Endpoints

### 1. Get All Users
**GET** `/users`  
🔒 Protected (Admin/Manager)

**Query Parameters:**
- `page`, `limit`: Pagination
- `role`: Filter by role
- `search`: Search by name, phone, or email
- `isActive`: Filter by active status

### 2. Get Single User
**GET** `/users/:id`  
🔒 Protected (Admin/Manager)

### 3. Create Staff
**POST** `/users/staff`  
🔒 Protected (Admin/Manager)

**Request Body:**
```json
{
  "name": "Jane Smith",
  "phone": "08087654321",
  "email": "jane@relux.com",
  "password": "staff123",
  "staffRole": "receptionist"
}
```

### 4. Update User
**PUT** `/users/:id`  
🔒 Protected (Admin/Manager)

**Request Body:**
```json
{
  "name": "Jane Updated",
  "staffRole": "washer",
  "isActive": true
}
```

### 5. Deactivate User
**PUT** `/users/:id/deactivate`  
🔒 Protected (Admin/Manager)

### 6. Delete User
**DELETE** `/users/:id`  
🔒 Protected (Admin/Manager)

---

## 📊 Admin Dashboard Endpoints

### 1. Get Dashboard Stats
**GET** `/admin/dashboard`  
🔒 Protected (Admin/Manager)

**Response (200):**
```json
{
  "success": true,
  "message": "Dashboard stats fetched successfully",
  "data": {
    "today": {
      "orders": 15,
      "revenue": 45000,
      "pending": 5,
      "completed": 10
    },
    "weekly": {
      "orders": 89,
      "revenue": 267000
    },
    "monthly": {
      "orders": 356,
      "revenue": 1068000
    },
    "totalCustomers": 150,
    "activeStaff": 8,
    "recentOrders": [ ... ],
    "topServices": [
      {
        "_id": "wash-iron",
        "count": 120,
        "revenue": 360000
      }
    ]
  }
}
```

### 2. Get Revenue Report
**GET** `/admin/reports/revenue`  
🔒 Protected (Admin/Manager)

**Query Parameters:**
- `startDate`: Start date (ISO format)
- `endDate`: End date (ISO format)
- `groupBy`: day | week | month | year

**Example:**
```
GET /admin/reports/revenue?startDate=2024-01-01&endDate=2024-01-31&groupBy=day
```

### 3. Get Order Statistics
**GET** `/admin/stats/orders`  
🔒 Protected (Admin/Manager)

**Response (200):**
```json
{
  "success": true,
  "message": "Order statistics fetched successfully",
  "data": {
    "ordersByStatus": [
      { "_id": "completed", "count": 120 },
      { "_id": "pending", "count": 45 }
    ],
    "ordersByService": [
      { "_id": "wash-iron", "count": 150 },
      { "_id": "wash-fold", "count": 80 }
    ],
    "ordersByType": [
      { "_id": "pickup-delivery", "count": 180 },
      { "_id": "walk-in", "count": 50 }
    ],
    "paymentMethods": [
      { "_id": "cash", "count": 120 },
      { "_id": "pos", "count": 80 }
    ]
  }
}
```

---

## 🔐 Roles & Permissions

### Roles
- **customer**: Regular customers
- **staff**: General staff members
  - **receptionist**: Front desk operations
  - **washer**: Laundry operations
  - **delivery**: Delivery operations
- **manager**: Store managers
- **admin**: System administrators

---

## 📊 Order Status Flow

```
pending → confirmed → picked-up → washing → 
ironing → ready → out-for-delivery → delivered → completed
```

Status can also be set to `cancelled` at any point.

---

## ⚡ Rate Limits

- **General API**: 100 requests / 15 minutes
- **Auth Endpoints**: 5 attempts / 15 minutes
- **Order Creation**: 10 requests / hour

---

## 🚨 Error Responses

**400 Bad Request:**
```json
{
  "success": false,
  "message": "Validation error message"
}
```

**401 Unauthorized:**
```json
{
  "success": false,
  "message": "Not authorized to access this route"
}
```

**404 Not Found:**
```json
{
  "success": false,
  "message": "Resource not found"
}
```

**500 Server Error:**
```json
{
  "success": false,
  "message": "Server Error"
}
```

---

## 🔌 WebSocket Events

Connect to Socket.IO for real-time updates:

```javascript
const socket = io('http://localhost:5000');

// Join order room
socket.emit('join-order', orderId);

// Listen for order updates
socket.on('order-status-updated', (data) => {
  console.log('Order updated:', data);
});
```

---

For more information, see the complete README.md file. -->
