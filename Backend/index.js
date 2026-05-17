const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000'
}));
app.use(express.json());

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use('/user', require('./core/user/user.route'));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});