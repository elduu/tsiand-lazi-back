// bot.js - Wedding Photo Bot + Node.js server
require("dotenv").config();
const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const fetch = require("node-fetch"); // ensure you have node-fetch installed

// =========================
// Config
// =========================
const BOT_TOKEN = process.env.BOT_TOKEN || '8496563288:AAFilcA-eA5Ge5JQzILRMSu2NNJQ5BiZNTQ';
const PORT = 5000;

// MySQL Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "68.183.172.126",
  user: process.env.DB_USER || "yilma",
  password: process.env.DB_PASSWORD || "Redu@123",
  database: process.env.DB_NAME || "wedding_db",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
  queueLimit: 0,
});

// Express
const app = express();
const allowedOrigins = [
  "https://weddingapi.newblossomequb.net",
  "http://localhost:5173",
  "https://wedding.newblossomequb.net"
];

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = `The CORS policy for this site does not allow access from the specified Origin.`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// Uploads folder
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// =========================
// Database Initialization
// =========================
async function initDatabase() {
  try {
    // RSVPs table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS rsvps (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        attending BOOLEAN DEFAULT NULL,
        wish TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Wedding photos table (avoid duplicate file_ids)
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS wedding_photos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_id VARCHAR(255) NOT NULL UNIQUE,
        file_path VARCHAR(512) NOT NULL,
        sender VARCHAR(255),
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("Database tables verified / created successfully");
  } catch (err) {
    console.error("Database initialization failed:", err.message);
    process.exit(1);
  }
}

// Test DB connection
async function testDbConnection() {
  try {
    const conn = await pool.getConnection();
    console.log("MySQL Connected Successfully");
    conn.release();
  } catch (err) {
    console.error("MySQL Connection Failed:", err.message);
    process.exit(1);
  }
}

// =========================
// Express Routes
// =========================
app.get("/", (req, res) => {
  res.send("Wedding Server is running – RSVP & Photos Ready!");
});

// POST RSVP
app.post("/rsvp", async (req, res) => {
  const { name, attending, wish } = req.body;

  if (!name || !wish) {
    return res.status(400).json({ message: "Name and wish are required" });
  }

  // Convert attending to boolean
  const attendingValue =
    attending === "yes" ? 1 :
    attending === "no" ? 0 :
    null;

  try {
    await pool.execute(
      "INSERT INTO rsvps (name, attending, wish) VALUES (?, ?, ?)",
      [name, attendingValue, wish]
    );

    res.json({ message: "RSVP submitted successfully!" });
  } catch (err) {
    console.error("RSVP DB ERROR:", err);
    res.status(500).json({
      message: "Database error",
      error: err.message
    });
  }
});


// GET RSVPs
app.get("/rsvp", async (req, res) => {
  try {
    const [results] = await pool.execute(
      "SELECT name, wish FROM rsvps ORDER BY created_at DESC"
    );
    res.json(results);
  } catch (err) {
    console.error("Fetch RSVPs Error:", err);
    res.status(500).json({ message: "Database error" });
  }
});

// Serve uploaded photos
app.use("/uploads", express.static(uploadsDir));

// GET wedding photos
app.get("/api/wedding-photos", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT file_path, sender, timestamp FROM wedding_photos ORDER BY timestamp DESC"
    );

    const baseUrl = `https://${req.get("host")}`;


    const photos = rows.map(row => ({
      url: `${baseUrl}${row.file_path}`,
      sender: row.sender,
      timestamp: row.timestamp
    }));

    res.json(photos);
  } catch (err) {
    console.error("DB Error fetching photos:", err);
    res.status(500).json({ error: "Failed to load photos" });
  }

});
// =========================
// Telegram Bot
// =========================
const bot = new Telegraf(BOT_TOKEN);

// Track processed media groups to avoid duplicates
const processedGroups = new Set();

// Bot commands
bot.start((ctx) =>
  ctx.reply(
    "🎉 Welcome to Our Wedding Photo Bot! 📸\n\nSend your beautiful moments from the wedding day, and they'll appear instantly on our live photo gallery! 💕"
  )
);

bot.on("photo", async (ctx) => {
  try {
    const message = ctx.message;
    const photos = message.photo;
    const sender = message.from.username || message.from.first_name || "Guest";
    const mediaGroupId = message.media_group_id;

    // Skip duplicate albums
    if (mediaGroupId && processedGroups.has(mediaGroupId)) return;
    if (mediaGroupId) processedGroups.add(mediaGroupId);

    const photo = photos[photos.length - 1]; // highest resolution
    const fileId = photo.file_id;

    // Download file
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error("Download failed");

    const buffer = await response.arrayBuffer();
    const fileName = `${fileId}.jpg`;
    const filePath = path.join(uploadsDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(buffer));

    const webPath = `/uploads/${fileName}`;

    // Insert photo, ignore duplicates
    await pool.execute(
      "INSERT IGNORE INTO wedding_photos (file_id, file_path, sender) VALUES (?, ?, ?)",
      [fileId, webPath, sender]
    );

    // Auto-clear media group tracker
    if (mediaGroupId) setTimeout(() => processedGroups.delete(mediaGroupId), 10000);

   
    await ctx.replyWithHTML(
      `✨ Thank you <b>${sender}</b>! Your  photos are now live on the wedding website! ❤️`
    );
  } catch (err) {
    console.error("Photo save error:", err);
    if (!ctx.message.media_group_id || !processedGroups.has(ctx.message.media_group_id)) {
      await ctx.reply("❌ Sorry, something went wrong saving your photo(s). Please try again.");
    }
  }
});

// =========================
// Launch
// =========================
async function startServerAndBot() {
  await testDbConnection();
  await initDatabase();

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  await bot.launch();
  console.log("🤵👰 Wedding Photo Bot is LIVE!");
}

startServerAndBot();

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

module.exports = { startBot: async () => bot.launch(), stopBot: (signal) => bot.stop(signal) };
