require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const authRoutes = require('./routes/authRoutes');
const eventRoutes = require('./routes/eventRoutes');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());
app.use('/auth', authRoutes);
app.use('/events', eventRoutes);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Test route
app.get('/', (req, res) => {
    res.send('Server is running');
});

module.exports = app;
