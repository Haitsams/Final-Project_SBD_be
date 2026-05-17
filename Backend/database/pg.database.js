require("dotenv").config();

const { text } = require("express");
const { Pool } = require("pg");

const pool = new Pool ({
    connectionString: process.env.PG_CONNECTION_STRING,
    ssl: {
        rejectUnauthorized: false,
    }
});

const connect = async () => {
    try {
        await pool.connect();
        console.log("connected to the database");
    } catch (error) {
        console.error("Error connecting to the database", error);
    }
};

connect();

const query = async (text, params) => {
    try {
        const res = await pool.query(text, params);
        return res;
    } catch (error) {
        console.error("Error executing query", error);
        throw error;
    }
};

module.exports = {
    query,
};