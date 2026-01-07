// server.js - MIGRATED TO WHATSAPP BUSINESS API
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const bodyParser = require("body-parser");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { createCanvas, loadImage } = require("canvas");
const JsBarcode = require("jsbarcode");
const fs = require("fs").promises;
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Multer setup for handling multipart/form-data
const multer = require("multer");
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
const dbPool = require("mysql2").createPool(dbConfig);

// WhatsApp Business API Configuration
let whatsappConfig = {
  accessToken: "",
  phoneNumberId: "",
  businessAccountId: "",
  apiVersion: "v21.0",
  webhookVerifyToken: "satabdi-verify-2025",
  isConnected: false
};

// WhatsApp API Base URL
const WHATSAPP_API_BASE = "https://graph.facebook.com";

// Load WhatsApp configuration from database
async function loadWhatsAppConfig() {
  try {
    const [rows] = await dbPool.promise().execute(
      "SELECT * FROM whatsapp_api_config WHERE is_active = true ORDER BY id DESC LIMIT 1"
    );
    
    if (rows.length > 0) {
      whatsappConfig.accessToken = rows[0].access_token || "";
      whatsappConfig.phoneNumberId = rows[0].phone_number_id || "";
      whatsappConfig.businessAccountId = rows[0].waba_id || "";
      whatsappConfig.webhookVerifyToken = rows[0].webhook_verify_token || "satabdi-verify-2025";
      whatsappConfig.isConnected = !!(rows[0].access_token && rows[0].phone_number_id);
    }
  } catch (error) {
    console.error("Error loading WhatsApp config:", error);
  }
}

// Save WhatsApp configuration to database
async function saveWhatsAppConfig(config) {
  try {
    await dbPool.promise().execute(
      `INSERT INTO whatsapp_api_config 
       (access_token, phone_number_id, waba_id, webhook_verify_token, webhook_url) 
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
       access_token = ?, phone_number_id = ?, waba_id = ?, 
       webhook_verify_token = ?, webhook_url = ?, updated_at = NOW()`,
      [
        config.accessToken,
        config.phoneNumberId,
        config.businessAccountId,
        config.webhookVerifyToken,
        config.webhookUrl || "",
        config.accessToken,
        config.phoneNumberId,
        config.businessAccountId,
        config.webhookVerifyToken,
        config.webhookUrl || ""
      ]
    );
    
    whatsappConfig = { ...whatsappConfig, ...config };
    whatsappConfig.isConnected = !!(config.accessToken && config.phoneNumberId);
    
    return true;
  } catch (error) {
    console.error("Error saving WhatsApp config:", error);
    return false;
  }
}

// Initialize database tables
async function initializeDatabase() {
  let connection;
  try {
    connection = await dbPool.promise().getConnection();

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

    // WhatsApp API Configuration table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS whatsapp_api_config (
        id INT AUTO_INCREMENT PRIMARY KEY,
        business_id VARCHAR(255),
        phone_number_id VARCHAR(255),
        access_token TEXT,
        waba_id VARCHAR(255),
        webhook_verify_token VARCHAR(255),
        webhook_url VARCHAR(500),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // WhatsApp Templates (Official)
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS whatsapp_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        template_name VARCHAR(255),
        category VARCHAR(50),
        language VARCHAR(10) DEFAULT 'en',
        components JSON,
        status ENUM('PENDING', 'APPROVED', 'REJECTED', 'PAUSED') DEFAULT 'PENDING',
        meta_template_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_template (template_name, language)
      )
    `);

    // Message Queue for API
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS whatsapp_message_queue (
        id INT AUTO_INCREMENT PRIMARY KEY,
        registration_id BIGINT,
        message_type ENUM('TEMPLATE', 'TEXT', 'IMAGE', 'DOCUMENT'),
        template_name VARCHAR(255),
        parameters JSON,
        recipient_number VARCHAR(15),
        status ENUM('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED'),
        meta_message_id VARCHAR(255),
        error_message TEXT,
        retry_count INT DEFAULT 0,
        scheduled_at TIMESTAMP NULL,
        sent_at TIMESTAMP NULL,
        delivered_at TIMESTAMP NULL,
        read_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (status),
        INDEX (recipient_number),
        INDEX (created_at)
      )
    `);

    // Webhook Events Log
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS whatsapp_webhook_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(50),
        meta_message_id VARCHAR(255),
        from_number VARCHAR(15),
        timestamp TIMESTAMP,
        payload JSON,
        processed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (event_type),
        INDEX (from_number),
        INDEX (created_at)
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

// WhatsApp Business API Functions

