const express = require('express');
const orderController = require('../controllers/orderController');
const { authenticateToken, requireBuyer } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/', authenticateToken, requireBuyer, orderController.createOrder);
router.post('/:id/pay', authenticateToken, requireBuyer, orderController.simulatePayment);

module.exports = router;