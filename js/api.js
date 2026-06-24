/**
 * SUBA API Client (fetch wrapper)
 * Integrates token headers and provides robust mock fallback logic for standalone mode
 */

const SUBAApi = {
  // Base configuration
  BASE_URL: 'https://suba-backend-production.up.railway.app/api/v1',

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
      const response = await fetch(url, config);

      if (response.status === 401) {
        // Unauthenticated -> clear credentials and redirect to login
        SUBAUtils.remove('token');
        SUBAUtils.remove('user');
        window.location.href = 'login.html';
        throw new Error('Session expired. Please log in again.');
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        
        // FastAPI uses "detail" instead of "message" for errors
        let errorMsg = 'API request failed';
        if (typeof errData.detail === 'string') {
            errorMsg = errData.detail;
        } else if (Array.isArray(errData.detail)) {
            // Handle FastAPI Pydantic validation errors
            errorMsg = errData.detail.map(e => `${e.loc.join('.')}: ${e.msg}`).join(', ');
        } else if (errData.message) {
            errorMsg = errData.message;
        }
        
        throw new Error(errorMsg);
      }

      return await response.json();

    } catch (err) {
      console.error(`Backend connection failed for endpoint ${endpoint}. Error:`, err.message);
      throw err;
    }
  }
};
