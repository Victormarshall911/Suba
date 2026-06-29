import * as db from '../db/index.js';
import crypto from 'crypto';

class EmailQueueWorker {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.rateLimitDelay = 100; // ms between sending emails to simulate rate limiting
    this.maxRetries = 3;
  }

  enqueue(campaignId, recipients, subject, body, emailType) {
    this.queue.push({
      campaignId,
      recipients,
      subject,
      body,
      emailType,
      currentIndex: 0
    });
    console.log(`✉️ [EMAIL QUEUE] Enqueued campaign ${campaignId} with ${recipients.length} recipients.`);
    this.triggerProcessing();
  }

  triggerProcessing() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.processNext();
  }

  async processNext() {
    console.log(`✉️ [EMAIL QUEUE DEBUG] processNext() called. Queue size: ${this.queue.length}. isProcessing: ${this.isProcessing}`);
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    const currentCampaign = this.queue[0];
    const { campaignId, recipients, subject, body, emailType, currentIndex } = currentCampaign;
    console.log(`✉️ [EMAIL QUEUE DEBUG] Processing campaign: ${campaignId}. Recipients: ${recipients ? recipients.length : 'undefined'}. currentIndex: ${currentIndex}`);

    if (currentIndex >= recipients.length) {
      // Finished processing this campaign
      await db.query(
        "UPDATE email_campaigns SET status = 'COMPLETED', sent_at = NOW() WHERE id = $1",
        [campaignId]
      );
      console.log(`✉️ [EMAIL QUEUE] Campaign ${campaignId} completed successfully.`);
      this.queue.shift();
      setTimeout(() => this.processNext(), 500);
      return;
    }

    // Set campaign status to PROCESSING on start
    if (currentIndex === 0) {
      await db.query(
        "UPDATE email_campaigns SET status = 'PROCESSING', sent_at = NOW() WHERE id = $1",
        [campaignId]
      );
    }

    const recipient = recipients[currentIndex];
    currentCampaign.currentIndex++;

    // Process single email send with retries
    this.sendEmailWithRetry(campaignId, recipient, subject, body, emailType, 0)
      .then(() => {
        setTimeout(() => this.processNext(), this.rateLimitDelay);
      })
      .catch((err) => {
        console.error(`❌ [EMAIL QUEUE] Permanent delivery failure to ${recipient.email}:`, err.message);
        setTimeout(() => this.processNext(), this.rateLimitDelay);
      });
  }

  async sendEmailWithRetry(campaignId, recipient, subject, body, emailType, retryCount) {
    const sender = 'noreply@suba.ng';
    
    // Personalize template placeholders
    const personalizedBody = body
      .replace(/\{\{fullName\}\}/g, recipient.fullName || recipient.email)
      .replace(/\{\{email\}\}/g, recipient.email)
      .replace(/\{\{unsubscribeUrl\}\}/g, `https://suba.ng/unsubscribe?email=${encodeURIComponent(recipient.email)}`);

    try {
      // Simulate SMTP network call
      await this.simulateEmailTransport(recipient.email);

      // Log successful delivery in db
      await db.query(
        `INSERT INTO email_logs (campaign_id, subject, sender, recipient, status, sent_at)
         VALUES ($1, $2, $3, $4, 'DELIVERED', NOW())`,
        [campaignId, subject, sender, recipient.email]
      );

      // Trigger In-App Notification if target category matches requirements
      const triggerCategories = ['general_announcement', 'product_update', 'promotion', 'security_alert', 'career_update'];
      const categoryMap = {
        'general_announcement': 'announcement',
        'product_update': 'product_update',
        'promotion': 'promotion',
        'security_alert': 'security',
        'career_update': 'career'
      };

      if (triggerCategories.includes(emailType) && recipient.userId) {
        const notificationCategory = categoryMap[emailType] || 'announcement';
        await db.query(
          `INSERT INTO in_app_notifications (user_id, title, message, category, is_read)
           VALUES ($1, $2, $3, $4, false)`,
          [recipient.userId, subject, personalizedBody.replace(/<[^>]*>/g, ''), notificationCategory]
        );

        // Alert user dynamically via WebSocket if they are connected
        if (global.sendWebSocketNotification) {
          global.sendWebSocketNotification(recipient.userId, {
            type: 'notification',
            title: `New In-App Alert: ${subject}`,
            message: personalizedBody.replace(/<[^>]*>/g, '').substring(0, 100) + '...',
            timestamp: new Date().toISOString()
          });
        }
      }

      console.log(`✉️ [EMAIL SENT] Campaign ${campaignId} -> ${recipient.email} (Status: DELIVERED)`);
    } catch (err) {
      if (retryCount < this.maxRetries) {
        console.warn(`⚠️ [EMAIL RETRY] Failed sending to ${recipient.email}. Retry attempt ${retryCount + 1}/${this.maxRetries}...`);
        const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff: 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.sendEmailWithRetry(campaignId, recipient, subject, body, emailType, retryCount + 1);
      } else {
        // Record hard failure/bounce log
        await db.query(
          `INSERT INTO email_logs (campaign_id, subject, sender, recipient, status, error_message, sent_at)
           VALUES ($1, $2, $3, $4, 'FAILED', $5, NOW())`,
          [campaignId, subject, sender, recipient.email, err.message]
        );
        throw err;
      }
    }
  }

  simulateEmailTransport(email) {
    return new Promise((resolve, reject) => {
      // Simulate occasional failures for test/robustness auditing
      if (email.includes('bounce') || email.includes('invalid-email')) {
        setTimeout(() => reject(new Error("SMTP Transport Error: Recipient address bounced.")), 50);
      } else if (email.includes('retry-fail') && Math.random() < 0.7) {
        setTimeout(() => reject(new Error("SMTP Relay Timeout: Connection lost.")), 50);
      } else {
        setTimeout(() => resolve(true), 50);
      }
    });
  }
}

