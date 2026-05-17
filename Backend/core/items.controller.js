const pool = require('../../database/pg.database');

// POST /item  (butuh auth) — buat lelang baru
const createItem = async (req, res) => {
  const { item_name, total_item, base_price, item_information, end_time, category } = req.body;
  const item_picture_url = req.file ? req.file.path : null;

  if (!item_name || !base_price || !end_time || !item_picture_url) {
    return res.status(400).json({
      message: 'item_name, base_price, end_time, and item_picture are required',
    });
  }

  // Validasi end_time harus di masa depan
  if (new Date(end_time) <= new Date()) {
    return res.status(400).json({ message: 'end_time must be in the future' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO items
        (seller_id, item_name, total_item, base_price, item_information, item_picture_url, end_time, category)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        req.user.id,
        item_name,
        total_item || 1,
        base_price,
        item_information || null,
        item_picture_url,
        end_time,
        category || null,
      ]
    );

    return res.status(201).json({ message: 'Auction created', item: result.rows[0] });
  } catch (err) {
    console.error('createItem error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /item  — semua lelang aktif
const getAllItems = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         i.*,
         u.username AS seller_username,
         u.profile_picture_url AS seller_picture,
         COALESCE(
           (SELECT MAX(b.price) FROM bid b WHERE b.item_id = i.item_id),
           i.base_price
         ) AS current_price,
         (SELECT COUNT(*) FROM bid b WHERE b.item_id = i.item_id) AS bid_count
       FROM items i
       JOIN users u ON u.id = i.seller_id
       ORDER BY i.created_at DESC`
    );

    return res.status(200).json({ items: result.rows });
  } catch (err) {
    console.error('getAllItems error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /item/active — hanya yang masih aktif
const getActiveItems = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         i.*,
         u.username AS seller_username,
         COALESCE(
           (SELECT MAX(b.price) FROM bid b WHERE b.item_id = i.item_id),
           i.base_price
         ) AS current_price,
         (SELECT COUNT(*) FROM bid b WHERE b.item_id = i.item_id) AS bid_count
       FROM items i
       JOIN users u ON u.id = i.seller_id
       WHERE i.status = 'active' AND i.end_time > NOW()
       ORDER BY i.end_time ASC`
    );

    return res.status(200).json({ items: result.rows });
  } catch (err) {
    console.error('getActiveItems error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /item/:item_id — detail satu item + riwayat bid
const getItemById = async (req, res) => {
  const { item_id } = req.params;

  try {
    const itemResult = await pool.query(
      `SELECT
         i.*,
         u.username AS seller_username,
         u.profile_picture_url AS seller_picture,
         COALESCE(
           (SELECT MAX(b.price) FROM bid b WHERE b.item_id = i.item_id),
           i.base_price
         ) AS current_price,
         (SELECT COUNT(*) FROM bid b WHERE b.item_id = i.item_id) AS bid_count
       FROM items i
       JOIN users u ON u.id = i.seller_id
       WHERE i.item_id = $1`,
      [item_id]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ message: 'Item not found' });
    }

    // Ambil riwayat bid (tertinggi dulu)
    const bidsResult = await pool.query(
      `SELECT b.bid_id, b.price, b.created_at, u.username, u.profile_picture_url
       FROM bid b
       JOIN users u ON u.id = b.user_id
       WHERE b.item_id = $1
       ORDER BY b.price DESC, b.created_at ASC`,
      [item_id]
    );

    return res.status(200).json({
      item: itemResult.rows[0],
      bids: bidsResult.rows,
    });
  } catch (err) {
    console.error('getItemById error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /item/my — semua lelang yang dibuat user sendiri (butuh auth)
const getMyItems = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         i.*,
         COALESCE(
           (SELECT MAX(b.price) FROM bid b WHERE b.item_id = i.item_id),
           i.base_price
         ) AS current_price,
         (SELECT COUNT(*) FROM bid b WHERE b.item_id = i.item_id) AS bid_count
       FROM items i
       WHERE i.seller_id = $1
       ORDER BY i.created_at DESC`,
      [req.user.id]
    );

    return res.status(200).json({ items: result.rows });
  } catch (err) {
    console.error('getMyItems error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Fungsi internal — dipanggil oleh cron job
// Menutup semua auction yang sudah melewati end_time
const closeExpiredAuctions = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ambil semua item yang expired tapi masih active
    const expired = await client.query(
      `SELECT item_id FROM items
       WHERE status = 'active' AND end_time <= NOW()
       FOR UPDATE`
    );

    for (const row of expired.rows) {
      const { item_id } = row;

      // Cari highest bidder
      const topBid = await client.query(
        `SELECT b.bid_id, b.user_id, b.price
         FROM bid b
         WHERE b.item_id = $1
         ORDER BY b.price DESC, b.created_at ASC
         LIMIT 1`,
        [item_id]
      );

      if (topBid.rows.length > 0) {
        const winner = topBid.rows[0];

        // Set final_price dan status closed
        await client.query(
          `UPDATE items SET status = 'closed', final_price = $1 WHERE item_id = $2`,
          [winner.price, item_id]
        );

        // Deduct balance pemenang (kurangi balance + held_balance sekaligus)
        await client.query(
          `UPDATE users
           SET balance      = balance - $1,
               held_balance = held_balance - $1
           WHERE id = $2`,
          [winner.price, winner.user_id]
        );

        // Release held_balance semua bidder lain di item ini
        const losers = await client.query(
          `SELECT DISTINCT user_id FROM bid
           WHERE item_id = $1 AND user_id != $2`,
          [item_id, winner.user_id]
        );

        for (const loser of losers.rows) {
          // Cari bid tertinggi loser di item ini untuk direlease
          const loserTopBid = await client.query(
            `SELECT price FROM bid
             WHERE item_id = $1 AND user_id = $2
             ORDER BY price DESC LIMIT 1`,
            [item_id, loser.user_id]
          );

          if (loserTopBid.rows.length > 0) {
            await client.query(
              `UPDATE users
               SET held_balance = GREATEST(held_balance - $1, 0)
               WHERE id = $2`,
              [loserTopBid.rows[0].price, loser.user_id]
            );
          }
        }
      } else {
        // Tidak ada bidder — tutup saja
        await client.query(
          `UPDATE items SET status = 'closed' WHERE item_id = $1`,
          [item_id]
        );
      }
    }

    await client.query('COMMIT');

    if (expired.rows.length > 0) {
      console.log(`[CRON] Closed ${expired.rows.length} expired auction(s)`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CRON] closeExpiredAuctions error:', err);
  } finally {
    client.release();
  }
};

// GET /item/search — search dan filter items aktif
const getFilteredItems = async (req, res) => {
  const { search, category } = req.query;

  try {
    const conditions = [`i.status = 'active'`, `i.end_time > NOW()`];
    const values = [];
    let idx = 1;

    if (search) {
      conditions.push(`(i.item_name ILIKE $${idx} OR i.item_information ILIKE $${idx})`);
      values.push(`%${search}%`);
      idx++;
    }

    if (category) {
      conditions.push(`i.category ILIKE $${idx}`);
      values.push(category);
      idx++;
    }

    const whereClause = conditions.join(' AND ');

    const result = await pool.query(
      `SELECT
         i.*,
         u.username AS seller_username,
         u.profile_picture_url AS seller_picture,
         COALESCE(
           (SELECT MAX(b.price) FROM bid b WHERE b.item_id = i.item_id),
           i.base_price
         ) AS current_price,
         (SELECT COUNT(*) FROM bid b WHERE b.item_id = i.item_id) AS bid_count
       FROM items i
       JOIN users u ON u.id = i.seller_id
       WHERE ${whereClause}
       ORDER BY i.end_time ASC`,
      values
    );

    return res.status(200).json({ items: result.rows });
  } catch (err) {
    console.error('getFilteredItems error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { createItem, getAllItems, getActiveItems, getItemById, getMyItems, closeExpiredAuctions, getFilteredItems };