// Send WhatsApp message using Business API
async function sendWhatsAppMessage(phoneNumber, message, mediaUrl = null) {
  try {
    if (!whatsappConfig.isConnected) {
      throw new Error("WhatsApp Business API not connected");
    }

    const url = `${WHATSAPP_API_BASE}/${whatsappConfig.apiVersion}/${whatsappConfig.phoneNumberId}/messages`;
    
    const headers = {
      Authorization: `Bearer ${whatsappConfig.accessToken}`,
      'Content-Type': 'application/json'
    };

    let payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: `91${phoneNumber}`,
    };

    if (mediaUrl) {
      // Determine media type from URL
      let mediaType = "image";
      if (mediaUrl.endsWith('.pdf')) mediaType = "document";
      else if (mediaUrl.endsWith('.mp4') || mediaUrl.endsWith('.mov')) mediaType = "video";
      else if (mediaUrl.endsWith('.mp3')) mediaType = "audio";
      
      payload.type = mediaType;
      payload[mediaType] = {
        link: mediaUrl,
        caption: message
      };
    } else {
      payload.type = "text";
      payload.text = {
        preview_url: true,
        body: message
      };
    }

    const response = await axios.post(url, payload, { headers });
    
    // Log the message
    await dbPool.promise().execute(
      "INSERT INTO whatsapp_message_queue (recipient_number, message_type, status, meta_message_id) VALUES (?, ?, ?, ?)",
      [phoneNumber, mediaUrl ? 'IMAGE' : 'TEXT', 'SENT', response.data.messages[0].id]
    );

    return response.data;
  } catch (error) {
    console.error("Error sending WhatsApp message:", error.response?.data || error.message);
    
    // Log the error
    await dbPool.promise().execute(
      "INSERT INTO whatsapp_message_queue (recipient_number, message_type, status, error_message) VALUES (?, ?, ?, ?)",
      [phoneNumber, mediaUrl ? 'IMAGE' : 'TEXT', 'FAILED', error.message]
    );
    
    throw error;
  }
}

// Send WhatsApp template message
async function sendWhatsAppTemplate(phoneNumber, templateName, parameters = [], language = "en") {
  try {
    if (!whatsappConfig.isConnected) {
      throw new Error("WhatsApp Business API not connected");
    }

    const url = `${WHATSAPP_API_BASE}/${whatsappConfig.apiVersion}/${whatsappConfig.phoneNumberId}/messages`;
    
    const headers = {
      Authorization: `Bearer ${whatsappConfig.accessToken}`,
      'Content-Type': 'application/json'
    };

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: `91${phoneNumber}`,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: language
        }
      }
    };

    // Add parameters if provided
    if (parameters.length > 0) {
      payload.template.components = [{
        type: "body",
        parameters: parameters.map(param => ({
          type: "text",
          text: param
        }))
      }];
    }

    const response = await axios.post(url, payload, { headers });
    
    // Log the message
    await dbPool.promise().execute(
      "INSERT INTO whatsapp_message_queue (recipient_number, message_type, template_name, parameters, status, meta_message_id) VALUES (?, ?, ?, ?, ?, ?)",
      [phoneNumber, 'TEMPLATE', templateName, JSON.stringify(parameters), 'SENT', response.data.messages[0].id]
    );

    return response.data;
  } catch (error) {
    console.error("Error sending WhatsApp template:", error.response?.data || error.message);
    
    // Log the error
    await dbPool.promise().execute(
      "INSERT INTO whatsapp_message_queue (recipient_number, message_type, template_name, parameters, status, error_message) VALUES (?, ?, ?, ?, ?, ?)",
      [phoneNumber, 'TEMPLATE', templateName, JSON.stringify(parameters), 'FAILED', error.message]
    );
    
    throw error;
  }
}

// Upload media to WhatsApp
async function uploadMediaToWhatsApp(fileBuffer, fileName, mimeType) {
  try {
    const url = `${WHATSAPP_API_BASE}/${whatsappConfig.apiVersion}/${whatsappConfig.phoneNumberId}/media`;
    
    const formData = new FormData();
    formData.append('file', fileBuffer, {
      filename: fileName,
      contentType: mimeType
    });
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', mimeType.split('/')[0]);

    const headers = {
      Authorization: `Bearer ${whatsappConfig.accessToken}`,
      ...formData.getHeaders()
    };

    const response = await axios.post(url, formData, { headers });
    return response.data.id;
  } catch (error) {
    console.error("Error uploading media:", error.response?.data || error.message);
    throw error;
  }
}

// Get message template list from Meta
async function getWhatsAppTemplates() {
  try {
    if (!whatsappConfig.isConnected) {
      return [];
    }

    const url = `${WHATSAPP_API_BASE}/${whatsappConfig.apiVersion}/${whatsappConfig.businessAccountId}/message_templates`;
    
    const headers = {
      Authorization: `Bearer ${whatsappConfig.accessToken}`
    };

    const response = await axios.get(url, { headers });
    
    // Sync with local database
    for (const template of response.data.data) {
      await dbPool.promise().execute(
        `INSERT INTO whatsapp_templates 
         (template_name, category, language, status, meta_template_id) 
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
         status = ?, meta_template_id = ?, updated_at = NOW()`,
        [
          template.name,
          template.category,
          template.language,
          template.status,
          template.id,
          template.status,
          template.id
        ]
      );
    }

    return response.data.data;
  } catch (error) {
    console.error("Error fetching templates:", error.response?.data || error.message);
    return [];
  }
}

