# 🚀 Quick Start Guide - Relux Laundry Backend (JavaScript)

Get your backend running in 5 minutes!

## ⚡ Quick Setup

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Configure Environment
```bash
# Copy environment file
cp .env.example .env

# Edit .env - REQUIRED changes:
# - MONGODB_URI (your MongoDB connection)
# - JWT_SECRET (change to random secret)
```

### Step 3: Start MongoDB
```bash
# Ubuntu/Linux
sudo systemctl start mongod

# macOS
brew services start mongodb-community

# Docker
docker run -d -p 27017:27017 mongo:latest
```

### Step 4: Seed Database (Optional)
```bash
npm run seed -- -i
```

This creates sample users:
- Admin: `08011111111` / `admin123`
- Customer: `08066666666` / `customer123`
- Staff accounts with various roles

### Step 5: Start the Server
```bash
# Development mode (hot reload)
npm run dev

# Production with load balancing (PM2)
npm run start:cluster
```

## ✅ Test It's Working

```bash
# Health check
curl http://localhost:5000/health

# Login
curl -X POST http://localhost:5000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phone":"08066666666","password":"customer123"}'
```

## 📡 API Base URL

```
http://localhost:5000/api/v1
```

## 🎯 What's Next?

1. **Test the API** - Use Postman or curl
2. **Build Frontend** - React dashboard + web app
3. **Add Payments** - Integrate Paystack/Flutterwave
4. **Deploy** - VPS, MongoDB Atlas, PM2

## 📚 Documentation

- **README.md** - Complete documentation
- **API_DOCS.md** - All API endpoints

## 🆘 Issues?

- **Can't connect to MongoDB**: `sudo systemctl start mongod`
- **Port in use**: `lsof -i :5000` then `kill -9 <PID>`
- **PM2 issues**: `pm2 delete all` then restart

---

**You're all set!** Your backend is running with load balancing, rate limiting, and security best practices! 🎉
