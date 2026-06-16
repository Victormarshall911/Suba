/**
 * SUBA Session Routing & Authentication guards
 */

const SUBAAuth = {
  /**
   * Check routing auth guards
   */
  checkGuard() {
    const token = SUBAUtils.retrieve('token');
    const path = window.location.pathname;
    const filename = path.substring(path.lastIndexOf('/') + 1);

    // List of internal application pages
    const internalPages = [
      'dashboard.html',
      'buy-data.html',
      'buy-airtime.html',
      'buy-electricity.html',
      'transactions.html',
      'profile.html',
      'ambassador.html'
    ];

    // List of authentication pages
    const authPages = ['login.html', 'register.html'];

    if (internalPages.includes(filename) && !token) {
      // Trying to access internal dashboard page without token -> login
      console.log(`AuthGuard: Unauthorized access to ${filename}, redirecting to login.html`);
      window.location.href = 'login.html';
    } else if (authPages.includes(filename) && token) {
      // Logged in user trying to access auth pages -> dashboard
      console.log(`AuthGuard: User already logged in, redirecting to dashboard.html`);
      window.location.href = 'dashboard.html';
    }
  },

  /**
   * Handle user login request
   */
  async login(phone, password) {
    try {
      const data = await SUBAApi.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ phone, password })
      });

      if (data && data.token) {
        SUBAUtils.store('token', data.token);
        SUBAUtils.store('user', data.user);
        
        SUBAComponents.showToast({
          title: 'Welcome Back!',
          message: 'Redirecting to your dashboard...',
          type: 'success'
        });

        setTimeout(() => {
          window.location.href = 'dashboard.html';
        }, 1000);
      }
    } catch (err) {
      throw err;
    }
  }
};

// Check guard immediately when script runs
SUBAAuth.checkGuard();
