const express = require('express');
const router = express.Router();
const {
  createItem,
  getAllItems,
  getActiveItems,
  getItemById,
  getMyItems,
} = require('./items.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const { uploadImage } = require('../../utils/cloudinary');

// Public
router.get('/', getAllItems);
router.get('/active', getActiveItems);
router.get('/:item_id', getItemById);

// Protected
router.post('/', authMiddleware, uploadImage.single('item_picture'), createItem);
router.get('/user/my', authMiddleware, getMyItems);

module.exports = router;
