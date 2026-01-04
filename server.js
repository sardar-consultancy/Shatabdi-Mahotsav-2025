// server.js - COMPLETE FIXED VERSION WITH 3RD MESSAGE
const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const http = require("http");
const socketIO = require("socket.io");
const bodyParser = require("body-parser");
const cors = require("cors");
const qrcode = require("qrcode");
const mysql = require("mysql2/promise");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { createCanvas, loadImage } = require("canvas");
const JsBarcode = require("jsbarcode");
const fs = require("fs").promises;
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Multer setup for handling multipart/form-data
const upload = multer({
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  storage: multer.memoryStorage(),
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));
app.use(cors());

// Session middleware
app.use(
  session({
    secret: "satabdi-mahotsav-secret-key-2025",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }, // 24 hours
  })
);

// Database configuration
const dbConfig = {
  host: "localhost",
  user: "root",
  password: "",
  database: "satabdi_mahotsav",
};

// Create connection pool
const dbPool = mysql.createPool(dbConfig);

// Initialize database tables
async function initializeDatabase() {
  let connection;
  try {
    connection = await dbPool.getConnection();

    // First, check if database exists
    try {
      await connection.query(`USE ${dbConfig.database}`);
    } catch (error) {
      console.log(`Database ${dbConfig.database} doesn't exist. Creating...`);
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS ${dbConfig.database}`
      );
      await connection.query(`USE ${dbConfig.database}`);
    }

    // Configuration table
    await connection.execute(`
            CREATE TABLE IF NOT EXISTS whatsapp_configuration (
                id INT AUTO_INCREMENT PRIMARY KEY,
                selected_groups JSON,
                admin_numbers JSON,
                registration_message TEXT,
                barcode_template_path VARCHAR(500),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

    // Sent messages log table
    await connection.execute(`
            CREATE TABLE IF NOT EXISTS sent_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                message_text TEXT,
                media_url VARCHAR(500),
                recipients JSON,
                recipient_type ENUM('groups', 'all_registrations', 'custom'),
                status VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

    // Message templates table
    await connection.execute(`
            CREATE TABLE IF NOT EXISTS message_templates (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                template_type ENUM('registration_confirmation', 'admin_notification', 'barcode_message', 'change_request') NOT NULL,
                message_text TEXT NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

    // Registration sync table
    await connection.execute(`
            CREATE TABLE IF NOT EXISTS registration_sync (
                id INT AUTO_INCREMENT PRIMARY KEY,
                registration_id BIGINT NOT NULL UNIQUE,
                registration_no VARCHAR(20) NOT NULL,
                name VARCHAR(150) NOT NULL,
                mobile VARCHAR(15) NOT NULL,
                village VARCHAR(150) NOT NULL,
                state VARCHAR(100) NOT NULL,
                position VARCHAR(50) NOT NULL,
                age INT NOT NULL,
                gender ENUM('male','female') NOT NULL,
                male_members INT DEFAULT 0,
                female_members INT DEFAULT 0,
                child_members INT DEFAULT 0,
                total_members INT NOT NULL,
                connected ENUM('yes','no') NOT NULL,
                message TEXT,
                user_message_sent BOOLEAN DEFAULT FALSE,
                admin_notification_sent BOOLEAN DEFAULT FALSE,
                barcode_sent BOOLEAN DEFAULT FALSE,
                change_request_sent BOOLEAN DEFAULT FALSE,
                user_sent_at TIMESTAMP NULL,
                admin_sent_at TIMESTAMP NULL,
                barcode_sent_at TIMESTAMP NULL,
                change_request_sent_at TIMESTAMP NULL,
                retry_count INT DEFAULT 0,
                barcode_retry_count INT DEFAULT 0,
                change_request_retry_count INT DEFAULT 0,
                last_attempt TIMESTAMP NULL,
                barcode_last_attempt TIMESTAMP NULL,
                change_request_last_attempt TIMESTAMP NULL,
                is_processing BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX (mobile),
                INDEX (created_at)
            )
        `);

    // Admin users table
    await connection.execute(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role ENUM('super_admin', 'admin') DEFAULT 'admin',
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

    // Create default super admin
    const [existingAdmin] = await connection.execute(
      "SELECT * FROM admin_users WHERE username = ?",
      ["admin"]
    );
    if (existingAdmin.length === 0) {
      const passwordHash = await bcrypt.hash("H33t@6147", 10);
      await connection.execute(
        "INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)",
        ["admin", passwordHash, "super_admin"]
      );
      console.log("Default super admin created");
    }

    // Insert 4 default templates (Hindi Version)
    const defaultTemplates = [
      {
        name: "Registration Confirmation",
        template_type: "registration_confirmation",
        message_text: `🎉 *शताब्दी महोत्सव पंजीकरण सफल*  

नमस्ते {name} जी! 🙏🏻  

आपका *शताब्दी महोत्सव* हेतु पंजीकरण सफलतापूर्वक पूर्ण हो गया है।  

📋 *पंजीकरण विवरण:*  
• पंजीकरण क्रमांक: {registration_no}  
• नाम: {name}  
• गाँव/शहर: {village} - {state}  
• मोबाइल नंबर: {mobile}  
• पद: {position}  
• आयु: {age}  
• लिंग: {gender}  
• कुल सदस्य: {total_members}  

📍 *स्थान:* सर्किट हाउस, जामनगर रोड, टंकारा, गुजरात  
📅 *तिथि:* 12 से 13 फरवरी 2026  
⏰ *समय:* प्रातः 6:00 बजे से रात्रि 10:00 बजे तक  

✨ *कार्यक्रम के विशेष आकर्षण:*  
• वैदिक यज्ञ एवं योग  
• वैदिक प्रवचन  
• भजन संध्या  
• सामूहिक भोजन  

🏛️ *वैदिक प्रदर्शनी:*  
• सृष्टि उत्पत्ति से आज तक  
• महर्षि दयानंद सरस्वती का जीवन दर्शन  
• पंचमहायज्ञ एवं 16 (सोलह) संस्कार   

🌿 _शताब्दी महोत्सव में सहभागी बनने हेतु आपका हार्दिक धन्यवाद!_  
~ *शताब्दी महोत्सव समिति*`,
      },
      {
        name: "Admin Notification",
        template_type: "admin_notification",
        message_text: `🔔 *नया शताब्दी महोत्सव पंजीकरण प्राप्त हुआ!*  

📝 *पंजीकरण विवरण:*  
• पंजीकरण क्रमांक: {registration_no} 
• नाम: {name} 
• गाँव/शहर: {village} - {state} 
• मोबाइल नंबर: {mobile} 
• पद: {position}
• आयु: {age}
• लिंग: {gender}
• पुरुष सदस्य: {male_members}
• महिला सदस्य: {female_members}
• बाल सदस्य: {child_members}
• कुल सदस्य: {total_members}
• संपर्क स्थापित: {connected}

📊 *कुल पंजीकरण:* {total_registrations}  
🎯 *आज के पंजीकरण:* {today_registrations}  

🌿 _शताब्दी महोत्सव की व्यवस्थाओं हेतु कृपया आवश्यक कार्यवाही करें।_  
~ *शताब्दी महोत्सव सिस्टम | By - TechVatika*`,
      },
      {
        name: "Barcode Message",
        template_type: "barcode_message",
        message_text: `🏠 *शताब्दी महोत्सव – आवास सुविधा पास*  

नमस्ते {name} जी! 🙏🏻  

आपके लिए *शताब्दी महोत्सव* हेतु *आवास सुविधा पास* सफलतापूर्वक जारी कर दिया गया है।  
👉🏻 _यदि आप आवास सुविधा लेना चाहते हैं, तो इस पास की सहायता से आवास काउंटर से सुविधा प्राप्त कर सकते हैं।_  

📋 *आवास पास विवरण:*  
• पंजीकरण क्रमांक: {registration_no}  
• नाम: {name}  
• गाँव/शहर: {village} - {state}  
• मोबाइल नंबर: {mobile}
• कुल सदस्य: {total_members}  

📍 *आवास काउंटर पर यह पास अनिवार्य रूप से दिखाएँ*  

⚠️ *महत्वपूर्ण निर्देश:*   
• पास के साथ पहचान पत्र लाना अनिवार्य है  
• आवास केवल पूर्व-निर्धारित स्थान पर ही उपलब्ध होगा  

🌿 _"वसुधैव कुटुम्बकम् – सभी आर्यजन एक परिवार।"_  
~ *शताब्दी महोत्सव समिति*`,
      },
      {
        name: "Change Request Message",
        template_type: "change_request",
        message_text: `📝 *शताब्दी महोत्सव – पंजीकरण बदलाव सूचना*  

नमस्ते {name} जी! 🙏🏻  

आपके *शताब्दी महोत्सव* पंजीकरण से संबंधित यदि किसी भी विवरण (नाम, गाँव, मोबाइल नंबर, सदस्य संख्या आदि) में कोई बदलाव करना है, तो कृपया हमें *केवल WhatsApp* के माध्यम से संपर्क करें।  

📞 *संपर्क करें:*  
👉🏻 *WhatsApp Number:* +91 9429437169  
*(शक्य हो तो केवल WhatsApp पर ही संदेश भेजें)*  

📋 *संपर्क करते समय ये जानकारी अवश्य दें:*  
• पंजीकरण क्रमांक: {registration_no}  
• आपका नाम: {name}  
• कौन सा विवरण बदलना है?  
• सही विवरण क्या है?  

⏰ *संपर्क समय:* सुबह 9:00 बजे से शाम 6:00 बजे तक  

⚠️ *महत्वपूर्ण:*  
• केवल WhatsApp संदेश पर ही विवरण बदले जा सकते हैं  
• कॉल या SMS के माध्यम से संशोधन नहीं किया जा सकता  
• संशोधन केवल पंजीकरण अंतिम तिथि तक ही संभव हैं  
 
~ *शताब्दी महोत्सव समिति*`,
      },
    ];

    for (const template of defaultTemplates) {
      const [existing] = await connection.execute(
        "SELECT id FROM message_templates WHERE template_type = ?",
        [template.template_type]
      );
      if (existing.length === 0) {
        await connection.execute(
          "INSERT INTO message_templates (name, template_type, message_text) VALUES (?, ?, ?)",
          [template.name, template.template_type, template.message_text]
        );
      }
    }

    // Insert default configuration
    const [existingConfig] = await connection.execute(
      "SELECT * FROM whatsapp_configuration LIMIT 1"
    );
    if (existingConfig.length === 0) {
      const defaultTemplatePath = path.join(__dirname, "INFO CARD.png");

      await connection.execute(
        "INSERT INTO whatsapp_configuration (selected_groups, admin_numbers, registration_message, barcode_template_path) VALUES (?, ?, ?, ?)",
        [
          JSON.stringify([]),
          JSON.stringify([]),
          defaultTemplates[0].message_text,
          defaultTemplatePath,
        ]
      );
      console.log("Default configuration created");
    }

    console.log("Database tables initialized successfully");
  } catch (error) {
    console.error("Database initialization error:", error);
  } finally {
    if (connection) connection.release();
  }
}

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    next();
  } else {
    res
      .status(401)
      .json({ success: false, message: "Authentication required" });
  }
}

// Load configuration from database
let selectedGroups = [];
let adminNumbers = [];
let registrationMessage = "";
let barcodeTemplatePath = "";

async function loadConfiguration() {
  try {
    const [rows] = await dbPool.execute(
      "SELECT * FROM whatsapp_configuration ORDER BY id DESC LIMIT 1"
    );
    if (rows.length > 0) {
      selectedGroups = rows[0].selected_groups
        ? JSON.parse(rows[0].selected_groups)
        : [];
      adminNumbers = rows[0].admin_numbers
        ? JSON.parse(rows[0].admin_numbers)
        : [];
      registrationMessage = rows[0].registration_message || "";

      let templatePath = rows[0].barcode_template_path || "";

      if (
        !templatePath ||
        !(await fs
          .access(templatePath)
          .then(() => true)
          .catch(() => false))
      ) {
        templatePath = path.join(__dirname, "INFO CARD.png");
      }

      barcodeTemplatePath = templatePath;
    } else {
      barcodeTemplatePath = path.join(__dirname, "INFO CARD.png");
    }
  } catch (error) {
    console.error("Error loading configuration:", error);
    barcodeTemplatePath = path.join(__dirname, "INFO CARD.png");
  }
}

// Save configuration to database
async function saveConfiguration(groups, admins, regMessage, templatePath) {
  try {
    selectedGroups = Array.isArray(groups) ? groups : [];
    adminNumbers = Array.isArray(admins) ? admins : [];
    registrationMessage = regMessage || "";
    barcodeTemplatePath = templatePath || path.join(__dirname, "INFO CARD.png");

    await dbPool.execute(
      `INSERT INTO whatsapp_configuration (selected_groups, admin_numbers, registration_message, barcode_template_path) 
             VALUES (?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE 
             selected_groups = ?, admin_numbers = ?, registration_message = ?, barcode_template_path = ?`,
      [
        JSON.stringify(selectedGroups),
        JSON.stringify(adminNumbers),
        registrationMessage,
        barcodeTemplatePath,
        JSON.stringify(selectedGroups),
        JSON.stringify(adminNumbers),
        registrationMessage,
        barcodeTemplatePath,
      ]
    );
  } catch (error) {
    console.error("Error saving configuration:", error);
  }
}

// Get message template from database
async function getMessageTemplate(templateType) {
  try {
    const [templates] = await dbPool.execute(
      "SELECT message_text FROM message_templates WHERE template_type = ? AND is_active = true ORDER BY id DESC LIMIT 1",
      [templateType]
    );

    if (templates.length > 0) {
      return templates[0].message_text;
    }

    return "";
  } catch (error) {
    console.error("Error getting message template:", error);
    return "";
  }
}

// Get all templates for editing
async function getAllTemplates() {
  try {
    const [templates] = await dbPool.execute(
      'SELECT * FROM message_templates ORDER BY FIELD(template_type, "registration_confirmation", "barcode_message", "change_request", "admin_notification")'
    );
    return templates;
  } catch (error) {
    console.error("Error getting all templates:", error);
    return [];
  }
}

// Update message template
async function updateMessageTemplate(templateType, messageText) {
  try {
    await dbPool.execute(
      "UPDATE message_templates SET message_text = ?, updated_at = NOW() WHERE template_type = ?",
      [messageText, templateType]
    );
    return true;
  } catch (error) {
    console.error("Error updating template:", error);
    return false;
  }
}

// Save sent message to database
async function saveSentMessage(
  messageText,
  mediaUrl,
  recipients,
  recipientType,
  status
) {
  try {
    await dbPool.execute(
      "INSERT INTO sent_messages (message_text, media_url, recipients, recipient_type, status) VALUES (?, ?, ?, ?, ?)",
      [messageText, mediaUrl, JSON.stringify(recipients), recipientType, status]
    );
  } catch (error) {
    console.error("Error saving message to database:", error);
  }
}

// Sync new registrations
async function syncNewRegistrations() {
  try {
    const [lastSynced] = await dbPool.execute(
      "SELECT MAX(registration_id) as last_id FROM registration_sync"
    );
    const lastSyncedId = lastSynced[0].last_id || 0;

    const [newRegistrations] = await dbPool.execute(
      "SELECT * FROM registrations WHERE id > ? ORDER BY id ASC",
      [lastSyncedId]
    );

    if (newRegistrations.length > 0) {
      console.log(`Syncing ${newRegistrations.length} new registrations`);

      for (const reg of newRegistrations) {
        try {
          await dbPool.execute(
            `INSERT INTO registration_sync 
                        (registration_id, registration_no, name, mobile, village, state, position, age, gender, 
                         male_members, female_members, child_members, total_members, connected, message) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
                        ON DUPLICATE KEY UPDATE 
                        name=VALUES(name), mobile=VALUES(mobile), village=VALUES(village), state=VALUES(state),
                        position=VALUES(position), age=VALUES(age), gender=VALUES(gender),
                        male_members=VALUES(male_members), female_members=VALUES(female_members),
                        child_members=VALUES(child_members), total_members=VALUES(total_members),
                        connected=VALUES(connected), message=VALUES(message)`,
            [
              reg.id,
              reg.registration_no,
              reg.name,
              reg.mobile,
              reg.village,
              reg.state,
              reg.position,
              reg.age,
              reg.gender,
              reg.male_members,
              reg.female_members,
              reg.child_members,
              reg.total_members,
              reg.connected,
              reg.message,
            ]
          );
        } catch (error) {
          console.error(`Error syncing registration ${reg.id}:`, error);
        }
      }
    }

    return newRegistrations.length;
  } catch (error) {
    console.error("Error syncing registrations:", error);
    return 0;
  }
}

// Check for pending messages and send them - FIXED VERSION
async function checkAndSendPendingMessages() {
  if (!isAuthenticated) {
    console.log("WhatsApp client not connected, skipping message sending");
    return 0;
  }

  let sentCount = 0;

  try {
    // Get total registration counts for admin notifications
    const [totalCount] = await dbPool.execute(
      "SELECT COUNT(*) as total FROM registrations"
    );
    const [todayCount] = await dbPool.execute(
      "SELECT COUNT(*) as today FROM registrations WHERE DATE(created_at) = CURDATE()"
    );

    const totalRegistrations = totalCount[0].total;
    const todayRegistrations = todayCount[0].today;

    // Get pending user confirmations
    const [pendingUserMessages] = await dbPool.execute(`
            SELECT * FROM registration_sync 
            WHERE user_message_sent = FALSE 
            AND (last_attempt IS NULL OR TIMESTAMPDIFF(SECOND, last_attempt, NOW()) > 30)
            AND retry_count < 3
            ORDER BY registration_id ASC 
            LIMIT 5
        `);

    // Get pending admin notifications
    const [pendingAdminNotifications] = await dbPool.execute(`
            SELECT * FROM registration_sync 
            WHERE admin_notification_sent = FALSE 
            AND (last_attempt IS NULL OR TIMESTAMPDIFF(SECOND, last_attempt, NOW()) > 30)
            AND retry_count < 3
            ORDER BY registration_id ASC 
            LIMIT 5
        `);

    // Get pending barcode messages - WITH LOCK CHECK
    const [pendingBarcodeMessages] = await dbPool.execute(`
            SELECT * FROM registration_sync 
            WHERE user_message_sent = TRUE 
            AND barcode_sent = FALSE 
            AND is_processing = FALSE
            AND (barcode_last_attempt IS NULL OR TIMESTAMPDIFF(SECOND, barcode_last_attempt, NOW()) > 30)
            AND barcode_retry_count < 3
            AND TIMESTAMPDIFF(SECOND, user_sent_at, NOW()) >= 2
            ORDER BY registration_id ASC 
            LIMIT 5
        `);

    // Get pending change request messages (3rd message)
    const [pendingChangeRequestMessages] = await dbPool.execute(`
            SELECT * FROM registration_sync 
            WHERE user_message_sent = TRUE 
            AND change_request_sent = FALSE 
            AND (change_request_last_attempt IS NULL OR TIMESTAMPDIFF(SECOND, change_request_last_attempt, NOW()) > 30)
            AND change_request_retry_count < 3
            AND TIMESTAMPDIFF(MINUTE, user_sent_at, NOW()) >= 1
            ORDER BY registration_id ASC 
            LIMIT 5
        `);

    // Send user confirmation messages
    for (const registration of pendingUserMessages) {
      try {
        await sendUserConfirmation(registration);

        // Update success status
        await dbPool.execute(
          "UPDATE registration_sync SET user_message_sent = TRUE, user_sent_at = NOW(), retry_count = 0 WHERE registration_id = ?",
          [registration.registration_id]
        );

        sentCount++;
        console.log(
          `✓ User confirmation sent to: ${registration.mobile} (ID: ${registration.registration_id})`
        );
        
      } catch (error) {
        console.error(
          `✗ Failed to send user confirmation to ${registration.mobile}:`,
          error
        );

        // Update retry count
        await dbPool.execute(
          "UPDATE registration_sync SET retry_count = retry_count + 1, last_attempt = NOW() WHERE registration_id = ?",
          [registration.registration_id]
        );
      }
    }

    // Send admin notifications
    for (const registration of pendingAdminNotifications) {
      try {
        await sendAdminNotification(
          registration,
          totalRegistrations,
          todayRegistrations
        );

        // Update success status
        await dbPool.execute(
          "UPDATE registration_sync SET admin_notification_sent = TRUE, admin_sent_at = NOW(), retry_count = 0 WHERE registration_id = ?",
          [registration.registration_id]
        );

        sentCount++;
        console.log(
          `✓ Admin notification sent for registration: ${registration.registration_id}`
        );
      } catch (error) {
        console.error(
          `✗ Failed to send admin notification for ${registration.registration_id}:`,
          error
        );

        // Update retry count
        await dbPool.execute(
          "UPDATE registration_sync SET retry_count = retry_count + 1, last_attempt = NOW() WHERE registration_id = ?",
          [registration.registration_id]
        );
      }
    }

    // Send barcode messages - WITH PROPER LOCKING
    for (const registration of pendingBarcodeMessages) {
      try {
        // LOCK THE ROW BEFORE SENDING
        await dbPool.execute(
          "UPDATE registration_sync SET is_processing = TRUE WHERE registration_id = ?",
          [registration.registration_id]
        );

        await sendBarcodeToUser(registration);

        // MARK AS SENT AND RELEASE LOCK
        await dbPool.execute(
          `UPDATE registration_sync 
           SET barcode_sent = TRUE, 
               barcode_sent_at = NOW(), 
               barcode_retry_count = 0,
               is_processing = FALSE
           WHERE registration_id = ?`,
          [registration.registration_id]
        );

        sentCount++;
        console.log(
          `✓ Barcode sent to: ${registration.mobile} (ID: ${registration.registration_id})`
        );
      } catch (error) {
        console.error(
          `✗ Failed to send barcode to ${registration.mobile}:`,
          error
        );

        // RELEASE LOCK ON ERROR
        await dbPool.execute(
          `UPDATE registration_sync 
           SET barcode_retry_count = barcode_retry_count + 1, 
               barcode_last_attempt = NOW(),
               is_processing = FALSE
           WHERE registration_id = ?`,
          [registration.registration_id]
        );
      }
    }

    // Send change request messages (3rd message)
    for (const registration of pendingChangeRequestMessages) {
      try {
        await sendChangeRequestMessage(registration);

        // Update success status
        await dbPool.execute(
          `UPDATE registration_sync 
           SET change_request_sent = TRUE, 
               change_request_sent_at = NOW(), 
               change_request_retry_count = 0
           WHERE registration_id = ?`,
          [registration.registration_id]
        );

        sentCount++;
        console.log(
          `✓ Change request message sent to: ${registration.mobile} (ID: ${registration.registration_id})`
        );
      } catch (error) {
        console.error(
          `✗ Failed to send change request message to ${registration.mobile}:`,
          error
        );

        // Update retry count
        await dbPool.execute(
          `UPDATE registration_sync 
           SET change_request_retry_count = change_request_retry_count + 1, 
               change_request_last_attempt = NOW()
           WHERE registration_id = ?`,
          [registration.registration_id]
        );
      }
    }

    if (sentCount > 0) {
      console.log(`✅ Sent ${sentCount} pending messages`);
    }

    return sentCount;
  } catch (error) {
    console.error("Error sending pending messages:", error);
    return 0;
  }
}

// Send confirmation message to user
async function sendUserConfirmation(registration) {
  try {
    let message = registrationMessage;

    if (!message) {
      const template = await getMessageTemplate("registration_confirmation");
      if (!template) {
        console.log("No registration confirmation found");
        return;
      }
      message = template;
    }

    const userNumber = `91${registration.mobile}@c.us`;

    // Replace template variables - All values will be bold
    message = message
      .replace(/{registration_no}/g, `*${registration.registration_no}*`)
      .replace(/{name}/g, `*${registration.name}*`)
      .replace(/{village}/g, `*${registration.village}*`)
      .replace(/{state}/g, `*${registration.state}*`)
      .replace(/{mobile}/g, `*${registration.mobile}*`)
      .replace(/{position}/g, `*${registration.position}*`)
      .replace(/{age}/g, `*${registration.age}*`)
      .replace(/{gender}/g, `*${registration.gender}*`)
      .replace(/{male_members}/g, `*${registration.male_members}*`)
      .replace(/{female_members}/g, `*${registration.female_members}*`)
      .replace(/{child_members}/g, `*${registration.child_members}*`)
      .replace(/{total_members}/g, `*${registration.total_members}*`)
      .replace(/{connected}/g, `*${registration.connected}*`);

    const delay = Math.floor(Math.random() * 1000) + 500;
    await new Promise((resolve) => setTimeout(resolve, delay));

    await client.sendMessage(userNumber, message);
    console.log(`✓ Sent registration confirmation to ${registration.mobile}`);
  } catch (error) {
    console.error(
      `Error sending confirmation to ${registration.mobile}:`,
      error
    );
    throw error;
  }
}

// Send barcode to user
async function sendBarcodeToUser(registration) {
  try {
    // Check if barcode was already sent (extra safety)
    if (registration.barcode_sent) {
      console.log(`Barcode already sent to ${registration.mobile}, skipping`);
      return;
    }

    // Get barcode message template
    const barcodeMessage = await getMessageTemplate("barcode_message");
    if (!barcodeMessage) {
      console.log("No barcode message template found");
      throw new Error("Barcode message template not found");
    }

    // Replace template variables - All values will be bold
    let message = barcodeMessage
      .replace(/{registration_no}/g, `*${registration.registration_no}*`)
      .replace(/{name}/g, `*${registration.name}*`)
      .replace(/{village}/g, `*${registration.village}*`)
      .replace(/{state}/g, `*${registration.state}*`)
      .replace(/{mobile}/g, `*${registration.mobile}*`)
      .replace(/{total_members}/g, `*${registration.total_members}*`);

    // Generate barcode image with specified size
    const barcodeBuffer = await generateBarcodeImage(
      registration.registration_no
    );

    const userNumber = `91${registration.mobile}@c.us`;

    // Create MessageMedia
    const media = new MessageMedia(
      "image/png",
      barcodeBuffer.toString("base64"),
      `barcode_${registration.registration_no}.png`
    );

    // Add short delay
    const delay = Math.floor(Math.random() * 1000) + 500;
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Send message with barcode
    await client.sendMessage(userNumber, media, { caption: message });
    console.log(`✓ Sent barcode to ${registration.mobile}`);
  } catch (error) {
    console.error(`Error sending barcode to ${registration.mobile}:`, error);
    throw error;
  }
}

// Send change request message (3rd message)
async function sendChangeRequestMessage(registration) {
  try {
    // Check if change request was already sent (extra safety)
    if (registration.change_request_sent) {
      console.log(`Change request already sent to ${registration.mobile}, skipping`);
      return;
    }

    // Get change request message template
    const changeRequestMessage = await getMessageTemplate("change_request");
    if (!changeRequestMessage) {
      console.log("No change request message template found");
      throw new Error("Change request message template not found");
    }

    // Replace template variables - All values will be bold
    let message = changeRequestMessage
      .replace(/{registration_no}/g, `*${registration.registration_no}*`)
      .replace(/{name}/g, `*${registration.name}*`)
      .replace(/{village}/g, `*${registration.village}*`)
      .replace(/{state}/g, `*${registration.state}*`)
      .replace(/{mobile}/g, `*${registration.mobile}*`)
      .replace(/{position}/g, `*${registration.position}*`)
      .replace(/{age}/g, `*${registration.age}*`)
      .replace(/{gender}/g, `*${registration.gender}*`)
      .replace(/{total_members}/g, `*${registration.total_members}*`);

    const userNumber = `91${registration.mobile}@c.us`;

    // Add short delay
    const delay = Math.floor(Math.random() * 1000) + 500;
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Send change request message
    await client.sendMessage(userNumber, message);
    console.log(`✓ Sent change request message to ${registration.mobile}`);
  } catch (error) {
    console.error(`Error sending change request to ${registration.mobile}:`, error);
    throw error;
  }
}

// Generate barcode image
async function generateBarcodeImage(
  registrationNo,
  barcodeType = "CODE128",
  color = "#000000"
) {
  try {
    let templatePath = barcodeTemplatePath;

    if (!templatePath) {
      templatePath = path.join(__dirname, "INFO CARD.png");
    }

    // Check if template exists
    const templateExists = await fs
      .access(templatePath)
      .then(() => true)
      .catch(() => false);

    if (!templateExists) {
      console.log("Creating default barcode");
      const canvas = createCanvas(2700, 1479);
      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "#000000";
      ctx.font = "bold 40px Arial";
      ctx.textAlign = "center";
      ctx.fillText("Satabdi Mahotsav 2025", canvas.width / 2, 100);
      ctx.font = "30px Arial";
      ctx.fillText(`Registration No: ${registrationNo}`, canvas.width / 2, 180);

      const BARCODE_AREA = {
        left: 157,
        top: 1064,
        width: 1308,
        height: 275,
      };

      const tempCanvas = createCanvas(BARCODE_AREA.width, BARCODE_AREA.height);

      // Generate barcode with specified size
      JsBarcode(tempCanvas, registrationNo, {
        format: barcodeType,
        width: 8,           // VERY THICK LINES
        height: 200,        // MAXIMUM HEIGHT
        displayValue: true,
        fontOptions: "bold",
        fontSize: 40,       // LARGE FONT
        textMargin: 12,
        margin: 2,          // Minimal margin
        lineColor: color,
        background: "transparent",
        marginTop: 2,
        marginBottom: 2,
      });

      const barcodeWidth = tempCanvas.width;
      const barcodeHeight = tempCanvas.height;
      const PADDING = 20;
      const whiteBgWidth = barcodeWidth + PADDING * 2;
      const whiteBgHeight = BARCODE_AREA.height;
      const centerX = (BARCODE_AREA.width - whiteBgWidth) / 2;
      const centerY = (BARCODE_AREA.height - barcodeHeight) / 2;

      const barcodeCanvas = createCanvas(
        BARCODE_AREA.width,
        BARCODE_AREA.height
      );
      const barcodeCtx = barcodeCanvas.getContext("2d");

      barcodeCtx.fillStyle = "#FFFFFF";
      roundRect(barcodeCtx, centerX, 0, whiteBgWidth, whiteBgHeight, 20);
      barcodeCtx.fill();

      barcodeCtx.save();
      roundRect(
        barcodeCtx,
        centerX + PADDING,
        centerY,
        barcodeWidth,
        barcodeHeight,
        15
      );
      barcodeCtx.clip();
      barcodeCtx.drawImage(tempCanvas, centerX + PADDING, centerY);
      barcodeCtx.restore();

      ctx.drawImage(barcodeCanvas, BARCODE_AREA.left, BARCODE_AREA.top);

      return canvas.toBuffer("image/png");
    }

    // Read template file
    const templateBuffer = await fs.readFile(templatePath);
    const templateImage = await loadImage(templateBuffer);
    const canvas = createCanvas(templateImage.width, templateImage.height);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(templateImage, 0, 0);

    const BARCODE_AREA = {
      left: 157,
      top: 1064,
      width: 1308,
      height: 275,
    };

    const tempCanvas = createCanvas(BARCODE_AREA.width, BARCODE_AREA.height);

    JsBarcode(tempCanvas, registrationNo, {
      format: barcodeType,
      width: 8,           // VERY THICK LINES
      height: 200,        // MAXIMUM HEIGHT
      displayValue: true,
      fontOptions: "bold",
      fontSize: 40,       // LARGE FONT
      textMargin: 12,
      margin: 2,          // Minimal margin
      lineColor: color,
      background: "transparent",
      marginTop: 2,
      marginBottom: 2,
    });

    const barcodeWidth = tempCanvas.width;
    const barcodeHeight = tempCanvas.height;
    const PADDING = 20;
    const whiteBgWidth = barcodeWidth + PADDING * 2;
    const whiteBgHeight = BARCODE_AREA.height;
    const centerX = (BARCODE_AREA.width - whiteBgWidth) / 2;
    const centerY = (BARCODE_AREA.height - barcodeHeight) / 2;

    const barcodeCanvas = createCanvas(BARCODE_AREA.width, BARCODE_AREA.height);
    const barcodeCtx = barcodeCanvas.getContext("2d");

    barcodeCtx.fillStyle = "#FFFFFF";
    roundRect(barcodeCtx, centerX, 0, whiteBgWidth, whiteBgHeight, 20);
    barcodeCtx.fill();

    barcodeCtx.save();
    roundRect(
      barcodeCtx,
      centerX + PADDING,
      centerY,
      barcodeWidth,
      barcodeHeight,
      15
    );
    barcodeCtx.clip();
    barcodeCtx.drawImage(tempCanvas, centerX + PADDING, centerY);
    barcodeCtx.restore();

    ctx.shadowColor = "rgba(0, 0, 0, 0.1)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 3;

    ctx.drawImage(
      barcodeCanvas,
      BARCODE_AREA.left,
      BARCODE_AREA.top,
      BARCODE_AREA.width,
      BARCODE_AREA.height
    );

    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    return canvas.toBuffer("image/png");
  } catch (error) {
    console.error("Error generating barcode:", error);
    
    // Fallback barcode
    const canvas = createCanvas(800, 400);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#000000";
    ctx.font = "bold 24px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Satabdi Mahotsav 2025", canvas.width / 2, 50);
    ctx.font = "18px Arial";
    ctx.fillText(`Registration No: ${registrationNo}`, canvas.width / 2, 100);

    const tempCanvas = createCanvas(600, 120);

    JsBarcode(tempCanvas, registrationNo, {
      format: barcodeType,
      width: 8,
      height: 100,
      displayValue: true,
      fontOptions: "bold",
      fontSize: 20,
      textMargin: 8,
      margin: 2,
      lineColor: color,
      background: "transparent",
      marginTop: 2,
      marginBottom: 2,
    });

    const barcodeWidth = tempCanvas.width;
    const barcodeHeight = tempCanvas.height;
    const PADDING = 15;
    const whiteBgWidth = barcodeWidth + PADDING * 2;
    const whiteBgHeight = 120;
    const centerX = (600 - whiteBgWidth) / 2;
    const centerY = (120 - barcodeHeight) / 2;

    const barcodeAreaCanvas = createCanvas(600, 120);
    const barcodeAreaCtx = barcodeAreaCanvas.getContext("2d");

    barcodeAreaCtx.fillStyle = "#FFFFFF";
    roundRect(barcodeAreaCtx, centerX, 0, whiteBgWidth, whiteBgHeight, 15);
    barcodeAreaCtx.fill();

    barcodeAreaCtx.save();
    roundRect(
      barcodeAreaCtx,
      centerX + PADDING,
      centerY,
      barcodeWidth,
      barcodeHeight,
      10
    );
    barcodeAreaCtx.clip();
    barcodeAreaCtx.drawImage(tempCanvas, centerX + PADDING, centerY);
    barcodeAreaCtx.restore();

    ctx.drawImage(barcodeAreaCanvas, 100, 150);

    return canvas.toBuffer("image/png");
  }
}

// Helper function to draw rounded rectangles
function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// Send notification to admin groups
async function sendAdminNotification(
  registration,
  totalRegistrations,
  todayRegistrations
) {
  let adminMessage = await getMessageTemplate("admin_notification");

  if (!adminMessage) {
    console.log("No admin notification template found");
    return;
  }

  adminMessage = adminMessage
    .replace(/{registration_no}/g, `*${registration.registration_no}*`)
    .replace(/{name}/g, `*${registration.name}*`)
    .replace(/{village}/g, `*${registration.village}*`)
    .replace(/{state}/g, `*${registration.state}*`)
    .replace(/{mobile}/g, `*${registration.mobile}*`)
    .replace(/{position}/g, `*${registration.position}*`)
    .replace(/{age}/g, `*${registration.age}*`)
    .replace(/{gender}/g, `*${registration.gender}*`)
    .replace(/{male_members}/g, `*${registration.male_members}*`)
    .replace(/{female_members}/g, `*${registration.female_members}*`)
    .replace(/{child_members}/g, `*${registration.child_members}*`)
    .replace(/{total_members}/g, `*${registration.total_members}*`)
    .replace(/{connected}/g, `*${registration.connected}*`)
    .replace(/{total_registrations}/g, `*${totalRegistrations}*`)
    .replace(/{today_registrations}/g, `*${todayRegistrations}*`);

  // Send to selected groups
  for (const groupId of selectedGroups) {
    try {
      const delay = Math.floor(Math.random() * 1000) + 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await client.sendMessage(groupId, adminMessage);
    } catch (error) {
      console.error(`Failed to send to group ${groupId}:`, error);
    }
  }

  // Send to individual admin numbers
  for (const adminNumber of adminNumbers) {
    try {
      const formattedNumber = `91${adminNumber}@c.us`;
      const delay = Math.floor(Math.random() * 1000) + 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await client.sendMessage(formattedNumber, adminMessage);
    } catch (error) {
      console.error(`Failed to send to admin ${adminNumber}:`, error);
    }
  }
}

// Send message to various recipient types
async function sendBulkMessage(
  messageText,
  mediaFile = null,
  recipientType,
  customNumbers = ""
) {
  if (!isAuthenticated) throw new Error("WhatsApp client is not connected");

  const results = [];
  let recipients = [];

  try {
    switch (recipientType) {
      case "groups":
        recipients = selectedGroups;
        break;

      case "all_registrations":
        const [allRegistrations] = await dbPool.execute(
          "SELECT mobile FROM registrations"
        );
        recipients = allRegistrations.map((reg) => `91${reg.mobile}@c.us`);
        break;

      case "custom":
        recipients = customNumbers
          .split(",")
          .map((num) => num.trim())
          .filter((num) => num.length === 10)
          .map((num) => `91${num}@c.us`);
        break;
    }

    const totalRecipients = recipients.length;
    let processedCount = 0;

    io.emit("sendingProgress", {
      status: "started",
      total: totalRecipients,
      processed: 0,
      successful: 0,
      failed: 0,
    });

    for (let recipient of recipients) {
      try {
        const delay = Math.floor(Math.random() * 2000) + 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));

        let sentMessage;
        if (mediaFile) {
          const media = new MessageMedia(
            mediaFile.mimetype,
            mediaFile.buffer.toString("base64"),
            mediaFile.originalname
          );
          sentMessage = await client.sendMessage(recipient, media, {
            caption: messageText,
          });
        } else {
          sentMessage = await client.sendMessage(recipient, messageText);
        }

        results.push({
          recipient,
          status: "success",
          messageId: sentMessage.id.id,
        });
        processedCount++;

        io.emit("sendingProgress", {
          status: "progress",
          total: totalRecipients,
          processed: processedCount,
          successful: results.filter((r) => r.status === "success").length,
          failed: results.filter((r) => r.status === "error").length,
        });

        console.log(`Message sent successfully to: ${recipient}`);
      } catch (error) {
        console.error(`Error sending to ${recipient}:`, error);
        results.push({ recipient, status: "error", error: error.message });
        processedCount++;

        io.emit("sendingProgress", {
          status: "progress",
          total: totalRecipients,
          processed: processedCount,
          successful: results.filter((r) => r.status === "success").length,
          failed: results.filter((r) => r.status === "error").length,
        });
      }
    }

    return results;
  } catch (error) {
    console.error("Error in bulk message sending:", error);
    throw error;
  }
}

// WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "satabdi-client" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-features=site-per-process",
    ],
  },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 1000,
  qrMaxRetries: 3,
});

let availableGroups = [];
let isAuthenticated = false;

// Send QR code to frontend
client.on("qr", async (qr) => {
  console.log("QR code received, generating...");
  const qrDataUrl = await qrcode.toDataURL(qr);
  io.emit("qr", qrDataUrl);
  io.emit("notify", { message: "Scan the QR code to login.", type: "info" });
  io.emit("status", { authenticated: false });
  console.log("QR code generated and sent to frontend.");
});

// Client ready
client.on("ready", async () => {
  isAuthenticated = true;
  io.emit("notify", { message: "WhatsApp Client is ready!", type: "success" });
  io.emit("status", { authenticated: true });
  console.log("Client ready");

  try {
    const chats = await client.getChats();
    availableGroups = chats
      .filter((chat) => chat.isGroup)
      .map((chat) => ({
        id: chat.id._serialized,
        name: chat.name,
        participants: chat.participants ? chat.participants.length : 0,
      }));
    io.emit("groups", availableGroups);
    io.emit("selectedGroups", selectedGroups);
    console.log(`Loaded ${availableGroups.length} groups`);
  } catch (error) {
    console.error("Error loading groups:", error);
    io.emit("notify", { message: "Error loading groups", type: "error" });
  }
});

