/**
 * SUBA Shared UI Components
 * Dynamic header, bottom nav, modals, toasts, accordion, carousel, animated counters
 */

const SUBAComponents = {

  /**
   * Initialize all shared components
   */
  init() {
    this.initDarkTheme();
    this.initHeader();
    this.initMobileMenu();
    this.initScrollAnimations();
    this.initAccordions();
    this.initToastContainer();
    this.initCookieConsent();
    this.initFloatingSupport();
    this.initAnnouncements();
  },

  /* ============================================
     HEADER
     ============================================ */

  initHeader() {
    const header = document.querySelector('.header');
    if (!header) return;

    let lastScroll = 0;
    const scrollThreshold = 50;

    window.addEventListener('scroll', SUBAUtils.throttle(() => {
      const currentScroll = window.scrollY;

      if (currentScroll > scrollThreshold) {
        header.classList.add('scrolled');
      } else {
        header.classList.remove('scrolled');
      }

      lastScroll = currentScroll;
    }, 100));
  },

  /* ============================================
     MOBILE MENU
     ============================================ */

  initMobileMenu() {
    const menuBtn = document.querySelector('.mobile-menu-btn');
    const mobileMenu = document.querySelector('.mobile-menu');
    if (!menuBtn || !mobileMenu) return;

    menuBtn.addEventListener('click', () => {
      menuBtn.classList.toggle('active');
      mobileMenu.classList.toggle('active');
      document.body.style.overflow = mobileMenu.classList.contains('active') ? 'hidden' : '';
    });

    // Close menu on link click
    mobileMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        menuBtn.classList.remove('active');
        mobileMenu.classList.remove('active');
        document.body.style.overflow = '';
      });
    });
  },

  /* ============================================
     SCROLL ANIMATIONS (Intersection Observer)
     ============================================ */

  initScrollAnimations() {
    const elements = document.querySelectorAll('.scroll-animate');
    if (!elements.length) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    });

    elements.forEach(el => observer.observe(el));
  },

  /* ============================================
     ACCORDION / FAQ
     ============================================ */

  initAccordions() {
    const items = document.querySelectorAll('.accordion-item');
    items.forEach(item => {
      const trigger = item.querySelector('.accordion-trigger');
      const content = item.querySelector('.accordion-content');
      if (!trigger || !content) return;

      trigger.addEventListener('click', () => {
        const isOpen = item.classList.contains('active');

        // Close all accordions in same group
        const parent = item.closest('.accordion-group');
        if (parent) {
          parent.querySelectorAll('.accordion-item.active').forEach(openItem => {
            if (openItem !== item) {
              openItem.classList.remove('active');
              openItem.querySelector('.accordion-content').style.maxHeight = '0';
            }
          });
        }

        // Toggle current
        item.classList.toggle('active');
        content.style.maxHeight = isOpen ? '0' : content.scrollHeight + 'px';
      });
    });
  },

  /* ============================================
     TOAST NOTIFICATIONS
     ============================================ */

  initToastContainer() {
    if (document.querySelector('.toast-container')) return;
    const container = document.createElement('div');
    container.className = 'toast-container';
    container.id = 'toastContainer';
    document.body.appendChild(container);
  },

  /**
   * Show a toast notification
   * @param {object} options
   * @param {string} options.title - Toast title
   * @param {string} options.message - Toast message
   * @param {string} options.type - 'success' | 'error' | 'warning' | 'info'
   * @param {number} options.duration - Auto-dismiss time in ms (default 4000)
   */
  showToast({ title, message, type = 'info', duration = 4000 }) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <div class="toast-content">
        <div class="toast-title">${title}</div>
        ${message ? `<div class="toast-message">${message}</div>` : ''}
      </div>
      <button class="toast-dismiss" onclick="this.closest('.toast').remove()">✕</button>
    `;

    container.appendChild(toast);

    // Auto dismiss
    if (duration > 0) {
      setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 200);
      }, duration);
    }
  },

  /* ============================================
     MODAL
     ============================================ */

  /**
   * Open a modal
   * @param {string} id - Modal backdrop ID
   */
  openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeModal(id);
      }
    });

    // Close on Escape
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        this.closeModal(id);
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  },

  /**
   * Close a modal
   * @param {string} id - Modal backdrop ID
   */
  closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('active');
    document.body.style.overflow = '';
  },

  /* ============================================
     ANIMATED COUNTER
     ============================================ */

  /**
   * Animate a number counting up
   * @param {HTMLElement} element - Target element
   * @param {number} target - Target number
   * @param {string} suffix - Suffix text (e.g., '+', '%', 'K+')
   * @param {number} duration - Duration in ms
   */
  animateCounter(element, target, suffix = '', duration = 2000) {
    if (!element) return;

    const start = 0;
    const startTime = performance.now();

    const update = (currentTime) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = Math.floor(start + (target - start) * easeOut);

      element.textContent = SUBAUtils.formatNumber(current) + suffix;

      if (progress < 1) {
        requestAnimationFrame(update);
      }
    };

    requestAnimationFrame(update);
  },

  /**
   * Initialize all counters in view
   */
  initCounters() {
    const counters = document.querySelectorAll('[data-counter]');
    if (!counters.length) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          const target = parseInt(el.dataset.counter, 10);
          const suffix = el.dataset.counterSuffix || '';
          this.animateCounter(el, target, suffix);
          observer.unobserve(el);
        }
      });
    }, { threshold: 0.5 });

    counters.forEach(el => observer.observe(el));
  },

  /* ============================================
     TESTIMONIAL CAROUSEL
     ============================================ */

  initTestimonialCarousel() {
    const track = document.querySelector('.testimonials-track');
    const dots = document.querySelectorAll('.testimonial-dot');
    if (!track || !dots.length) return;

    let currentIndex = 0;
    const cards = track.querySelectorAll('.testimonial-card');
    const totalCards = cards.length;

    // Auto-rotate
    let autoplayTimer = setInterval(() => {
      currentIndex = (currentIndex + 1) % totalCards;
      scrollToCard(currentIndex);
    }, 5000);

    function scrollToCard(index) {
      const card = cards[index];
      if (!card) return;
      track.scrollTo({
        left: card.offsetLeft - track.offsetLeft - 16,
        behavior: 'smooth'
      });
      updateDots(index);
    }

    function updateDots(index) {
      dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
      });
    }

    // Dot click handlers
    dots.forEach((dot, i) => {
      dot.addEventListener('click', () => {
        currentIndex = i;
        scrollToCard(i);
        clearInterval(autoplayTimer);
        autoplayTimer = setInterval(() => {
          currentIndex = (currentIndex + 1) % totalCards;
          scrollToCard(currentIndex);
        }, 5000);
      });
    });

    // Pause on hover
    track.addEventListener('mouseenter', () => clearInterval(autoplayTimer));
    track.addEventListener('mouseleave', () => {
      autoplayTimer = setInterval(() => {
        currentIndex = (currentIndex + 1) % totalCards;
        scrollToCard(currentIndex);
      }, 5000);
    });
  },

  /* ============================================
     TABS
     ============================================ */

  /**
   * Initialize tab switching
   * @param {string} containerId - Container element ID
   * @param {Function} onChange - Callback with active tab value
   */
  initTabs(containerId, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const tabs = container.querySelectorAll('[data-tab]');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        if (onChange) onChange(tab.dataset.tab);
      });
    });
  },

  /* ============================================
     TOGGLE / SWITCH
     ============================================ */

  initToggles() {
    document.querySelectorAll('.toggle-wrapper').forEach(wrapper => {
      const toggle = wrapper.querySelector('.toggle');
      if (!toggle) return;

      wrapper.addEventListener('click', () => {
        toggle.classList.toggle('active');
        const event = new CustomEvent('toggle-change', {
          detail: { active: toggle.classList.contains('active') }
        });
        wrapper.dispatchEvent(event);
      });
    });
  },

  /* ============================================
     OTP INPUT
     ============================================ */

  initOTPInputs() {
    const inputs = Array.from(document.querySelectorAll('.otp-input'));
    if (!inputs.length) return;

    inputs.forEach((input, index) => {
      // Use numeric virtual keyboard on mobile
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('autocomplete', index === 0 ? 'one-time-code' : 'off');

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (input.value) {
            input.value = '';
            input.classList.remove('filled');
          } else if (index > 0) {
            inputs[index - 1].focus();
            inputs[index - 1].value = '';
            inputs[index - 1].classList.remove('filled');
          }
        } else if (e.key === 'ArrowLeft' && index > 0) {
          e.preventDefault();
          inputs[index - 1].focus();
        } else if (e.key === 'ArrowRight' && index < inputs.length - 1) {
          e.preventDefault();
          inputs[index + 1].focus();
        }
      });

      input.addEventListener('input', (e) => {
        const val = e.target.value.replace(/\D/g, ''); // strip non-digits
        if (!val) {
          input.value = '';
          input.classList.remove('filled');
          return;
        }
        // If user pasted multi-digit, distribute across boxes
        if (val.length > 1) {
          val.split('').forEach((char, i) => {
            if (inputs[index + i]) {
              inputs[index + i].value = char;
              inputs[index + i].classList.add('filled');
            }
          });
          const nextEmpty = inputs.find((inp, i) => i >= index && !inp.value);
          (nextEmpty || inputs[inputs.length - 1]).focus();
        } else {
          input.value = val;
          input.classList.add('filled');
          if (index < inputs.length - 1) {
            inputs[index + 1].focus();
          }
        }
      });

      // Handle paste on any box — distribute from box 0
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData || window.clipboardData)
          .getData('text')
          .replace(/\D/g, '')
          .slice(0, inputs.length);
        pasted.split('').forEach((char, i) => {
          if (inputs[i]) {
            inputs[i].value = char;
            inputs[i].classList.add('filled');
          }
        });
        const focusIndex = Math.min(pasted.length, inputs.length - 1);
        inputs[focusIndex].focus();
      });

      // Select existing value on focus so re-typing replaces it
      input.addEventListener('focus', () => input.select());
    });
  },

  /* ============================================
     LOADING SKELETON
     ============================================ */

  /**
   * Show a full page loading skeleton overlay
   * Usage: SUBAComponents.showPageSkeleton()
   *        SUBAComponents.hidePageSkeleton()
   */
  showPageSkeleton() {
    if (document.getElementById('subaPageSkeleton')) return;
    const el = document.createElement('div');
    el.id = 'subaPageSkeleton';
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999',
      'background:var(--clr-bg,#fff)',
      'display:flex', 'flex-direction:column', 'gap:16px',
      'padding:24px 20px', 'overflow:hidden',
    ].join(';');
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        <div class="skeleton" style="width:40px;height:40px;border-radius:50%;flex-shrink:0"></div>
        <div style="flex:1">
          <div class="skeleton skeleton-text" style="width:55%;height:14px"></div>
          <div class="skeleton skeleton-text" style="width:30%;height:10px;margin-top:6px"></div>
        </div>
      </div>
      <div class="skeleton" style="width:100%;height:120px;border-radius:16px"></div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
        ${Array(4).fill('<div class="skeleton" style="height:72px;border-radius:12px"></div>').join('')}
      </div>
      <div class="skeleton skeleton-text" style="width:40%;height:13px;margin-top:4px"></div>
      ${Array(3).fill(`
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--clr-border-light,#eee)">
          <div class="skeleton" style="width:36px;height:36px;border-radius:50%;flex-shrink:0"></div>
          <div style="flex:1">
            <div class="skeleton skeleton-text" style="width:60%;height:12px"></div>
            <div class="skeleton skeleton-text" style="width:40%;height:10px;margin-top:5px"></div>
          </div>
          <div class="skeleton skeleton-text" style="width:60px;height:12px"></div>
        </div>
      `).join('')}
    `;
    document.body.appendChild(el);
  },

  hidePageSkeleton() {
    const el = document.getElementById('subaPageSkeleton');
    if (el) {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s ease';
      setTimeout(() => el.remove(), 260);
    }
  },

  /**
   * Inject a skeleton placeholder into a specific container element
   * @param {HTMLElement} element
   * @param {boolean} show
   */
  toggleSkeleton(element, show) {
    if (!element) return;
    if (show) {
      element.dataset.originalContent = element.innerHTML;
      element.innerHTML = `
        <div class="skeleton skeleton-text w-75"></div>
        <div class="skeleton skeleton-text w-50"></div>
        <div class="skeleton skeleton-card" style="margin-top: 12px;"></div>
      `;
    } else if (element.dataset.originalContent) {
      element.innerHTML = element.dataset.originalContent;
      delete element.dataset.originalContent;
    }
  },

  /* ============================================
     BOTTOM NAVIGATION ACTIVE STATE
     ============================================ */

  setActiveNav(page) {
    document.querySelectorAll('.bottom-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });
    document.querySelectorAll('.sidebar-nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });
  },

  /* ============================================
     COOKIE CONSENT BANNER
     ============================================ */
  initCookieConsent() {
    // Only run on user-facing pages, don't show inside admin
    if (window.location.pathname.includes('/admin/')) return;
    if (localStorage.getItem('suba_cookie_consent')) return;

    const banner = document.createElement('div');
    banner.className = 'cookie-banner';
    banner.id = 'cookieConsentBanner';
    banner.innerHTML = `
      <div class="cookie-banner-content">
        <span class="cookie-icon">🍪</span>
        <p>SUBA uses cookies to deliver fast, secure, and reliable VTU services. By using our site, you agree to our <a href="policies.html?tab=privacy">Privacy Policy</a>.</p>
      </div>
      <div class="cookie-banner-actions">
        <button class="btn btn-ghost btn-sm" id="declineCookiesBtn" style="color: var(--clr-text-secondary);">Decline</button>
        <button class="btn btn-primary btn-sm" id="acceptCookiesBtn">Accept Cookies</button>
      </div>
    `;

    document.body.appendChild(banner);

    document.getElementById('acceptCookiesBtn').addEventListener('click', () => {
      localStorage.setItem('suba_cookie_consent', 'accepted');
      banner.classList.add('cookie-banner-hide');
      setTimeout(() => banner.remove(), 400);
    });

    document.getElementById('declineCookiesBtn').addEventListener('click', () => {
      localStorage.setItem('suba_cookie_consent', 'declined');
      banner.classList.add('cookie-banner-hide');
      setTimeout(() => banner.remove(), 400);
    });
  },

  /* ============================================
     FLOATING SUPPORT WIDGET
     ============================================ */
  initFloatingSupport() {
    // Don't show in admin area
    if (window.location.pathname.includes('/admin/')) return;
    if (document.getElementById('supportWidgetContainer')) return;

    const widget = document.createElement('div');
    widget.className = 'support-widget-container';
    widget.id = 'supportWidgetContainer';
    widget.innerHTML = `
      <button class="support-floating-btn" id="supportFloatingBtn" aria-label="Contact Support">
        <span class="support-btn-icon">💬</span>
      </button>
      
      <div class="support-popover" id="supportPopover">
        <div class="support-popover-header">
          <div style="font-weight: 700; color: white;">SUBA Support</div>
          <div style="font-size: 11px; color: rgba(255,255,255,0.85)">Active: 8:00 AM – 10:00 PM WAT</div>
        </div>
        <div class="support-popover-body">
          <p style="margin-bottom: var(--space-3); font-size: 12px; color: var(--clr-text-secondary); line-height: 1.4;">
            Need quick assistance with your transaction?
          </p>
          
          <a href="https://wa.me/2349071486028" target="_blank" class="support-channel-link whatsapp" style="text-decoration: none;">
            <span class="channel-icon">🟢</span>
            <div class="channel-info">
              <div class="channel-name" style="font-weight:600; font-size:13px; color: var(--clr-text-primary);">Chat on WhatsApp</div>
              <div class="channel-desc" style="font-size:10px; color: var(--clr-text-tertiary);">Instant replies • 24/7 active</div>
            </div>
          </a>
          
          <a href="mailto:support@suba.ng" class="support-channel-link email" style="text-decoration: none; margin-top: 8px; display: flex;">
            <span class="channel-icon">✉️</span>
            <div class="channel-info">
              <div class="channel-name" style="font-weight:600; font-size:13px; color: var(--clr-text-primary);">Email Support</div>
              <div class="channel-desc" style="font-size:10px; color: var(--clr-text-tertiary);">Replies within 4 hours</div>
            </div>
          </a>

          <a href="policies.html?tab=support" class="support-channel-link policy" style="text-decoration: none; margin-top: 8px; display: flex;">
            <span class="channel-icon">📄</span>
            <div class="channel-info">
              <div class="channel-name" style="font-weight:600; font-size:13px; color: var(--clr-text-primary);">Support Policy</div>
              <div class="channel-desc" style="font-size:10px; color: var(--clr-text-tertiary);">Read support hours & guidelines</div>
            </div>
          </a>
          
          <div class="support-ticket-form" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--clr-border-light);">
            <div style="font-weight: 600; font-size: 12px; margin-bottom: 6px; color: var(--clr-text-primary)">Submit Quick Ticket</div>
            <textarea id="quickSupportMsg" class="form-textarea" placeholder="Describe your transaction issue..." rows="2" style="font-size: 11px; padding: 6px 10px; resize: none; margin-bottom: 8px;"></textarea>
            <button class="btn btn-primary btn-sm btn-block" id="sendQuickSupportBtn" style="font-size: 11px; padding: 6px 12px; border-radius: var(--radius-md);">Submit Message</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(widget);

    const floatBtn = document.getElementById('supportFloatingBtn');
    const popover = document.getElementById('supportPopover');

    floatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popover.classList.toggle('active');
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#supportWidgetContainer')) {
        popover.classList.remove('active');
      }
    });

    const sendBtn = document.getElementById('sendQuickSupportBtn');
    const msgText = document.getElementById('quickSupportMsg');

    sendBtn.addEventListener('click', () => {
      const msg = msgText.value.trim();
      if (!msg) {
        SUBAComponents.showToast({
          title: 'Empty Message',
          message: 'Please describe your query first.',
          type: 'warning'
        });
        return;
      }

      sendBtn.classList.add('is-loading');
      
      // Send real-time support message via WebSocket event hook
      if (window.SUBASocket && window.SUBASocket.readyState === WebSocket.OPEN) {
        window.SUBASocket.send(JSON.stringify({
          type: 'support_message',
          message: msg
        }));
      }

      setTimeout(() => {
        sendBtn.classList.remove('is-loading');
        msgText.value = '';
        popover.classList.remove('active');
        // Toast notification will be sent back from backend and trigger chime
      }, 1200);
    });
  },

  /* ============================================
     SOUND NOTIFICATION & WEBSOCKET ENGINE
     ============================================ */

  playAlertSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      // Sweet dual chime sound
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      osc.start(ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      
      setTimeout(() => {
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1046.5, ctx.currentTime); // C6
        gain2.gain.setValueAtTime(0.1, ctx.currentTime);
        osc2.start(ctx.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
        setTimeout(() => osc2.stop(), 400);
      }, 150);
      
      setTimeout(() => osc.stop(), 200);
    } catch (err) {
      console.error("Audio Context play failed", err);
    }
  },

  initWebSocket() {
    const token = SUBAUtils.retrieve('token');
    if (!token) return;

    try {
      const wsUrl = window.location.protocol === 'https:' 
        ? `wss://${window.location.host}` 
        : `ws://localhost:8000`;
      
      const socket = new WebSocket(wsUrl);
      window.SUBASocket = socket;

      socket.addEventListener('open', () => {
        console.log('🔌 WebSocket connection active.');
        socket.send(JSON.stringify({ type: 'auth', token }));
      });

      socket.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'notification') {
            this.playAlertSound();
            SUBAComponents.showToast({
              title: data.title,
              message: data.message,
              type: 'success',
              duration: 5000
            });
            
            // Reload user data to update balance
            if (window.location.pathname.includes('dashboard.html') || window.location.pathname.includes('transactions.html')) {
              setTimeout(() => window.location.reload(), 1500);
            }
          } else if (data.type === 'admin_notification') {
            this.playAlertSound();
            SUBAComponents.showToast({
              title: data.title,
              message: data.message,
              type: data.category === 'fraud_alert' ? 'error' : 'info',
              duration: 6000
            });
            
            if (window.location.pathname.includes('/admin/')) {
              setTimeout(() => window.location.reload(), 1500);
            }
          }
        } catch (err) {
          console.error('Error handling websocket message:', err);
        }
      });

      socket.addEventListener('close', () => {
        setTimeout(() => this.initWebSocket(), 5000);
      });
    } catch (err) {
      console.error('WebSocket connection failed:', err);
    }
  },

  /* ============================================
     DARK MODE LIFECYCLE
     ============================================ */
  initDarkTheme() {
    const savedTheme = localStorage.getItem('suba_theme') || 'light';
    if (savedTheme === 'dark') {
      document.documentElement.classList.add('dark-theme');
      document.body.classList.add('dark-theme');
    }

    const toggleTheme = () => {
      const isDark = document.body.classList.toggle('dark-theme');
      document.documentElement.classList.toggle('dark-theme', isDark);
      localStorage.setItem('suba_theme', isDark ? 'dark' : 'light');
      updateToggleIcons();
    };

    const updateToggleIcons = () => {
      document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
        const isDark = document.body.classList.contains('dark-theme');
        btn.innerHTML = isDark ? '☀️' : '🌙';
        btn.setAttribute('title', isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode');
      });
    };

    // Inject toggle buttons into headers/topbars if they exist
    // 1. Homepage Header Actions
    const headerActions = document.querySelector('.header-actions');
    if (headerActions && !headerActions.querySelector('.theme-toggle-btn')) {
      const btn = document.createElement('button');
      btn.className = 'theme-toggle-btn btn btn-ghost btn-sm';
      btn.style.fontSize = '18px';
      btn.style.padding = '0 var(--space-2)';
      btn.style.border = 'none';
      btn.style.background = 'none';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        toggleTheme();
      });
      const registerBtn = headerActions.querySelector('.btn-primary');
      if (registerBtn) {
        headerActions.insertBefore(btn, registerBtn);
      } else {
        headerActions.appendChild(btn);
      }
    }

    // 2. Dashboard Topbar actions
    const topbarActions = document.querySelector('.topbar-actions');
    if (topbarActions && !topbarActions.querySelector('.theme-toggle-btn')) {
      const btn = document.createElement('button');
      btn.className = 'theme-toggle-btn bell-btn';
      btn.style.marginRight = 'var(--space-2)';
      btn.style.background = 'none';
      btn.style.border = 'none';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        toggleTheme();
      });
      const firstChild = topbarActions.firstChild;
      topbarActions.insertBefore(btn, firstChild);
    }

    // 3. Auth Layout floating button
    const authContent = document.querySelector('.auth-content');
    if (authContent && !authContent.querySelector('.theme-toggle-btn')) {
      const btn = document.createElement('button');
      btn.className = 'theme-toggle-btn';
      btn.style.cssText = 'position: absolute; top: 20px; right: 20px; font-size: 24px; z-index: 10; border: 1px solid var(--clr-border); width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--clr-surface); box-shadow: var(--shadow-sm); cursor: pointer;';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        toggleTheme();
      });
      authContent.appendChild(btn);
    }

    updateToggleIcons();
  },

  /* ============================================
     ANNOUNCEMENTS
     ============================================ */
  initAnnouncements() {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (link && (link.textContent.trim() === 'Announcements' || link.classList.contains('footer-announcements-link'))) {
        e.preventDefault();
        this.openAnnouncementsModal();
      }
    });
  },

  openAnnouncementsModal() {
    let modal = document.getElementById('announcementsModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.id = 'announcementsModal';
      modal.innerHTML = `
        <div class="modal" style="max-width: 500px;">
          <div class="modal-header">
            <h3>Announcements 📢</h3>
            <button class="modal-close" onclick="SUBAComponents.closeModal('announcementsModal')">✕</button>
          </div>
          <div class="modal-body" style="padding-top: var(--space-4); max-height: 400px; overflow-y: auto;">
            <div id="announcementsList">
              <div style="text-align: center; padding: var(--space-8); color: var(--clr-text-secondary);">
                <div class="skeleton skeleton-text" style="width: 80%; height: 16px; margin: 0 auto 12px;"></div>
                <div class="skeleton skeleton-text" style="width: 60%; height: 12px; margin: 0 auto;"></div>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    
    this.openModal('announcementsModal');
    this.fetchAnnouncements();
  },

  async fetchAnnouncements() {
    const listContainer = document.getElementById('announcementsList');
    if (!listContainer) return;
    
    try {
      const data = await SUBAApi.request('/announcements');
      if (!data || data.length === 0) {
        listContainer.innerHTML = `
          <div style="text-align: center; padding: var(--space-8); color: var(--clr-text-secondary);">
            <div style="font-size: 40px; margin-bottom: var(--space-3)">📭</div>
            <p>There are no announcements at the moment. Please check back later.</p>
          </div>
        `;
        return;
      }
      
      listContainer.innerHTML = data.map(ann => {
        const dateStr = SUBAUtils.formatDate ? SUBAUtils.formatDate(ann.created_at) : new Date(ann.created_at).toLocaleString();
        return `
          <div style="padding: var(--space-4); border-bottom: 1px solid var(--clr-border-light); margin-bottom: var(--space-3); border-radius: var(--radius-md); background: var(--clr-bg-alt); text-align: left;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: var(--space-2); gap: 10px;">
              <h4 style="font-size: 15px; font-weight: 700; color: var(--clr-text-primary); margin: 0;">${ann.title}</h4>
              <span style="font-size: 10px; color: var(--clr-text-tertiary); white-space: nowrap;">
                ${dateStr}
              </span>
            </div>
            <p style="font-size: 13px; color: var(--clr-text-secondary); line-height: 1.5; white-space: pre-line; margin: 0;">${ann.content}</p>
          </div>
        `;
      }).join('');
    } catch (err) {
      console.error('Error fetching announcements:', err);
      listContainer.innerHTML = `
        <div style="text-align: center; padding: var(--space-8); color: var(--clr-text-secondary);">
          <div style="font-size: 40px; margin-bottom: var(--space-3)">📭</div>
          <p>There are no announcements at the moment. Please check back later.</p>
        </div>
      `;
    }
  }
};

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  SUBAComponents.init();
  SUBAComponents.initWebSocket();
});


/* ============================================
   SUBA RATING POPUP SYSTEM
   Smart, non-intrusive user rating & review
   ============================================ */

const SUBARatingPopup = {

  STAR_LABELS: ['', 'Terrible 😞', 'Not Good 😕', 'Okay 😐', 'Good 😊', 'Excellent! 🤩'],
  _selectedRating: 0,
  _existingRating: null,
  _overlay: null,

  /**
   * Check eligibility and show popup if appropriate.
   * Call this after key actions (post-transaction, dashboard load).
   */
  async checkAndShow(triggerEvent = 'manual') {
    // If no API (no token), skip silently
    const token = (typeof SUBAUtils !== 'undefined') ? SUBAUtils.retrieve('token') : null;
    if (!token) return;

    try {
      const status = await SUBAApi.request('/ratings/status');
      if (!status || !status.shouldShow) return;

      // Log popup shown
      await SUBAApi.request('/ratings/popup/shown', {
        method: 'POST',
        body: JSON.stringify({ triggerEvent })
      }).catch(() => {});

      this._existingRating = status.existingRating || null;
      this._show();
    } catch (err) {
      // Silent fail — rating popup is non-critical
      console.debug('[RatingPopup] Eligibility check skipped:', err.message);
    }
  },

  /**
   * Build and show the popup overlay
   */
  _show() {
    // Remove any existing instance
    this._destroy();

    const overlay = document.createElement('div');
    overlay.className = 'rating-popup-overlay';
    overlay.id = 'subaRatingPopupOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Rate Suba');

    overlay.innerHTML = `
      <div class="rating-popup-card" id="subaRatingCard">
        <!-- Progress dots -->
        <div class="rating-progress-dots">
          <span class="rating-dot active" id="rdot1"></span>
          <span class="rating-dot" id="rdot2"></span>
        </div>

        <!-- Step 1: Star selection -->
        <div id="ratingStep1">
          <div class="rating-popup-header">
            <div class="rating-popup-icon">⭐</div>
            <button class="rating-popup-close" id="ratingCloseBtn" aria-label="Close rating popup">✕</button>
          </div>
          <h3 class="rating-popup-title">
            ${this._existingRating ? 'Update Your Rating' : 'How are we doing?'}
          </h3>
          <p class="rating-popup-subtitle">
            ${this._existingRating
              ? `You last rated us ${'★'.repeat(this._existingRating.rating)}. Want to update?`
              : 'Your feedback helps us make Suba better for everyone. It only takes 10 seconds!'}
          </p>

          <div class="rating-stars-row" id="ratingStarsRow" role="radiogroup" aria-label="Star rating">
            ${[1,2,3,4,5].map(i => `
              <button
                class="rating-star-btn${this._existingRating && i <= this._existingRating.rating ? ' selected' : ''}"
                data-value="${i}"
                id="ratingStar${i}"
                role="radio"
                aria-checked="${this._existingRating && i <= this._existingRating.rating ? 'true' : 'false'}"
                aria-label="${i} star${i > 1 ? 's' : ''}"
              >★</button>
            `).join('')}
          </div>

          <div class="rating-label-text" id="ratingLabelText">
            ${this._existingRating ? this.STAR_LABELS[this._existingRating.rating] : 'Tap a star to rate'}
          </div>

          <div class="rating-popup-actions">
            <div class="rating-action-row">
              <button class="btn btn-primary" id="ratingNextBtn" disabled>
                Next →
              </button>
            </div>
            <div class="rating-tertiary-actions">
              <button class="rating-tertiary-link" id="ratingRemindLaterBtn">Remind me later</button>
              <button class="rating-tertiary-link" id="ratingNeverBtn">Never show again</button>
            </div>
          </div>
        </div>

        <!-- Step 2: Review text + improvement feedback -->
        <div id="ratingStep2" style="display:none;">
          <div class="rating-popup-header">
            <div class="rating-popup-icon" id="ratingStep2Icon">💬</div>
            <button class="rating-popup-close" id="ratingCloseBtn2" aria-label="Close rating popup">✕</button>
          </div>
          <h3 class="rating-popup-title" id="ratingStep2Title">Tell us more (optional)</h3>
          <p class="rating-popup-subtitle" id="ratingStep2Subtitle">Your thoughts help us improve Suba for you and other students.</p>

          <!-- Low rating improvement section -->
          <div id="ratingImprovementSection" style="display:none;">
            <div class="rating-improvement-hint">
              <span>⚠️</span>
              <span>We're sorry to hear that! Please tell us what went wrong so we can fix it.</span>
            </div>
            <div style="margin-top: var(--space-3);">
              <label for="ratingImprovementInput">What can we improve?</label>
              <textarea id="ratingImprovementInput" rows="3" placeholder="e.g. The app was slow, transaction failed, etc." style="margin-top:6px;"></textarea>
            </div>
          </div>

          <div class="rating-text-step visible" id="ratingTextFields">
            <div>
              <label for="ratingTitleInput">Review Title (optional)</label>
              <input type="text" id="ratingTitleInput" placeholder="Summarize your experience in a few words..." maxlength="100">
            </div>
            <div>
              <label for="ratingCommentInput">Your Review (optional)</label>
              <textarea id="ratingCommentInput" rows="3" placeholder="What do you love most about Suba?"></textarea>
            </div>
          </div>

          <div class="rating-popup-actions">
            <div class="rating-action-row">
              <button class="btn btn-ghost btn-sm" id="ratingBackBtn">← Back</button>
              <button class="btn btn-primary" id="ratingSubmitBtn">Submit Rating</button>
            </div>
          </div>
        </div>

        <!-- Step 3: Thank you -->
        <div id="ratingStep3" class="rating-thankyou-step">
          <span class="rating-thankyou-emoji" id="ratingThankyouEmoji">🎉</span>
          <h3 class="rating-thankyou-title" id="ratingThankyouTitle">Thank you!</h3>
          <p class="rating-thankyou-msg" id="ratingThankyouMsg">We're grateful for your feedback. It helps us make Suba better every day.</p>
          <div id="ratingSharePromptWrap" style="display:none; margin-top: var(--space-4);">
            <p style="font-size:var(--text-sm); color:var(--clr-text-secondary); margin-bottom:var(--space-3);">Since you love Suba, why not share it?</p>
            <button class="rating-share-prompt" id="ratingShareBtn">📤 Share Suba with Friends</button>
          </div>
          <button class="btn btn-secondary" id="ratingDoneBtn" style="margin-top:var(--space-4); width:100%;">Done</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this._overlay = overlay;
    this._selectedRating = this._existingRating ? this._existingRating.rating : 0;

    // Trigger animation after DOM paint
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.classList.add('active');
      });
    });

    this._bindEvents(overlay);
  },

  _bindEvents(overlay) {
    const self = this;

    // Star hover & selection
    const starBtns = overlay.querySelectorAll('.rating-star-btn');
    const labelEl = overlay.getElementById ? overlay.getElementById('ratingLabelText') : document.getElementById('ratingLabelText');
    const nextBtn = document.getElementById('ratingNextBtn');

    starBtns.forEach(btn => {
      const val = parseInt(btn.dataset.value);

      btn.addEventListener('mouseenter', () => {
        starBtns.forEach((b, i) => {
          b.classList.toggle('hovered', i < val);
          b.setAttribute('aria-checked', i < val ? 'true' : 'false');
        });
        document.getElementById('ratingLabelText').textContent = self.STAR_LABELS[val];
      });

      btn.addEventListener('mouseleave', () => {
        starBtns.forEach((b, i) => {
          b.classList.remove('hovered');
          b.classList.toggle('selected', i < self._selectedRating);
        });
        document.getElementById('ratingLabelText').textContent = self._selectedRating
          ? self.STAR_LABELS[self._selectedRating] : 'Tap a star to rate';
      });

      btn.addEventListener('click', () => {
        self._selectedRating = val;
        starBtns.forEach((b, i) => {
          const isSelected = i < val;
          b.classList.toggle('selected', isSelected);
          b.classList.remove('hovered');
          b.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        });
        document.getElementById('ratingLabelText').textContent = self.STAR_LABELS[val];
        document.getElementById('ratingNextBtn').disabled = false;
        document.getElementById('ratingNextBtn').textContent = 'Next →';
      });
    });

    // Next button → go to step 2
    document.getElementById('ratingNextBtn').addEventListener('click', () => {
      if (!self._selectedRating) return;
      self._goToStep2();
    });

    // Back button
    document.getElementById('ratingBackBtn').addEventListener('click', () => {
      self._goToStep1();
    });

    // Submit
    document.getElementById('ratingSubmitBtn').addEventListener('click', () => {
      self._submitRating();
    });

    // Close buttons
    ['ratingCloseBtn', 'ratingCloseBtn2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', () => self._handleClose());
    });

    // Backdrop click to dismiss
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) self._handleClose();
    });

    // Remind later
    document.getElementById('ratingRemindLaterBtn').addEventListener('click', () => {
      self._handleAction('remind_later');
    });

    // Never show again
    document.getElementById('ratingNeverBtn').addEventListener('click', () => {
      if (confirm('Are you sure? We will not ask you to rate Suba again.')) {
        self._handleAction('never_show');
      }
    });

    // Done button
    document.getElementById('ratingDoneBtn').addEventListener('click', () => self._destroy());

    // Share button
    document.getElementById('ratingShareBtn').addEventListener('click', () => {
      if (navigator.share) {
        navigator.share({
          title: 'Suba — Student VTU Platform',
          text: 'I love using Suba for cheap data and airtime! Check it out:',
          url: window.location.origin
        });
      } else {
        // Fallback: copy link
        navigator.clipboard.writeText(window.location.origin).then(() => {
          if (typeof SUBAComponents !== 'undefined') {
            SUBAComponents.showToast({ title: 'Link Copied!', message: 'Share Suba with your friends.', type: 'success' });
          }
        });
      }
    });
  },

  _goToStep1() {
    document.getElementById('ratingStep1').style.display = '';
    document.getElementById('ratingStep2').style.display = 'none';
    document.getElementById('rdot1').classList.add('active');
    document.getElementById('rdot2').classList.remove('active');
  },

  _goToStep2() {
    document.getElementById('ratingStep1').style.display = 'none';
    document.getElementById('ratingStep2').style.display = '';
    document.getElementById('rdot1').classList.remove('active');
    document.getElementById('rdot2').classList.add('active');

    const isLow = this._selectedRating <= 3;
    const impSection = document.getElementById('ratingImprovementSection');
    const step2Title = document.getElementById('ratingStep2Title');
    const step2Subtitle = document.getElementById('ratingStep2Subtitle');
    const step2Icon = document.getElementById('ratingStep2Icon');
    const textFields = document.getElementById('ratingTextFields');

    if (isLow) {
      impSection.style.display = '';
      textFields.style.display = 'none';
      step2Icon.textContent = '😔';
      step2Title.textContent = 'What can we improve?';
      step2Subtitle.textContent = 'We\'re sorry your experience wasn\'t great. Your feedback goes directly to our team.';
    } else {
      impSection.style.display = 'none';
      textFields.style.display = '';
      step2Icon.textContent = '💬';
      step2Title.textContent = 'Tell us more (optional)';
      step2Subtitle.textContent = 'Add a review to help other students. What do you love about Suba?';
    }
  },

  async _submitRating() {
    const submitBtn = document.getElementById('ratingSubmitBtn');
    submitBtn.classList.add('is-loading');
    submitBtn.textContent = 'Submitting...';

    const title = (document.getElementById('ratingTitleInput')?.value || '').trim();
    const comment = (document.getElementById('ratingCommentInput')?.value || '').trim();
    const improvement = (document.getElementById('ratingImprovementInput')?.value || '').trim();
    const deviceType = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop';

    try {
      await SUBAApi.request('/ratings', {
        method: 'POST',
        body: JSON.stringify({
          rating: this._selectedRating,
          title: title || null,
          comment: comment || null,
          improvementFeedback: improvement || null,
          deviceType,
          appVersion: '1.0.0'
        })
      });

      // Log action
      await SUBAApi.request('/ratings/popup/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'rate_now' })
      }).catch(() => {});

      this._showThankYou();
    } catch (err) {
      submitBtn.classList.remove('is-loading');
      submitBtn.textContent = 'Submit Rating';
      if (typeof SUBAComponents !== 'undefined') {
        SUBAComponents.showToast({ title: 'Submission Failed', message: err.message, type: 'error' });
      }
    }
  },

  _showThankYou() {
    document.getElementById('ratingStep2').style.display = 'none';
    const step3 = document.getElementById('ratingStep3');
    step3.classList.add('visible');
    document.querySelector('.rating-progress-dots').style.display = 'none';

    const isHigh = this._selectedRating >= 4;
    document.getElementById('ratingThankyouEmoji').textContent = isHigh ? '🎉' : '🙏';
    document.getElementById('ratingThankyouTitle').textContent = isHigh ? 'We\'re glad you love Suba!' : 'Thank you for your honesty!';
    document.getElementById('ratingThankyouMsg').textContent = isHigh
      ? 'Your 5-star rating means the world to us. We\'ll keep making Suba even better!'
      : 'We\'ve received your feedback and will work hard to improve your experience.';

    // Show share prompt only for high ratings
    if (isHigh) {
      document.getElementById('ratingSharePromptWrap').style.display = '';
    }
  },

  async _handleClose() {
    await SUBAApi.request('/ratings/popup/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'remind_later' })
    }).catch(() => {});
    this._destroy();
  },

  async _handleAction(action) {
    await SUBAApi.request('/ratings/popup/action', {
      method: 'POST',
      body: JSON.stringify({ action })
    }).catch(() => {});

    if (action === 'never_show' && typeof SUBAComponents !== 'undefined') {
      SUBAComponents.showToast({ title: 'Understood', message: 'We won\'t ask you to rate Suba again.', type: 'info' });
    }
    this._destroy();
  },

  _destroy() {
    const overlay = document.getElementById('subaRatingPopupOverlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    setTimeout(() => overlay.remove(), 400);
    this._overlay = null;
  }
};

// Expose globally
window.SUBARatingPopup = SUBARatingPopup;