// Create WhatsApp template
async function createWhatsAppTemplate(templateData) {
  try {
    if (!whatsappConfig.isConnected) {
      throw new Error("WhatsApp Business API not connected");
    }

    const url = `${WHATSAPP_API_BASE}/${whatsappConfig.apiVersion}/${whatsappConfig.businessAccountId}/message_templates`;
    
    const headers = {
      Authorization: `Bearer ${whatsappConfig.accessToken}`,
      'Content-Type': 'application/json'
    };

    const response = await axios.post(url, templateData, { headers });
    
    // Save to local database
    await dbPool.promise().execute(
      `INSERT INTO whatsapp_templates 
       (template_name, category, language, components, status, meta_template_id) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        templateData.name,
        templateData.category,
        templateData.language,
        JSON.stringify(templateData.components),
        'PENDING',
        response.data.id
      ]
    );

    return response.data;
  } catch (error) {
    console.error("Error creating template:", error.response?.data || error.message);
    throw error;
  }
}

// Process message queue
async function processMessageQueue() {
  try {
    const [pendingMessages] = await dbPool.promise().execute(
      `SELECT * FROM whatsapp_message_queue 
       WHERE status = 'PENDING' 
       AND (retry_count < 3 OR retry_count IS NULL)
       ORDER BY created_at ASC 
       LIMIT 10`
    );

    for (const message of pendingMessages) {
      try {
        let result;
        
        if (message.message_type === 'TEMPLATE') {
          const parameters = message.parameters ? JSON.parse(message.parameters) : [];
          result = await sendWhatsAppTemplate(
            message.recipient_number,
            message.template_name,
            parameters
          );
        } else if (message.message_type === 'TEXT') {
          result = await sendWhatsAppMessage(message.recipient_number, message.message_text);
        } else if (message.message_type === 'IMAGE') {
          // For images, we need to handle differently
          // This would require media upload first
          console.log("Image messages need media upload implementation");
        }

        if (result) {
          await dbPool.promise().execute(
            `UPDATE whatsapp_message_queue 
             SET status = 'SENT', meta_message_id = ?, sent_at = NOW(), retry_count = 0 
             WHERE id = ?`,
            [result.messages?.[0]?.id || null, message.id]
          );
        }
      } catch (error) {
        console.error(`Error sending message ${message.id}:`, error.message);
        
        await dbPool.promise().execute(
          `UPDATE whatsapp_message_queue 
           SET status = 'FAILED', error_message = ?, retry_count = retry_count + 1 
           WHERE id = ?`,
          [error.message, message.id]
        );
      }
    }
  } catch (error) {
    console.error("Error processing message queue:", error);
  }
}

// Webhook verification
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === whatsappConfig.webhookVerifyToken) {
    console.log("Webhook verified successfully");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook handler for incoming messages
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const body = req.body;
    
    // Log webhook event
    await dbPool.promise().execute(
      `INSERT INTO whatsapp_webhook_logs (event_type, payload) 
       VALUES (?, ?)`,
      ['webhook_received', JSON.stringify(body)]
    );

    // Check if it's a WhatsApp event
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.field === 'messages') {
            const message = change.value.messages?.[0];
            if (message) {
              // Handle incoming message
              await handleIncomingMessage(message);
            }
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error in webhook handler:", error);
    res.sendStatus(500);
  }
});

// Handle incoming messages
async function handleIncomingMessage(message) {
  try {
    const from = message.from;
    const messageType = message.type;
    let messageText = '';

    if (messageType === 'text') {
      messageText = message.text.body;
    } else if (messageType === 'interactive') {
      messageText = message.interactive.button_reply?.title || 
                   message.interactive.list_reply?.title || '';
    }

    // Log the incoming message
    await dbPool.promise().execute(
      `INSERT INTO whatsapp_webhook_logs 
       (event_type, meta_message_id, from_number, timestamp, payload, processed) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'message_received',
        message.id,
        from,
        new Date(message.timestamp * 1000),
        JSON.stringify(message),
        true
      ]
    );

    // Check if this is from a registered user
    const [registration] = await dbPool.promise().execute(
      "SELECT * FROM registration_sync WHERE mobile = ? LIMIT 1",
      [from.replace('91', '')]
    );

    if (registration.length > 0) {
      // Handle user responses
      await handleUserResponse(registration[0], messageText);
    }

    // Send auto-response
    await sendAutoResponse(from, messageText);
    
  } catch (error) {
    console.error("Error handling incoming message:", error);
  }
}

// Handle user responses
async function handleUserResponse(registration, messageText) {
  try {
    // You can implement logic here based on user messages
    // For example: change requests, queries, etc.
    
    // Log the user interaction
    await dbPool.promise().execute(
      `INSERT INTO whatsapp_webhook_logs 
       (event_type, from_number, payload) 
       VALUES (?, ?, ?)`,
      ['user_interaction', registration.mobile, JSON.stringify({
        message: messageText,
        registration_id: registration.registration_id
      })]
    );

  } catch (error) {
    console.error("Error handling user response:", error);
  }
}

// Send auto-response
async function sendAutoResponse(phoneNumber, messageText) {
  try {
    let responseMessage = "Thank you for your message. Our team will get back to you shortly.";
    
    // Simple keyword responses
    if (messageText.toLowerCase().includes('help')) {
      responseMessage = "For assistance, please contact our support team at +91 9429437169.";
    } else if (messageText.toLowerCase().includes('registration')) {
      responseMessage = "For registration queries, please visit our website or contact the registration desk.";
    }

    await sendWhatsAppMessage(phoneNumber.replace('91', ''), responseMessage);
  } catch (error) {
    console.error("Error sending auto-response:", error);
  }
}

// Update existing functions to use WhatsApp Business API

