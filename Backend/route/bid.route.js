const express = require('express');
const router = express.Router();
const { placeBid, getBidsByItem, getMyBids } = require('./bid.controller');
const authMiddleware = require('../../middleware/auth.middleware');

// Public
router.get('/:item_id', getBidsByItem);

// Protected
router.post('/:item_id', authMiddleware, placeBid);
router.get('/user/my', authMiddleware, getMyBids);

module.exports = router;