client.on("auth_failure", (msg) => {
  isAuthenticated = false;
  io.emit("notify", {
    message: `Authentication failed: ${msg}`,
    type: "error",
  });
  io.emit("status", { authenticated: false });
  console.log("Authentication failure:", msg);
});

client.on("disconnected", (reason) => {
  isAuthenticated = false;
  io.emit("notify", {
    message: `Client disconnected: ${reason}`,
    type: "warning",
  });
  io.emit("status", { authenticated: false });
  console.log("Client disconnected:", reason);

  setTimeout(() => {
    console.log("Reinitializing WhatsApp client...");
    client.initialize();
  }, 3000);
});

// Cleanup stuck processes
async function cleanupStuckProcesses() {
  try {
    await dbPool.execute(
      `UPDATE registration_sync 
       SET is_processing = FALSE 
       WHERE is_processing = TRUE 
       AND TIMESTAMPDIFF(MINUTE, updated_at, NOW()) > 5`
    );
    console.log("Cleaned up stuck processes");
  } catch (error) {
    console.error("Error cleaning up stuck processes:", error);
  }
}

// Initialize app
async function initializeApp() {
  await initializeDatabase();
  await loadConfiguration();

  console.log("Initializing WhatsApp client...");
  client.initialize();

  // Start syncing new registrations every 5 seconds
  setInterval(syncNewRegistrations, 5000);

  // Start checking and sending pending messages every 5 seconds
  setInterval(checkAndSendPendingMessages, 5000);

  // Cleanup stuck processes every 5 minutes
  setInterval(cleanupStuckProcesses, 5 * 60 * 1000);

  console.log("Registration sync started (checking every 5 seconds)");
  console.log("Message sender started (checking every 5 seconds)");
  console.log("Stuck process cleanup started (checking every 5 minutes)");
}
initializeApp();