// Send confirmation message to user
async function sendUserConfirmation(registration) {
  try {
    let message = await getMessageTemplate("registration_confirmation");

    if (!message) {
      console.log("No registration confirmation template found");
      return;
    }

    // Replace template variables
    message = message
      .replace(/{registration_no}/g, registration.registration_no)
      .replace(/{name}/g, registration.name)
      .replace(/{village}/g, registration.village)
      .replace(/{state}/g, registration.state)
      .replace(/{mobile}/g, registration.mobile)
      .replace(/{position}/g, registration.position)
      .replace(/{age}/g, registration.age)
      .replace(/{gender}/g, registration.gender)
      .replace(/{male_members}/g, registration.male_members)
      .replace(/{female_members}/g, registration.female_members)
      .replace(/{child_members}/g, registration.child_members)
      .replace(/{total_members}/g, registration.total_members)
      .replace(/{connected}/g, registration.connected);

    // Queue message for sending
    await dbPool.promise().execute(
      `INSERT INTO whatsapp_message_queue 
       (registration_id, recipient_number, message_type, message_text, status) 
       VALUES (?, ?, ?, ?, ?)`,
      [
        registration.registration_id,
        registration.mobile,
        'TEXT',
        message,
        'PENDING'
      ]
    );

    console.log(`✓ Queued registration confirmation for ${registration.mobile}`);
  } catch (error) {
    console.error(
      `Error queuing confirmation for ${registration.mobile}:`,
      error
    );
    throw error;
  }
}

// Send barcode to user
async function sendBarcodeToUser(registration) {
  try {
    // Check if barcode was already sent
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

    // Replace template variables
    let message = barcodeMessage
      .replace(/{registration_no}/g, registration.registration_no)
      .replace(/{name}/g, registration.name)
      .replace(/{village}/g, registration.village)
      .replace(/{state}/g, registration.state)
      .replace(/{mobile}/g, registration.mobile)
      .replace(/{total_members}/g, registration.total_members);

    // Generate barcode image
    const barcodeBuffer = await generateBarcodeImage(
      registration.registration_no
    );

    // Save barcode to temporary file
    const barcodePath = path.join(__dirname, 'temp', `barcode_${registration.registration_no}.png`);
    await fs.mkdir(path.dirname(barcodePath), { recursive: true });
    await fs.writeFile(barcodePath, barcodeBuffer);

    // Queue message with media
    await dbPool.promise().execute(
      `INSERT INTO whatsapp_message_queue 
       (registration_id, recipient_number, message_type, message_text, status) 
       VALUES (?, ?, ?, ?, ?)`,
      [
        registration.registration_id,
        registration.mobile,
        'TEXT',
        message,
        'PENDING'
      ]
    );

    // Note: For actual image sending, you would need to:
    // 1. Upload the image to WhatsApp media
    // 2. Then send it as a media message
    // This is simplified for now

    console.log(`✓ Queued barcode for ${registration.mobile}`);
  } catch (error) {
    console.error(`Error queuing barcode for ${registration.mobile}:`, error);
    throw error;
  }
}

// Send change request message
async function sendChangeRequestMessage(registration) {
  try {
    // Check if change request was already sent
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

    // Replace template variables
    let message = changeRequestMessage
      .replace(/{registration_no}/g, registration.registration_no)
      .replace(/{name}/g, registration.name)
      .replace(/{village}/g, registration.village)
      .replace(/{state}/g, registration.state)
      .replace(/{mobile}/g, registration.mobile)
      .replace(/{position}/g, registration.position)
      .replace(/{age}/g, registration.age)
      .replace(/{gender}/g, registration.gender)
      .replace(/{total_members}/g, registration.total_members);

    // Queue message for sending
    await dbPool.promise().execute(
      `INSERT INTO whatsapp_message_queue 
       (registration_id, recipient_number, message_type, message_text, status) 
       VALUES (?, ?, ?, ?, ?)`,
      [
        registration.registration_id,
        registration.mobile,
        'TEXT',
        message,
        'PENDING'
      ]
    );

    console.log(`✓ Queued change request for ${registration.mobile}`);
  } catch (error) {
    console.error(`Error queuing change request for ${registration.mobile}:`, error);
    throw error;
  }
}

