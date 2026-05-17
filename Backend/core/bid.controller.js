const pool = require('../../database/pg.database');

// POST /bid/:item_id  (butuh auth) — place a bid
const placeBid = async (req, res) => {
  const { item_id } = req.params;
  const { price } = req.body;
  const user_id = req.user.id;

  if (!price || price <= 0) {
    return res.status(400).json({ message: 'price must be a positive number' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Cek item ada dan masih aktif — LOCK baris ini agar concurrent bid aman
    const itemResult = await client.query(
      `SELECT * FROM items WHERE item_id = $1 FOR UPDATE`,
      [item_id]
    );

    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Item not found' });
    }

    const item = itemResult.rows[0];

    if (item.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Auction is already closed' });
    }

    if (new Date(item.end_time) <= new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Auction has ended' });
    }

    // Seller tidak bisa bid barangnya sendiri
    if (item.seller_id === user_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'You cannot bid on your own item' });
    }

    // 2. Cari highest bid saat ini
    const highestBidResult = await client.query(
      `SELECT b.price, b.user_id FROM bid b
       WHERE b.item_id = $1
       ORDER BY b.price DESC, b.created_at ASC
       LIMIT 1`,
      [item_id]
    );

    const currentHighest = highestBidResult.rows[0];
    const currentPrice = currentHighest ? currentHighest.price : item.base_price;

    // 3. Validasi bid harus lebih besar
    if (price <= currentPrice) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Bid must be higher than current price (${currentPrice})`,
        current_price: currentPrice,
      });
    }

    // 4. Cek balance user — harus punya available_balance >= price
    const userResult = await client.query(
      `SELECT id, balance, held_balance FROM users WHERE id = $1 FOR UPDATE`,
      [user_id]
    );
    const user = userResult.rows[0];
    const availableBalance = user.balance - user.held_balance;

    if (availableBalance < price) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'Insufficient balance',
        available_balance: availableBalance,
        required: price,
      });
    }

    // 5. Cari bid tertinggi user sebelumnya di item ini (untuk hold delta)
    const prevUserBidResult = await client.query(
      `SELECT price FROM bid
       WHERE item_id = $1 AND user_id = $2
       ORDER BY price DESC LIMIT 1`,
      [item_id, user_id]
    );
    const prevUserHighest = prevUserBidResult.rows[0] ? prevUserBidResult.rows[0].price : 0;

    // 6. Hold selisih (bukan hold ulang dari 0 — hanya tambahkan delta)
    //    Kalau user belum pernah bid di item ini: hold = price
    //    Kalau user sudah bid sebelumnya: hold += (price - prevUserHighest)
    const holdDelta = price - prevUserHighest;

    await client.query(
      `UPDATE users SET held_balance = held_balance + $1 WHERE id = $2`,
      [holdDelta, user_id]
    );

    // 7. Release held_balance highest bidder lama (jika bukan user yang sama)
    if (currentHighest && currentHighest.user_id !== user_id) {
      await client.query(
        `UPDATE users
         SET held_balance = GREATEST(held_balance - $1, 0)
         WHERE id = $2`,
        [currentHighest.price, currentHighest.user_id]
      );
    }

    // 8. Insert bid baru
    const bidResult = await client.query(
      `INSERT INTO bid (item_id, user_id, price)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [item_id, user_id, price]
    );

    // 9. Update array bids di items dan users
    await client.query(
      `UPDATE items SET bids = array_append(bids, $1::uuid) WHERE item_id = $2`,
      [bidResult.rows[0].bid_id, item_id]
    );
    await client.query(
      `UPDATE users SET bids = array_append(bids, $1::uuid) WHERE id = $2`,
      [bidResult.rows[0].bid_id, user_id]
    );

    await client.query('COMMIT');

    // Ambil balance terbaru untuk dikembalikan ke client
    const updatedUser = await pool.query(
      `SELECT balance, held_balance FROM users WHERE id = $1`,
      [user_id]
    );

    return res.status(201).json({
      message: 'Bid placed successfully',
      bid: bidResult.rows[0],
      balance: updatedUser.rows[0].balance,
      held_balance: updatedUser.rows[0].held_balance,
      available_balance: updatedUser.rows[0].balance - updatedUser.rows[0].held_balance,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('placeBid error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
};

// GET /bid/:item_id — riwayat bid sebuah item (public)
const getBidsByItem = async (req, res) => {
  const { item_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT b.bid_id, b.price, b.created_at,
              u.username, u.profile_picture_url
       FROM bid b
       JOIN users u ON u.id = b.user_id
       WHERE b.item_id = $1
       ORDER BY b.price DESC, b.created_at ASC`,
      [item_id]
    );

    return res.status(200).json({ bids: result.rows });
  } catch (err) {
    console.error('getBidsByItem error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /bid/user/my — semua bid yang dilakukan user sendiri (butuh auth)
const getMyBids = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.bid_id, b.price, b.created_at,
              i.item_id, i.item_name, i.item_picture_url,
              i.status, i.end_time,
              COALESCE(
                (SELECT MAX(b2.price) FROM bid b2 WHERE b2.item_id = i.item_id),
                i.base_price
              ) AS current_price,
              (b.price = (
                SELECT MAX(b3.price) FROM bid b3 WHERE b3.item_id = i.item_id
              )) AS is_winning
       FROM bid b
       JOIN items i ON i.item_id = b.item_id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );

    return res.status(200).json({ bids: result.rows });
  } catch (err) {
    console.error('getMyBids error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { placeBid, getBidsByItem, getMyBids };