// Authentication routes
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const [users] = await dbPool.execute(
      "SELECT * FROM admin_users WHERE username = ? AND is_active = true",
      [username]
    );

    if (users.length === 0) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    const user = users[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    req.session.authenticated = true;
    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
    };

    res.json({
      success: true,
      message: "Login successful",
      user: req.session.user,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Login failed" });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: "Logout successful" });
});

app.get("/session", (req, res) => {
  if (req.session.authenticated) {
    res.json({ success: true, user: req.session.user });
  } else {
    res.json({ success: false });
  }
});

// Protected routes
app.use("/api", requireAuth);

// API Routes
app.get("/api/config", async (req, res) => {
  try {
    const [templates] = await dbPool.execute(
      'SELECT * FROM message_templates ORDER BY FIELD(template_type, "registration_confirmation", "barcode_message", "change_request", "admin_notification")'
    );
    const [config] = await dbPool.execute(
      "SELECT * FROM whatsapp_configuration ORDER BY id DESC LIMIT 1"
    );

    let currentConfig = {
      selectedGroups: [],
      adminNumbers: "",
      registrationMessage: "",
      barcodeTemplatePath: "",
    };

    if (config.length > 0) {
      currentConfig.selectedGroups = config[0].selected_groups
        ? JSON.parse(config[0].selected_groups)
        : [];
      currentConfig.adminNumbers = config[0].admin_numbers
        ? JSON.parse(config[0].admin_numbers).join(", ")
        : "";
      currentConfig.registrationMessage = config[0].registration_message || "";
      currentConfig.barcodeTemplatePath = config[0].barcode_template_path || "";
    }

    res.json({
      success: true,
      ...currentConfig,
      templates,
    });
  } catch (error) {
    console.error("Error getting config:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update the save-config endpoint
app.post("/api/save-config", async (req, res) => {
  try {
    const { groups, adminNumbers, registrationMessage } = req.body;

    const adminNumbersArray = adminNumbers
      .split(",")
      .map((num) => num.trim())
      .filter((num) => num.length === 10);

    const templatePath = path.join(__dirname, "INFO CARD.png");

    await saveConfiguration(
      groups,
      adminNumbersArray,
      registrationMessage,
      templatePath
    );

    io.emit("notify", {
      message: "Configuration saved successfully!",
      type: "success",
    });
    io.emit("selectedGroups", selectedGroups);
    res.json({ success: true, message: "Configuration saved!" });
  } catch (error) {
    console.error("Error saving configuration:", error);
    res
      .status(500)
      .json({ success: false, message: "Error saving configuration" });
  }
});

// Update template route
app.post("/api/update-template", async (req, res) => {
  try {
    const { templateType, messageText } = req.body;

    const success = await updateMessageTemplate(templateType, messageText);

    if (success) {
      res.json({ success: true, message: "Template updated successfully!" });
    } else {
      res
        .status(500)
        .json({ success: false, message: "Failed to update template" });
    }
  } catch (error) {
    console.error("Error updating template:", error);
    res
      .status(500)
      .json({ success: false, message: "Error updating template" });
  }
});

// Get all templates for editing
app.get("/api/templates", async (req, res) => {
  try {
    const templates = await getAllTemplates();
    res.json({ success: true, templates });
  } catch (error) {
    console.error("Error getting templates:", error);
    res
      .status(500)
      .json({ success: false, message: "Error getting templates" });
  }
});

// Send message route with multer
app.post("/api/send-message", upload.single("media"), async (req, res) => {
  try {
    const { message, recipientType, customNumbers } = req.body;
    const mediaFile = req.file;

    if (!message && !mediaFile) {
      return res
        .status(400)
        .json({ success: false, message: "Message text or media is required" });
    }

    io.emit("sendingStatus", { status: "started", recipientType });

    const results = await sendBulkMessage(
      message,
      mediaFile,
      recipientType,
      customNumbers
    );

    const successful = results.filter((r) => r.status === "success").length;
    const failed = results.filter((r) => r.status === "error").length;

    await saveSentMessage(
      message,
      mediaFile ? mediaFile.originalname : null,
      results.map((r) => r.recipient),
      recipientType,
      "completed"
    );

    io.emit("sendingProgress", {
      status: "completed",
      total: results.length,
      processed: results.length,
      successful: successful,
      failed: failed,
    });

    io.emit("notify", {
      message: `Message sent to ${successful} recipients successfully, ${failed} failed`,
      type: failed === 0 ? "success" : "warning",
    });

    res.json({
      success: true,
      message: "Message sent successfully",
      results: { successful, failed, total: results.length },
    });
  } catch (error) {
    console.error("Error sending message:", error);
    io.emit("sendingProgress", { status: "error", error: error.message });
    io.emit("notify", {
      message: `Error sending message: ${error.message}`,
      type: "error",
    });
    res.status(500).json({ success: false, message: error.message });
  }
});

// Manual trigger to sync registrations
app.post("/api/sync-registrations", async (req, res) => {
  try {
    const syncedCount = await syncNewRegistrations();
    const sentCount = await checkAndSendPendingMessages();
    res.json({
      success: true,
      message: `Sync completed: ${syncedCount} new registrations synced, ${sentCount} messages sent`,
    });
  } catch (error) {
    console.error("Error syncing registrations:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get registration stats
app.get("/api/stats", async (req, res) => {
  try {
    let totalReg = [{ total: 0 }];
    let todayReg = [{ today: 0 }];
    let genderStats = [];
    let positionStats = [];
    let syncStats = [
      {
        total_synced: 0,
        user_messages_sent: 0,
        admin_notifications_sent: 0,
        barcode_messages_sent: 0,
        change_request_sent: 0,
        pending_messages: 0,
      },
    ];

    try {
      [totalReg] = await dbPool.execute(
        "SELECT COUNT(*) as total FROM registrations"
      );
    } catch (error) {
      console.error("Error fetching total registrations:", error.message);
    }

    try {
      [todayReg] = await dbPool.execute(
        "SELECT COUNT(*) as today FROM registrations WHERE DATE(created_at) = CURDATE()"
      );
    } catch (error) {
      console.error("Error fetching today registrations:", error.message);
    }

    try {
      [genderStats] = await dbPool.execute(
        "SELECT gender, COUNT(*) as count FROM registrations GROUP BY gender"
      );
    } catch (error) {
      console.error("Error fetching gender stats:", error.message);
    }

    try {
      [positionStats] = await dbPool.execute(
        "SELECT position, COUNT(*) as count FROM registrations GROUP BY position ORDER BY count DESC"
      );
    } catch (error) {
      console.error("Error fetching position stats:", error.message);
    }

    try {
      [syncStats] = await dbPool.execute(`
                SELECT 
                    COUNT(*) as total_synced,
                    SUM(user_message_sent) as user_messages_sent,
                    SUM(admin_notification_sent) as admin_notifications_sent,
                    SUM(barcode_sent) as barcode_messages_sent,
                    SUM(change_request_sent) as change_request_sent,
                    SUM(CASE WHEN user_message_sent = FALSE OR admin_notification_sent = FALSE OR barcode_sent = FALSE OR change_request_sent = FALSE THEN 1 ELSE 0 END) as pending_messages
                FROM registration_sync
            `);
    } catch (error) {
      console.error("Error fetching sync stats:", error.message);
    }

    res.json({
      success: true,
      stats: {
        total: totalReg[0]?.total || 0,
        today: todayReg[0]?.today || 0,
        whatsappConnected: isAuthenticated,
        genderStats: genderStats || [],
        positionStats: positionStats || [],
        syncStats: syncStats[0] || {
          total_synced: 0,
          user_messages_sent: 0,
          admin_notifications_sent: 0,
          barcode_messages_sent: 0,
          change_request_sent: 0,
          pending_messages: 0,
        },
      },
    });
  } catch (error) {
    console.error("Error getting stats:", error);
    res.status(500).json({
      success: false,
      message: "Error getting statistics",
      error: error.message,
    });
  }
});

// Get latest registrations
app.get("/api/latest-registrations", async (req, res) => {
  try {
    const [registrations] = await dbPool.execute(
      `SELECT registration_no, name, village, state, mobile, position, gender, total_members, created_at 
             FROM registrations ORDER BY id DESC LIMIT 10`
    );

    res.json({
      success: true,
      registrations: registrations,
    });
  } catch (error) {
    console.error("Error getting latest registrations:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get all registrations for barcode generator
app.get("/api/all-registrations", async (req, res) => {
  try {
    const [registrations] = await dbPool.execute(
      `SELECT registration_no, name, village, state, mobile, position, gender, total_members, created_at 
             FROM registrations ORDER BY id DESC LIMIT 100`
    );

    res.json({
      success: true,
      registrations: registrations,
    });
  } catch (error) {
    console.error("Error getting registrations:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Generate barcode endpoint
app.post("/api/generate-barcode", async (req, res) => {
  try {
    const {
      registrationNo,
      barcodeType = "CODE128",
      color = "#000000",
    } = req.body;

    if (!registrationNo) {
      return res
        .status(400)
        .json({ success: false, message: "Registration number is required" });
    }

    const imageBuffer = await generateBarcodeImage(
      registrationNo,
      barcodeType,
      color
    );

    res.setHeader("Content-Type", "image/png");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="barcode_${registrationNo}.png"`
    );

    res.send(imageBuffer);
  } catch (error) {
    console.error("Error in barcode generation:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Send barcode to user endpoint - FIXED WITH LOCKING
app.post("/api/send-barcode", async (req, res) => {
  try {
    const { registrationNo, mobile } = req.body;

    if (!registrationNo || !mobile) {
      return res.status(400).json({
        success: false,
        message: "Registration number and mobile are required",
      });
    }

    if (!isAuthenticated) {
      return res
        .status(400)
        .json({ success: false, message: "WhatsApp client is not connected" });
    }

    // Get registration details WITH LOCK CHECK
    const [registrations] = await dbPool.execute(
      "SELECT * FROM registration_sync WHERE (registration_no = ? OR mobile = ?) AND is_processing = FALSE LIMIT 1",
      [registrationNo, mobile]
    );

    if (registrations.length === 0) {
      return res
        .status(404)
        .json({ 
          success: false, 
          message: "Registration not found or already being processed" 
        });
    }

    const registration = registrations[0];

    // Check if barcode was already sent
    if (registration.barcode_sent) {
      return res.status(400).json({
        success: false,
        message: "Barcode was already sent to this user",
      });
    }

    // LOCK THE ROW
    await dbPool.execute(
      "UPDATE registration_sync SET is_processing = TRUE WHERE registration_id = ?",
      [registration.registration_id]
    );

    try {
      // Send barcode
      await sendBarcodeToUser(registration);

      // Update database - MARK AS SENT AND RELEASE LOCK
      await dbPool.execute(
        `UPDATE registration_sync 
         SET barcode_sent = TRUE, 
             barcode_sent_at = NOW(), 
             barcode_retry_count = 0,
             is_processing = FALSE
         WHERE registration_id = ?`,
        [registration.registration_id]
      );

      res.json({
        success: true,
        message: "Barcode sent successfully!",
        data: { mobile, registrationNo },
      });
    } catch (error) {
      // RELEASE LOCK ON ERROR
      await dbPool.execute(
        `UPDATE registration_sync 
         SET barcode_retry_count = barcode_retry_count + 1, 
             barcode_last_attempt = NOW(),
             is_processing = FALSE
         WHERE registration_id = ?`,
        [registration.registration_id]
      );
      throw error;
    }
  } catch (error) {
    console.error("Error sending barcode:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// API endpoint to get template preview
app.get("/api/template-preview", async (req, res) => {
  try {
    const templatePath = path.join(__dirname, "INFO CARD.png");
    const templateExists = await fs
      .access(templatePath)
      .then(() => true)
      .catch(() => false);

    if (templateExists) {
      const imageBuffer = await fs.readFile(templatePath);
      res.setHeader("Content-Type", "image/png");
      res.send(imageBuffer);
    } else {
      res.status(404).json({ success: false, message: "Template not found" });
    }
  } catch (error) {
    console.error("Error getting template preview:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Public status endpoint (no auth required)
app.get("/status", (req, res) => {
  res.json({
    authenticated: isAuthenticated,
    availableGroups: availableGroups.length,
    monitoring: true,
  });
});

// Logout WhatsApp
app.post("/api/logout-whatsapp", async (req, res) => {
  try {
    await client.logout();
    await client.destroy();
    isAuthenticated = false;
    io.emit("notify", {
      message: "WhatsApp logged out successfully. Scan QR code to login again.",
      type: "info",
    });
    io.emit("status", { authenticated: false });
    res.json({ success: true, message: "WhatsApp logged out successfully" });

    setTimeout(() => {
      console.log("Reinitializing WhatsApp client after logout...");
      client.initialize();
    }, 2000);
  } catch (error) {
    console.error("WhatsApp logout error:", error);
    res.status(500).json({ success: false, message: "WhatsApp logout failed" });
  }
});

// Debug endpoints to check database status
app.get("/api/debug/db-status", async (req, res) => {
  try {
    const connection = await dbPool.getConnection();
    const [tables] = await connection.execute("SHOW TABLES");

    const tableStatus = {};
    const importantTables = [
      "registrations",
      "registration_sync",
      "whatsapp_configuration",
      "message_templates",
      "sent_messages",
      "admin_users",
    ];

    for (const table of importantTables) {
      try {
        const [tableExists] = await connection.execute("SHOW TABLES LIKE ?", [
          table,
        ]);
        tableStatus[table] = {
          exists: tableExists.length > 0,
          rowCount: 0,
        };

        if (tableExists.length > 0) {
          const [count] = await connection.execute(
            `SELECT COUNT(*) as count FROM ${table}`
          );
          tableStatus[table].rowCount = count[0].count;
        }
      } catch (tableError) {
        tableStatus[table] = {
          exists: false,
          error: tableError.message,
        };
      }
    }

    connection.release();

    res.json({
      success: true,
      message: "Database connection successful",
      tables: tables.map((t) => Object.values(t)[0]),
      tableStatus,
      dbConfig: {
        host: dbConfig.host,
        database: dbConfig.database,
        user: dbConfig.user,
      },
    });
  } catch (error) {
    console.error("Database connection error:", error);
    res.status(500).json({
      success: false,
      message: "Database connection failed",
      error: error.message,
      code: error.code,
    });
  }
});

// Add a test endpoint for registration_sync table
app.get("/api/debug/sync-table", async (req, res) => {
  try {
    const connection = await dbPool.getConnection();

    const [tableExists] = await connection.execute(
      "SHOW TABLES LIKE 'registration_sync'"
    );

    if (tableExists.length === 0) {
      connection.release();
      return res.json({
        success: false,
        message: "registration_sync table does not exist",
      });
    }

    const [columns] = await connection.execute("DESCRIBE registration_sync");
    const [sampleData] = await connection.execute(
      "SELECT * FROM registration_sync LIMIT 5"
    );

    connection.release();

    res.json({
      success: true,
      exists: true,
      columns: columns.map((col) => ({
        field: col.Field,
        type: col.Type,
        null: col.Null,
        key: col.Key,
        default: col.Default,
      })),
      sampleData: sampleData,
      rowCount: sampleData.length,
    });
  } catch (error) {
    console.error("Error checking sync table:", error);
    res.status(500).json({
      success: false,
      message: "Error checking registration_sync table",
      error: error.message,
      sql: error.sql,
    });
  }
});

// Send change request message manually
app.post("/api/send-change-request", async (req, res) => {
  try {
    const { registrationNo, mobile } = req.body;

    if (!registrationNo || !mobile) {
      return res.status(400).json({
        success: false,
        message: "Registration number and mobile are required",
      });
    }

    if (!isAuthenticated) {
      return res
        .status(400)
        .json({ success: false, message: "WhatsApp client is not connected" });
    }

    // Get registration details
    const [registrations] = await dbPool.execute(
      "SELECT * FROM registration_sync WHERE registration_no = ? OR mobile = ? LIMIT 1",
      [registrationNo, mobile]
    );

    if (registrations.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Registration not found" });
    }

    const registration = registrations[0];

    // Check if change request was already sent
    if (registration.change_request_sent) {
      return res.status(400).json({
        success: false,
        message: "Change request was already sent to this user",
      });
    }

    // Send change request message
    await sendChangeRequestMessage(registration);

    // Update database
    await dbPool.execute(
      `UPDATE registration_sync 
       SET change_request_sent = TRUE, 
           change_request_sent_at = NOW(), 
           change_request_retry_count = 0
       WHERE registration_id = ?`,
      [registration.registration_id]
    );

    res.json({
      success: true,
      message: "Change request message sent successfully!",
      data: { mobile, registrationNo },
    });
  } catch (error) {
    console.error("Error sending change request:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Socket connection
io.on("connection", (socket) => {
  console.log("Frontend connected");
  socket.emit("status", { authenticated: isAuthenticated });
  socket.emit("selectedGroups", selectedGroups);
  if (availableGroups.length > 0) socket.emit("groups", availableGroups);

  socket.on("disconnect", () => console.log("Frontend disconnected"));
});

const PORT = 6147;
server.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);