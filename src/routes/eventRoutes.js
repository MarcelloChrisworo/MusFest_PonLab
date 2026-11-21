const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const { authenticateToken, requireOrganizer } = require('../middleware/authMiddleware');

router.get('/', eventController.listEvents);
router.post('/', authenticateToken, requireOrganizer, eventController.createEvent);


module.exports = router;