// Check and send pending messages
async function checkAndSendPendingMessages() {
  if (!whatsappConfig.isConnected) {
    console.log("WhatsApp Business API not connected, skipping message sending");
    return 0;
  }

  let sentCount = 0;

  try {
    // Process message queue
    await processMessageQueue();

    // Get pending user confirmations
    const [pendingUserMessages] = await dbPool.promise().execute(`
            SELECT * FROM registration_sync 
            WHERE user_message_sent = FALSE 
            AND (last_attempt IS NULL OR TIMESTAMPDIFF(SECOND, last_attempt, NOW()) > 30)
            AND retry_count < 3
            ORDER BY registration_id ASC 
            LIMIT 5
        `);

    // Get pending admin notifications
    const [pendingAdminNotifications] = await dbPool.promise().execute(`
            SELECT * FROM registration_sync 
            WHERE admin_notification_sent = FALSE 
            AND (last_attempt IS NULL OR TIMESTAMPDIFF(SECOND, last_attempt, NOW()) > 30)
            AND retry_count < 3
            ORDER BY registration_id ASC 
            LIMIT 5
        `);

    // Get pending barcode messages
    const [pendingBarcodeMessages] = await dbPool.promise().execute(`
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

    // Get pending change request messages
    const [pendingChangeRequestMessages] = await dbPool.promise().execute(`
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
        await dbPool.promise().execute(
          "UPDATE registration_sync SET user_message_sent = TRUE, user_sent_at = NOW(), retry_count = 0 WHERE registration_id = ?",
          [registration.registration_id]
        );

        sentCount++;
        console.log(
          `✓ User confirmation queued for: ${registration.mobile} (ID: ${registration.registration_id})`
        );
        
      } catch (error) {
        console.error(
          `✗ Failed to queue user confirmation to ${registration.mobile}:`,
          error
        );

        // Update retry count
        await dbPool.promise().execute(
          "UPDATE registration_sync SET retry_count = retry_count + 1, last_attempt = NOW() WHERE registration_id = ?",
          [registration.registration_id]
        );
      }
    }

    // Send barcode messages
    for (const registration of pendingBarcodeMessages) {
      try {
        // LOCK THE ROW BEFORE SENDING
        await dbPool.promise().execute(
          "UPDATE registration_sync SET is_processing = TRUE WHERE registration_id = ?",
          [registration.registration_id]
        );

        await sendBarcodeToUser(registration);

        // MARK AS SENT AND RELEASE LOCK
        await dbPool.promise().execute(
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
          `✓ Barcode queued for: ${registration.mobile} (ID: ${registration.registration_id})`
        );
      } catch (error) {
        console.error(
          `✗ Failed to queue barcode to ${registration.mobile}:`,
          error
        );

        // RELEASE LOCK ON ERROR
        await dbPool.promise().execute(
          `UPDATE registration_sync 
           SET barcode_retry_count = barcode_retry_count + 1, 
               barcode_last_attempt = NOW(),
               is_processing = FALSE
           WHERE registration_id = ?`,
          [registration.registration_id]
        );
      }
    }

    // Send change request messages
    for (const registration of pendingChangeRequestMessages) {
      try {
        await sendChangeRequestMessage(registration);

        // Update success status
        await dbPool.promise().execute(
          `UPDATE registration_sync 
           SET change_request_sent = TRUE, 
               change_request_sent_at = NOW(), 
               change_request_retry_count = 0
           WHERE registration_id = ?`,
          [registration.registration_id]
        );

        sentCount++;
        console.log(
          `✓ Change request queued for: ${registration.mobile} (ID: ${registration.registration_id})`
        );
      } catch (error) {
        console.error(
          `✗ Failed to queue change request to ${registration.mobile}:`,
          error
        );

        // Update retry count
        await dbPool.promise().execute(
          `UPDATE registration_sync 
           SET change_request_retry_count = change_request_retry_count + 1, 
               change_request_last_attempt = NOW()
           WHERE registration_id = ?`,
          [registration.registration_id]
        );
      }
    }

    if (sentCount > 0) {
      console.log(`✅ Queued ${sentCount} pending messages`);
    }

    return sentCount;
  } catch (error) {
    console.error("Error sending pending messages:", error);
    return 0;
  }
}

// Keep the rest of your existing functions (they remain mostly the same)
// Only the WhatsApp sending parts have been updated

// Load configuration from database
let selectedGroups = [];
let adminNumbers = [];
let registrationMessage = "";
let barcodeTemplatePath = "";

