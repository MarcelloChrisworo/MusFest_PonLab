const jwt = require('jsonwebtoken');

exports.authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Login token required' });
    }
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};

exports.requireOrganizer = (req, res, next) => {
    if (req.user.role !== 'organizer') {
        return res.status(403).json({ error: 'Organizer account required' });
    }
    next();
};
exports.requireBuyer = (req, res, next) => {
    if (req.user.role !== 'buyer') {
        return res.status(403).json({ error: 'Buyer account required' });
    }

    next();
};