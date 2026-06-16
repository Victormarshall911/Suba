/**
 * SUBA API Client (fetch wrapper)
 * Integrates token headers and provides robust mock fallback logic for standalone mode
 */

const SUBAApi = {
  // Base configuration
  BASE_URL: window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1')
    ? 'http://localhost:3000/api'
    : 'https://api.suba.ng/api',

  /**
   * Helper to fetch resources with authorization headers
   */
  async request(endpoint, options = {}) {
    const token = SUBAUtils.retrieve('token');
    
    // Setup headers
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const config = {
      ...options,
      headers
    };

    const url = `${this.BASE_URL}${endpoint}`;

    try {
      // Attempt to hit backend server (wrapped in a quick timeout)
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch(url, { ...config, signal: controller.signal });
      clearTimeout(id);

      if (response.status === 401) {
        // Unauthenticated -> clear credentials and redirect to login
        SUBAUtils.remove('token');
        SUBAUtils.remove('user');
        window.location.href = 'login.html';
        throw new Error('Session expired. Please log in again.');
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || 'API request failed');
      }

      return await response.json();

    } catch (err) {
      console.warn(`Backend connection failed for endpoint ${endpoint}. Entering mock fallback mode. Error:`, err.message);
      return this.handleMockFallback(endpoint, options);
    }
  },

  /**
   * Mock fallback handler for serverless standalone frontend experience
   */
  handleMockFallback(endpoint, options) {
    const method = options.method ? options.method.toUpperCase() : 'GET';
    const body = options.body ? JSON.parse(options.body) : null;

    // Simulate endpoint matching
    if (endpoint.startsWith('/auth/login')) {
      const { phone, password } = body;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (phone && password) {
            resolve({
              token: 'mock_jwt_token_12345',
              user: {
                firstName: 'Tobi',
                lastName: 'Oyelami',
                phone: phone,
                email: 'tobi@unilag.edu.ng',
                referralCode: 'TOB1405',
                balance: 425000 // stored in kobo (₦4,250.00)
              }
            });
          } else {
            reject(new Error('Incorrect login phone number or password.'));
          }
        }, 800);
      });
    }

    if (endpoint.startsWith('/auth/request-otp')) {
      return Promise.resolve({ success: true, message: 'OTP sent successfully to phone number.' });
    }

    if (endpoint.startsWith('/auth/verify-otp')) {
      const { code } = body;
      if (code === '123456') {
        return Promise.resolve({ success: true, message: 'OTP Verified' });
      }
      return Promise.reject(new Error('Incorrect verification code.'));
    }

    if (endpoint.startsWith('/auth/register')) {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            token: 'mock_jwt_token_12345',
            user: {
              firstName: body.firstName,
              lastName: body.lastName,
              phone: body.phone,
              email: body.email,
              referralCode: SUBAUtils.generateReferralCode(body.firstName),
              balance: 0
            }
          });
        }, 800);
      });
    }

    // Default general response fallbacks
    return Promise.resolve({ success: true, mockMode: true });
  }
};
