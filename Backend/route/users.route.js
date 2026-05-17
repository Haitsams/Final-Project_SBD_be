const express = require('express');
const router = express.Router();
const { register, login, getProfile, updateProfile, topUp } = require('./users.controller');
const authMiddleware = require('../../middleware/auth.middleware');
const { uploadImage } = require('../../utils/cloudinary');

// Public
router.post('/register', register);
router.post('/login', login);

// Protected
router.get('/profile', authMiddleware, getProfile);
router.put('/profile', authMiddleware, uploadImage.single('profile_picture'), updateProfile);
router.post('/topup', authMiddleware, topUp);

module.exports = router;
