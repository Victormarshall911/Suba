/**
 * SUBA Utility Functions
 * Formatters, validators, and helpers
 */

const SUBAUtils = {
  /**
   * Format Nigerian phone number
   * @param {string} phone - Raw phone input
   * @returns {string} Formatted phone number
   */
  formatPhone(phone) {
    if (!phone) return '';
    // Remove all non-numeric characters
    let cleaned = phone.replace(/\D/g, '');
    // Handle +234 prefix
    if (cleaned.startsWith('234')) {
      cleaned = '0' + cleaned.substring(3);
    }
    // Handle 234 without +
    if (cleaned.length === 13 && cleaned.startsWith('234')) {
      cleaned = '0' + cleaned.substring(3);
    }
    return cleaned;
  },

  /**
   * Validate Nigerian phone number
   * @param {string} phone - Phone number to validate
   * @returns {boolean}
   */
  isValidPhone(phone) {
    const cleaned = this.formatPhone(phone);
    // Nigerian numbers: 11 digits starting with 070, 080, 081, 090, 091
    const pattern = /^0[789][01]\d{8}$/;
    return pattern.test(cleaned);
  },

  /**
   * Detect network from phone number
   * @param {string} phone - Phone number
   * @returns {string|null} Network name
   */
  detectNetwork(phone) {
    const cleaned = this.formatPhone(phone);
    if (cleaned.length < 4) return null;

    const prefix = cleaned.substring(0, 4);
    const networkPrefixes = {
      MTN: ['0703', '0706', '0803', '0806', '0810', '0813', '0814', '0816', '0903', '0906', '0913', '0916'],
      AIRTEL: ['0701', '0708', '0802', '0808', '0812', '0901', '0902', '0904', '0907', '0912'],
      GLO: ['0705', '0805', '0807', '0811', '0815', '0905', '0915'],
      '9MOBILE': ['0809', '0817', '0818', '0908', '0909']
    };

    for (const [network, prefixes] of Object.entries(networkPrefixes)) {
      if (prefixes.includes(prefix)) return network;
    }
    return null;
  },

  /**
   * Format currency in Naira
   * @param {number} amount - Amount in kobo
   * @param {boolean} fromKobo - If true, amount is in kobo
   * @returns {string} Formatted currency string
   */
  formatCurrency(amount, fromKobo = false) {
    const value = fromKobo ? amount / 100 : amount;
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(value).replace('NGN', '₦');
  },

  /**
   * Format number with commas
   * @param {number} num
   * @returns {string}
   */
  formatNumber(num) {
    return new Intl.NumberFormat('en-NG').format(num);
  },

  /**
   * Format relative time ("2 mins ago")
   * @param {string|Date} date
   * @returns {string}
   */
  timeAgo(date) {
    const now = new Date();
    const past = new Date(date);
    const seconds = Math.floor((now - past) / 1000);

    const intervals = [
      { label: 'year', seconds: 31536000 },
      { label: 'month', seconds: 2592000 },
      { label: 'week', seconds: 604800 },
      { label: 'day', seconds: 86400 },
      { label: 'hour', seconds: 3600 },
      { label: 'min', seconds: 60 }
    ];

    for (const interval of intervals) {
      const count = Math.floor(seconds / interval.seconds);
      if (count >= 1) {
        return `${count} ${interval.label}${count > 1 ? 's' : ''} ago`;
      }
    }
    return 'Just now';
  },

  /**
   * Format date (e.g., "Jun 15, 2026 at 2:30 PM")
   * @param {string|Date} date
   * @returns {string}
   */
  formatDate(date) {
    return new Intl.DateTimeFormat('en-NG', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(new Date(date));
  },

  /**
   * Format short date (e.g., "Jun 15")
   * @param {string|Date} date
   * @returns {string}
   */
  formatShortDate(date) {
    return new Intl.DateTimeFormat('en-NG', {
      month: 'short',
      day: 'numeric'
    }).format(new Date(date));
  },

  /**
   * Copy text to clipboard
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        return true;
      } catch {
        return false;
      } finally {
        document.body.removeChild(textarea);
      }
    }
  },

  /**
   * Debounce function
   * @param {Function} fn
   * @param {number} delay - in ms
   * @returns {Function}
   */
  debounce(fn, delay = 300) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  },

  /**
   * Throttle function
   * @param {Function} fn
   * @param {number} limit - in ms
   * @returns {Function}
   */
  throttle(fn, limit = 300) {
    let inThrottle;
    return function (...args) {
      if (!inThrottle) {
        fn.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  /**
   * Generate a unique request ID (for idempotency)
   * @returns {string}
   */
  generateRequestId() {
    return `SUBA-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  },

  /**
   * Generate referral code
   * @param {string} name
   * @returns {string}
   */
  generateReferralCode(name) {
    const prefix = name.substring(0, 3).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}${random}`;
  },

  /**
   * Validate email
   * @param {string} email
   * @returns {boolean}
   */
  isValidEmail(email) {
    const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return pattern.test(email);
  },

  /**
   * Validate password strength
   * @param {string} password
   * @returns {{ valid: boolean, message: string }}
   */
  validatePassword(password) {
    if (password.length < 8) {
      return { valid: false, message: 'Password must be at least 8 characters' };
    }
    if (!/[A-Z]/.test(password)) {
      return { valid: false, message: 'Include at least one uppercase letter' };
    }
    if (!/[0-9]/.test(password)) {
      return { valid: false, message: 'Include at least one number' };
    }
    return { valid: true, message: 'Password is strong' };
  },

  /**
   * Mask phone number for display (080****1234)
   * @param {string} phone
   * @returns {string}
   */
  maskPhone(phone) {
    const cleaned = this.formatPhone(phone);
    if (cleaned.length < 7) return cleaned;
    return cleaned.substring(0, 3) + '****' + cleaned.substring(7);
  },

  /**
   * Get status color class
   * @param {string} status
   * @returns {string}
   */
  getStatusClass(status) {
    const map = {
      pending: 'badge-pending',
      processing: 'badge-processing',
      successful: 'badge-success',
      success: 'badge-success',
      failed: 'badge-failed',
      refunded: 'badge-refunded'
    };
    return map[status?.toLowerCase()] || 'badge-pending';
  },

  /**
   * Get status display text
   * @param {string} status
   * @returns {string}
   */
  getStatusText(status) {
    const map = {
      pending: 'Pending',
      processing: 'Processing',
      successful: 'Successful',
      success: 'Successful',
      failed: 'Failed',
      refunded: 'Refunded'
    };
    return map[status?.toLowerCase()] || status;
  },

  /**
   * Get service icon emoji
   * @param {string} type
   * @returns {string}
   */
  getServiceIcon(type) {
    const icons = {
      data: '📶',
      airtime: '📱',
      electricity: '⚡',
      tv: '📺',
      wallet: '💰'
    };
    return icons[type?.toLowerCase()] || '📦';
  },

  /**
   * Store data in localStorage safely
   * @param {string} key
   * @param {*} value
   */
  store(key, value) {
    try {
      localStorage.setItem(`suba_${key}`, JSON.stringify(value));
    } catch (e) {
      console.warn('localStorage not available:', e);
    }
  },

  /**
   * Get data from localStorage
   * @param {string} key
   * @param {*} defaultValue
   * @returns {*}
   */
  retrieve(key, defaultValue = null) {
    try {
      const item = localStorage.getItem(`suba_${key}`);
      return item ? JSON.parse(item) : defaultValue;
    } catch {
      return defaultValue;
    }
  },

  /**
   * Remove data from localStorage
   * @param {string} key
   */
  remove(key) {
    try {
      localStorage.removeItem(`suba_${key}`);
    } catch {
      // silently fail
    }
  }
};

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SUBAUtils;
}