const worker = new EmailQueueWorker();

export class EmailService {
  /**
   * Submit campaign to background worker queue
   */
  static async queueCampaign(campaignId) {
    const campaignRes = await db.query('SELECT * FROM email_campaigns WHERE id = $1', [campaignId]);
    if (campaignRes.rowCount === 0) {
      throw new Error("Campaign not found.");
    }
    const campaign = campaignRes.rows[0];

    // Build recipient list
    const recipients = await this.resolveRecipients(campaign.recipient_segment, campaign.recipient_filter, campaign.email_type);
    
    // Update campaign state in DB to QUEUED
    await db.query("UPDATE email_campaigns SET status = 'QUEUED' WHERE id = $1", [campaignId]);

    // Dispatch queue task
    worker.enqueue(campaignId, recipients, campaign.subject, campaign.body, campaign.email_type);
    return { success: true, recipientCount: recipients.length };
  }

  /**
   * Resolves list of recipients according to target criteria and communication preferences
   */
  static async resolveRecipients(segment, filter, emailType) {
    let users = [];

    // 1. Load users based on segment targeting
    if (segment === 'ALL') {
      const res = await db.query('SELECT id, email, full_name, role, location FROM users');
      users = res.rows;
    } else if (segment === 'SUBSCRIBERS') {
      // Load from newsletter_subscribers join users
      const res = await db.query(
        `SELECT ns.email, u.id as user_id, COALESCE(u.full_name, ns.email) as full_name
         FROM newsletter_subscribers ns
         LEFT JOIN users u ON ns.email = u.email
         WHERE ns.status = 'SUBSCRIBED'`
      );
      users = res.rows.map(r => ({
        id: r.user_id,
        email: r.email,
        full_name: r.full_name
      }));
    } else if (segment === 'AMBASSADORS') {
      const res = await db.query(
        `SELECT u.id, u.email, u.full_name 
         FROM users u
         JOIN ambassadors a ON u.id = a.user_id
         WHERE a.status = 'APPROVED'`
      );
      users = res.rows;
    } else if (segment === 'ROLE') {
      const res = await db.query('SELECT id, email, full_name FROM users WHERE role = $1', [filter]);
      users = res.rows;
    } else if (segment === 'LOCATION') {
      const res = await db.query('SELECT id, email, full_name FROM users WHERE location = $1', [filter]);
      users = res.rows;
    } else if (segment === 'SPECIFIC') {
      const res = await db.query('SELECT id, email, full_name FROM users WHERE id = $1 OR email = $2', [filter, filter]);
      users = res.rows;
    } else if (segment === 'CUSTOM') {
      // Split comma separated list
      const emails = filter.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      for (const email of emails) {
        const userRes = await db.query('SELECT id, full_name FROM users WHERE email = $1', [email]);
        if (userRes.rowCount > 0) {
          users.push({ id: userRes.rows[0].id, email, full_name: userRes.rows[0].full_name });
        } else {
          users.push({ id: null, email, full_name: email });
        }
      }
    }

    // 2. Filter list against granular user preferences (Marketing/Newsletter/Updates)
    // Critical security notices bypass configuration rules
    if (emailType === 'security_alert') {
      return users.map(u => ({ userId: u.id, email: u.email, fullName: u.full_name }));
    }

    const filteredRecipients = [];
    for (const u of users) {
      if (!u.id) {
        // Guest subscribers or raw custom emails bypass user preference checks
        filteredRecipients.push({ userId: null, email: u.email, fullName: u.full_name });
        continue;
      }

      // Check granular preferences
      const prefRes = await db.query('SELECT * FROM communication_preferences WHERE user_id = $1', [u.id]);
      const prefs = prefRes.rowCount > 0 ? prefRes.rows[0] : { newsletter: true, marketing: true, product_updates: true };

      let isAllowed = true;
      if (emailType === 'newsletter' && !prefs.newsletter) isAllowed = false;
      if (emailType === 'promotion' && !prefs.marketing) isAllowed = false;
      if (emailType === 'product_update' && !prefs.product_updates) isAllowed = false;
      if (emailType === 'general_announcement' && !prefs.newsletter) isAllowed = false;
      if (emailType === 'career_update' && !prefs.marketing) isAllowed = false;
      if (emailType === 'ambassador_update' && !prefs.marketing) isAllowed = false;

      if (isAllowed) {
        filteredRecipients.push({ userId: u.id, email: u.email, fullName: u.full_name });
      }
    }

    return filteredRecipients;
  }

