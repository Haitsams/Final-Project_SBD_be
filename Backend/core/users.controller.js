const pool = require('../../database/pg.database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// POST /user/register
const register = async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'username, email, and password are required' });
  }

  try {
    // Cek duplikat
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: 'Email or username already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (username, email, password)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, balance, held_balance`,
      [username, email, hashedPassword]
    );

    return res.status(201).json({ message: 'User registered successfully', user: result.rows[0] });
  } catch (err) {
    console.error('register error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /user/login
const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'email and password are required' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: user.balance,
        held_balance: user.held_balance,
        profile_picture_url: user.profile_picture_url,
      },
    });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /user/profile  (butuh auth)
const getProfile = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, profile_picture_url, balance, held_balance, bids
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.status(200).json({ user: result.rows[0] });
  } catch (err) {
    console.error('getProfile error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// PUT /user/profile  (butuh auth) — update username / profile picture
const updateProfile = async (req, res) => {
  const { username } = req.body;
  const profile_picture_url = req.file ? req.file.path : null; // dari cloudinary via multer

  try {
    const fields = [];
    const values = [];
    let idx = 1;

    if (username) {
      fields.push(`username = $${idx++}`);
      values.push(username);
    }
    if (profile_picture_url) {
      fields.push(`profile_picture_url = $${idx++}`);
      values.push(profile_picture_url);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    values.push(req.user.id);
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, username, email, profile_picture_url, balance, held_balance`,
      values
    );

    return res.status(200).json({ message: 'Profile updated', user: result.rows[0] });
  } catch (err) {
    console.error('updateProfile error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /user/topup  (butuh auth)
const topUp = async (req, res) => {
  const { amount } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ message: 'amount must be a positive number' });
  }

  try {
    const result = await pool.query(
      `UPDATE users SET balance = balance + $1 WHERE id = $2
       RETURNING id, username, balance, held_balance`,
      [amount, req.user.id]
    );

    return res.status(200).json({ message: 'Top up successful', user: result.rows[0] });
  } catch (err) {
    console.error('topUp error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { register, login, getProfile, updateProfile, topUp };