async function loadConfiguration() {
  try {
    const [rows] = await dbPool.promise().execute(
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

// Get message template from database
async function getMessageTemplate(templateType) {
  try {
    const [templates] = await dbPool.promise().execute(
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

// Generate barcode image (keep your existing function)
async function generateBarcodeImage(
  registrationNo,
  barcodeType = "CODE128",
  color = "#000000"
) {
  // ... keep your existing generateBarcodeImage function code ...
  // This function remains exactly the same as in your original code
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

// Bulk message sending (updated to use WhatsApp Business API)
async function sendBulkMessage(
  messageText,
  mediaFile = null,
  recipientType,
  customNumbers = ""
) {
  if (!whatsappConfig.isConnected) throw new Error("WhatsApp Business API is not connected");

  const results = [];
  let recipients = [];

  try {
    switch (recipientType) {
      case "groups":
        // Note: WhatsApp Business API doesn't support groups in the same way
        // We'll send to admin numbers instead
        recipients = adminNumbers.map(num => `91${num}@c.us`);
        break;

      case "all_registrations":
        const [allRegistrations] = await dbPool.promise().execute(
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
        const phoneNumber = recipient.replace('91', '').replace('@c.us', '');
        
        // Add delay between messages
        const delay = Math.floor(Math.random() * 2000) + 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));

        if (mediaFile) {
          // For media messages, we need to upload first
          // This is simplified - you'd need to implement media upload
          await dbPool.promise().execute(
            `INSERT INTO whatsapp_message_queue 
             (recipient_number, message_type, message_text, status) 
             VALUES (?, ?, ?, ?)`,
            [phoneNumber, 'TEXT', `${messageText} [Media: ${mediaFile.originalname}]`, 'PENDING']
          );
        } else {
          // Queue text message
          await dbPool.promise().execute(
            `INSERT INTO whatsapp_message_queue 
             (recipient_number, message_type, message_text, status) 
             VALUES (?, ?, ?, ?)`,
            [phoneNumber, 'TEXT', messageText, 'PENDING']
          );
        }

        results.push({
          recipient,
          status: "success",
        });
        processedCount++;

        io.emit("sendingProgress", {
          status: "progress",
          total: totalRecipients,
          processed: processedCount,
          successful: results.filter((r) => r.status === "success").length,
          failed: results.filter((r) => r.status === "error").length,
        });

        console.log(`Message queued for: ${recipient}`);
      } catch (error) {
        console.error(`Error queuing for ${recipient}:`, error);
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

// Initialize app
async function initializeApp() {
  await initializeDatabase();
  await loadConfiguration();
  await loadWhatsAppConfig();

  console.log("WhatsApp Business API Manager initialized");

  // Start syncing new registrations every 5 seconds
  setInterval(syncNewRegistrations, 5000);

  // Start checking and sending pending messages every 5 seconds
  setInterval(checkAndSendPendingMessages, 5000);

  // Process message queue every 10 seconds
  setInterval(processMessageQueue, 10000);

  console.log("Registration sync started (checking every 5 seconds)");
  console.log("Message sender started (checking every 5 seconds)");
  console.log("Message queue processor started (checking every 10 seconds)");
}

// Sync new registrations (keep your existing function)
async function syncNewRegistrations() {
  try {
    const [lastSynced] = await dbPool.promise().execute(
      "SELECT MAX(registration_id) as last_id FROM registration_sync"
    );
    const lastSyncedId = lastSynced[0].last_id || 0;

    const [newRegistrations] = await dbPool.promise().execute(
      "SELECT * FROM registrations WHERE id > ? ORDER BY id ASC",
      [lastSyncedId]
    );

    if (newRegistrations.length > 0) {
      console.log(`Syncing ${newRegistrations.length} new registrations`);

      for (const reg of newRegistrations) {
        try {
          await dbPool.promise().execute(
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

// ==================== API ROUTES ====================

// Authentication routes (keep existing)
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const [users] = await dbPool.promise().execute(
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

// ==================== WHATSAPP BUSINESS API ROUTES ====================

// Connect WhatsApp Business API
app.post("/api/whatsapp/connect", async (req, res) => {
  try {
    const { accessToken, phoneNumberId, businessAccountId, webhookVerifyToken } = req.body;

    if (!accessToken || !phoneNumberId) {
      return res.status(400).json({ 
        success: false, 
        message: "Access token and phone number ID are required" 
      });
    }

    // Test the connection
    const testUrl = `${WHATSAPP_API_BASE}/${whatsappConfig.apiVersion}/${phoneNumberId}`;
    
    try {
      const response = await axios.get(testUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      if (response.data.id === phoneNumberId) {
        // Save configuration
        await saveWhatsAppConfig({
          accessToken,
          phoneNumberId,
          businessAccountId,
          webhookVerifyToken: webhookVerifyToken || whatsappConfig.webhookVerifyToken,
          webhookUrl: `${req.protocol}://${req.get('host')}/webhook/whatsapp`
        });

        // Load templates from Meta
        await getWhatsAppTemplates();

        io.emit("whatsappStatus", { connected: true });
        
        res.json({ 
          success: true, 
          message: "WhatsApp Business API connected successfully",
          data: response.data
        });
      } else {
        res.status(400).json({ 
          success: false, 
          message: "Invalid phone number ID" 
        });
      }
    } catch (error) {
      console.error("WhatsApp API test failed:", error.response?.data || error.message);
      res.status(400).json({ 
        success: false, 
        message: "Failed to connect to WhatsApp Business API",
        error: error.response?.data?.error?.message || error.message
      });
    }
  } catch (error) {
    console.error("Error connecting WhatsApp:", error);
    res.status(500).json({ success: false, message: "Error connecting WhatsApp" });
  }
});

// Get WhatsApp status
app.get("/api/whatsapp/status", async (req, res) => {
  try {
    const [config] = await dbPool.promise().execute(
      "SELECT * FROM whatsapp_api_config WHERE is_active = true ORDER BY id DESC LIMIT 1"
    );

    let connectionStatus = false;
    
    if (config.length > 0 && config[0].access_token && config[0].phone_number_id) {
      // Test the connection
      try {
        const testUrl = `${WHATSAPP_API_BASE}/${whatsappConfig.apiVersion}/${config[0].phone_number_id}`;
        const response = await axios.get(testUrl, {
          headers: {
            Authorization: `Bearer ${config[0].access_token}`
          }
        });
        connectionStatus = response.data.id === config[0].phone_number_id;
      } catch (error) {
        connectionStatus = false;
      }
    }

    res.json({
      success: true,
      connected: connectionStatus,
      config: config[0] || null,
      webhookUrl: `${req.protocol}://${req.get('host')}/webhook/whatsapp`
    });
  } catch (error) {
    console.error("Error getting WhatsApp status:", error);
    res.status(500).json({ success: false, message: "Error getting WhatsApp status" });
  }
});

// Disconnect WhatsApp
app.post("/api/whatsapp/disconnect", async (req, res) => {
  try {
    await dbPool.promise().execute(
      "UPDATE whatsapp_api_config SET is_active = false WHERE is_active = true"
    );
    
    whatsappConfig = {
      accessToken: "",
      phoneNumberId: "",
      businessAccountId: "",
      apiVersion: "v21.0",
      webhookVerifyToken: "satabdi-verify-2025",
      isConnected: false
    };
    
    io.emit("whatsappStatus", { connected: false });
    
    res.json({ success: true, message: "WhatsApp Business API disconnected successfully" });
  } catch (error) {
    console.error("Error disconnecting WhatsApp:", error);
    res.status(500).json({ success: false, message: "Error disconnecting WhatsApp" });
  }
});

// Get WhatsApp templates
app.get("/api/whatsapp/templates", async (req, res) => {
  try {
    // Get templates from Meta
    const metaTemplates = await getWhatsAppTemplates();
    
    // Get templates from local database
    const [localTemplates] = await dbPool.promise().execute(
      "SELECT * FROM whatsapp_templates ORDER BY created_at DESC"
    );

    res.json({
      success: true,
      metaTemplates: metaTemplates,
      localTemplates: localTemplates
    });
  } catch (error) {
    console.error("Error getting templates:", error);
    res.status(500).json({ success: false, message: "Error getting templates" });
  }
});

// Create WhatsApp template
app.post("/api/whatsapp/templates", async (req, res) => {
  try {
    const { name, category, language, components } = req.body;

    if (!name || !category || !language || !components) {
      return res.status(400).json({ 
        success: false, 
        message: "Name, category, language and components are required" 
      });
    }

    const templateData = {
      name,
      category: category.toUpperCase(),
      language,
      components: JSON.parse(components)
    };

    const result = await createWhatsAppTemplate(templateData);
    
    res.json({ 
      success: true, 
      message: "Template created successfully",
      data: result 
    });
  } catch (error) {
    console.error("Error creating template:", error);
    res.status(500).json({ 
      success: false, 
      message: "Error creating template",
      error: error.response?.data?.error?.message || error.message
    });
  }
});

// Send test message
app.post("/api/whatsapp/send-test", async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;

    if (!phoneNumber || !message) {
      return res.status(400).json({ 
        success: false, 
        message: "Phone number and message are required" 
      });
    }

    const result = await sendWhatsAppMessage(phoneNumber, message);
    
    res.json({ 
      success: true, 
      message: "Test message sent successfully",
      data: result 
    });
  } catch (error) {
    console.error("Error sending test message:", error);
    res.status(500).json({ 
      success: false, 
      message: "Error sending test message",
      error: error.response?.data?.error?.message || error.message
    });
  }
});

// Get message analytics
app.get("/api/whatsapp/analytics", async (req, res) => {
  try {
    const [todayStats] = await dbPool.promise().execute(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'READ' THEN 1 ELSE 0 END) as read_count,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
      FROM whatsapp_message_queue 
      WHERE DATE(created_at) = CURDATE()
    `);

    const [weeklyStats] = await dbPool.promise().execute(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
      FROM whatsapp_message_queue 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    res.json({
      success: true,
      today: todayStats[0] || { total: 0, sent: 0, delivered: 0, read_count: 0, failed: 0 },
      weekly: weeklyStats
    });
  } catch (error) {
    console.error("Error getting analytics:", error);
    res.status(500).json({ success: false, message: "Error getting analytics" });
  }
});

// ==================== EXISTING API ROUTES (UPDATED) ====================

// API Routes (keep your existing routes but update status to use WhatsApp Business API)
app.get("/api/config", async (req, res) => {
  try {
    const [templates] = await dbPool.promise().execute(
      'SELECT * FROM message_templates ORDER BY FIELD(template_type, "registration_confirmation", "barcode_message", "change_request", "admin_notification")'
    );
    const [config] = await dbPool.promise().execute(
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

// Save configuration
app.post("/api/save-config", async (req, res) => {
  try {
    const { groups, adminNumbers, registrationMessage } = req.body;

    const adminNumbersArray = adminNumbers
      .split(",")
      .map((num) => num.trim())
      .filter((num) => num.length === 10);

    const templatePath = path.join(__dirname, "INFO CARD.png");

    await dbPool.promise().execute(
      `INSERT INTO whatsapp_configuration (selected_groups, admin_numbers, registration_message, barcode_template_path) 
             VALUES (?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE 
             selected_groups = ?, admin_numbers = ?, registration_message = ?, barcode_template_path = ?`,
      [
        JSON.stringify(groups || []),
        JSON.stringify(adminNumbersArray),
        registrationMessage,
        templatePath,
        JSON.stringify(groups || []),
        JSON.stringify(adminNumbersArray),
        registrationMessage,
        templatePath,
      ]
    );

    io.emit("notify", {
      message: "Configuration saved successfully!",
      type: "success",
    });
    io.emit("selectedGroups", groups || []);
    res.json({ success: true, message: "Configuration saved!" });
  } catch (error) {
    console.error("Error saving configuration:", error);
    res
      .status(500)
      .json({ success: false, message: "Error saving configuration" });
  }
});

// Get all templates
app.get("/api/templates", async (req, res) => {
  try {
    const [templates] = await dbPool.promise().execute(
      'SELECT * FROM message_templates ORDER BY FIELD(template_type, "registration_confirmation", "barcode_message", "change_request", "admin_notification")'
    );
    res.json({ success: true, templates });
  } catch (error) {
    console.error("Error getting templates:", error);
    res
      .status(500)
      .json({ success: false, message: "Error getting templates" });
  }
});

// Update template
app.post("/api/update-template", async (req, res) => {
  try {
    const { templateType, messageText } = req.body;

    await dbPool.promise().execute(
      "UPDATE message_templates SET message_text = ?, updated_at = NOW() WHERE template_type = ?",
      [messageText, templateType]
    );
    
    res.json({ success: true, message: "Template updated successfully!" });
  } catch (error) {
    console.error("Error updating template:", error);
    res
      .status(500)
      .json({ success: false, message: "Error updating template" });
  }
});

// Send message route
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

    await dbPool.promise().execute(
      "INSERT INTO sent_messages (message_text, media_url, recipients, recipient_type, status) VALUES (?, ?, ?, ?, ?)",
      [message, mediaFile ? mediaFile.originalname : null, JSON.stringify(results.map((r) => r.recipient)), recipientType, "completed"]
    );

    io.emit("sendingProgress", {
      status: "completed",
      total: results.length,
      processed: results.length,
      successful: successful,
      failed: failed,
    });

    io.emit("notify", {
      message: `Message queued for ${successful} recipients successfully, ${failed} failed`,
      type: failed === 0 ? "success" : "warning",
    });

    res.json({
      success: true,
      message: "Message queued successfully",
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

// Sync registrations
app.post("/api/sync-registrations", async (req, res) => {
  try {
    const syncedCount = await syncNewRegistrations();
    const sentCount = await checkAndSendPendingMessages();
    res.json({
      success: true,
      message: `Sync completed: ${syncedCount} new registrations synced, ${sentCount} messages queued`,
    });
  } catch (error) {
    console.error("Error syncing registrations:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get stats
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
      [totalReg] = await dbPool.promise().execute(
        "SELECT COUNT(*) as total FROM registrations"
      );
    } catch (error) {
      console.error("Error fetching total registrations:", error.message);
    }

    try {
      [todayReg] = await dbPool.promise().execute(
        "SELECT COUNT(*) as today FROM registrations WHERE DATE(created_at) = CURDATE()"
      );
    } catch (error) {
      console.error("Error fetching today registrations:", error.message);
    }

    try {
      [genderStats] = await dbPool.promise().execute(
        "SELECT gender, COUNT(*) as count FROM registrations GROUP BY gender"
      );
    } catch (error) {
      console.error("Error fetching gender stats:", error.message);
    }

    try {
      [positionStats] = await dbPool.promise().execute(
        "SELECT position, COUNT(*) as count FROM registrations GROUP BY position ORDER BY count DESC"
      );
    } catch (error) {
      console.error("Error fetching position stats:", error.message);
    }

    try {
      [syncStats] = await dbPool.promise().execute(`
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

    // Get WhatsApp stats
    const [whatsappStats] = await dbPool.promise().execute(`
      SELECT 
        COUNT(*) as total_messages,
        SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'READ' THEN 1 ELSE 0 END) as read_count,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
      FROM whatsapp_message_queue
      WHERE DATE(created_at) = CURDATE()
    `);

    res.json({
      success: true,
      stats: {
        total: totalReg[0]?.total || 0,
        today: todayReg[0]?.today || 0,
        whatsappConnected: whatsappConfig.isConnected,
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
        whatsappStats: whatsappStats[0] || {
          total_messages: 0,
          sent: 0,
          delivered: 0,
          read_count: 0,
          failed: 0
        }
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

// Latest registrations
app.get("/api/latest-registrations", async (req, res) => {
  try {
    const [registrations] = await dbPool.promise().execute(
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

// All registrations
app.get("/api/all-registrations", async (req, res) => {
  try {
    const [registrations] = await dbPool.promise().execute(
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

// Generate barcode
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

// Send barcode
app.post("/api/send-barcode", async (req, res) => {
  try {
    const { registrationNo, mobile } = req.body;

    if (!registrationNo || !mobile) {
      return res.status(400).json({
        success: false,
        message: "Registration number and mobile are required",
      });
    }

    if (!whatsappConfig.isConnected) {
      return res
        .status(400)
        .json({ success: false, message: "WhatsApp Business API is not connected" });
    }

    // Get registration details
    const [registrations] = await dbPool.promise().execute(
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
    await dbPool.promise().execute(
      "UPDATE registration_sync SET is_processing = TRUE WHERE registration_id = ?",
      [registration.registration_id]
    );

    try {
      // Send barcode
      await sendBarcodeToUser(registration);

      // Update database - MARK AS SENT AND RELEASE LOCK
      await dbPool.promise().execute(
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
        message: "Barcode queued successfully!",
        data: { mobile, registrationNo },
      });
    } catch (error) {
      // RELEASE LOCK ON ERROR
      await dbPool.promise().execute(
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

// Template preview
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

// Public status endpoint
app.get("/status", (req, res) => {
  res.json({
    whatsappConnected: whatsappConfig.isConnected,
    monitoring: true,
    apiVersion: "whatsapp-business-api",
  });
});

// Debug endpoints
app.get("/api/debug/db-status", async (req, res) => {
  try {
    const connection = await dbPool.promise().getConnection();
    const [tables] = await connection.execute("SHOW TABLES");

    const tableStatus = {};
    const importantTables = [
      "registrations",
      "registration_sync",
      "whatsapp_configuration",
      "whatsapp_api_config",
      "whatsapp_templates",
      "whatsapp_message_queue",
      "whatsapp_webhook_logs",
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

// Socket connection
io.on("connection", (socket) => {
  console.log("Frontend connected");
  socket.emit("whatsappStatus", { connected: whatsappConfig.isConnected });
  socket.emit("selectedGroups", selectedGroups);

  socket.on("disconnect", () => console.log("Frontend disconnected"));
});

// Start the server
const PORT = 6147;
initializeApp().then(() => {
  server.listen(PORT, () =>
    console.log(`Server running on http://localhost:${PORT}`)
  );
}).catch(error => {
  console.error("Failed to initialize app:", error);
});