  /**
   * Sends an automated template-driven email immediately
   */
  static async sendAutomatedEmail(userIdOrEmail, templateName, variables = {}) {
    let email = '';
    let userId = null;
    let fullName = '';

    if (userIdOrEmail.includes('@')) {
      email = userIdOrEmail.toLowerCase().trim();
      const userRes = await db.query('SELECT id, full_name FROM users WHERE email = $1', [email]);
      if (userRes.rowCount > 0) {
        userId = userRes.rows[0].id;
        fullName = userRes.rows[0].full_name;
      } else {
        fullName = email;
      }
    } else {
      userId = userIdOrEmail;
      const userRes = await db.query('SELECT email, full_name FROM users WHERE id = $1', [userId]);
      if (userRes.rowCount > 0) {
        email = userRes.rows[0].email;
        fullName = userRes.rows[0].full_name;
      } else {
        throw new Error("Automated email recipient user not found.");
      }
    }

    // Verify communication preferences for non-security automated templates
    if (templateName !== 'verification' && templateName !== 'password_reset') {
      const prefRes = await db.query('SELECT * FROM communication_preferences WHERE user_id = $1', [userId]);
      const prefs = prefRes.rowCount > 0 ? prefRes.rows[0] : { newsletter: true, marketing: true, product_updates: true };
      
      if (templateName === 'welcome' && !prefs.marketing) return;
      if (templateName === 'weekly_newsletter' && !prefs.newsletter) return;
      if (templateName === 'product_updates' && !prefs.product_updates) return;
      if (templateName === 'feature_release' && !prefs.product_updates) return;
      if (templateName === 'ambassador_approval' && !prefs.marketing) return;
      if (templateName === 'career_announcement' && !prefs.marketing) return;
    }

    const templateRes = await db.query('SELECT * FROM email_templates WHERE name = $1', [templateName]);
    if (templateRes.rowCount === 0) {
      throw new Error(`Email template '${templateName}' not found.`);
    }
    const template = templateRes.rows[0];

    // Populate placeholders
    let body = template.body;
    const mergeVars = { fullName, email, ...variables };
    for (const [k, v] of Object.entries(mergeVars)) {
      body = body.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    }

    // Insert campaign tracker for automated send
    const campRes = await db.query(
      `INSERT INTO email_campaigns (subject, body, email_type, recipient_segment, recipient_filter, status)
       VALUES ($1, $2, $3, 'SPECIFIC', $4, 'QUEUED') RETURNING id`,
      [template.subject, body, templateName, email]
    );
    const campaignId = campRes.rows[0].id;

    // Enqueue task for background worker
    worker.enqueue(campaignId, [{ userId, email, fullName }], template.subject, body, templateName);
    return { campaignId };
  }
}
