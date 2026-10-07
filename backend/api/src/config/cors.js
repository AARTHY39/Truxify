const dotenv = require('dotenv');
dotenv.config();

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  process.env.CUSTOMER_WEB_ORIGIN || 'https://truxify.app',
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser clients (Postman, mobile apps, curl) where origin is undefined
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS security policy'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  credentials: true,
  maxAge: 86400, // Cache preflight OPTIONS for 24 hours
};

module.exports = corsOptions;
